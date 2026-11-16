import { decodeCursor } from '../../src/common/util/cursor';
import { createTestApp, expectLedgerIntact, fund, key, TestApp, uniqueUser, wallet } from '../support/test-app';

describe('wallets, ledger history, transfers and adjustments (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  describe('GET /wallets/:userId', () => {
    it('returns zero balances for a user who never transacted (no registration needed) without creating rows', async () => {
      const userId = uniqueUser();
      const res = await t.http.get(`/wallets/${userId}`).expect(200);
      expect(res.body).toEqual({
        userId,
        balances: [
          { currency: 'IRT', available: '0', held: '0', total: '0', debt: '0' },
          { currency: 'USDT', available: '0', held: '0', total: '0', debt: '0' },
        ],
      });
      const [{ n }] = await t.dataSource.query(`SELECT count(*)::int AS n FROM ledger_accounts WHERE owner_user_id = $1`, [userId]);
      expect(n).toBe(0);
    });

    it('rejects malformed user ids', async () => {
      expect((await t.http.get('/wallets/bad%20id').expect(400)).body.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /wallets/:userId/ledger', () => {
    it('pages newest-first with an opaque cursor and no gaps or duplicates', async () => {
      const userId = uniqueUser();
      for (let i = 1; i <= 25; i++) await fund(t, userId, String(i));
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res: { body: { items: { amount: string }[]; nextCursor: string | null } } = await t.http
          .get(`/wallets/${userId}/ledger`)
          .query({ limit: 10, ...(cursor ? { cursor } : {}) })
          .expect(200);
        seen.push(...res.body.items.map((i: { amount: string }) => i.amount));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => String(25 - i)));
    });

    it('returns rich items and supports a currency filter', async () => {
      const userId = uniqueUser();
      await fund(t, userId, '100');
      await fund(t, userId, '2.5', 'USDT');
      const usdt = await t.http.get(`/wallets/${userId}/ledger`).query({ currency: 'usdt' }).expect(200);
      expect(usdt.body.items).toHaveLength(1);
      expect(usdt.body.items[0]).toMatchObject({
        type: 'ADJUSTMENT',
        currency: 'USDT',
        account: 'AVAILABLE',
        direction: 'CREDIT',
        amount: '2.5',
        balanceAfter: '2.5',
        referenceType: 'adjustment',
        description: 'test funding',
      });
      expect(usdt.body.nextCursor).toBeNull();
    });

    it.each([
      [{ limit: 0 }, 'limit'],
      [{ limit: 201 }, 'limit'],
      [{ limit: 'abc' }, 'limit'],
      [{ cursor: 'not-a-cursor' }, 'cursor'],
      [{ currency: 'EUR' }, 'currency'],
    ])('rejects %o', async (query, field) => {
      const res = await t.http.get(`/wallets/${uniqueUser()}/ledger`).query(query).expect(400);
      expect(res.body.message).toContain(field);
    });

    it('stays an index range scan for a user with a very large history (300k entries)', async () => {
      const userId = uniqueUser('whale');
      await fund(t, userId, '1');
      // Bulk-load a realistic, *balanced* history directly: 300k user credits each paired with an ops debit,
      // in one journal, and the materialised balance moved accordingly (per-row triggers are switched off for
      // this seeding step only — they would make the load O(n^2)). The ledger stays fully consistent.
      await t.dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL session_replication_role = replica`);
        const [{ id: journalId }] = await m.query(
          `INSERT INTO ledger_journals (type, idempotency_ref, reference_type, reference_id)
           VALUES ('ADJUSTMENT', $1, 'test', $2) RETURNING id`,
          [`bulk:${userId}`, userId],
        );
        await m.query(
          `INSERT INTO ledger_entries (journal_id, account_id, currency, owner_user_id, direction, amount, balance_after)
           SELECT $2::bigint, a.id, 'IRT', $1, 'CREDIT', 1, g + 1
             FROM generate_series(1, 300000) AS g,
                  (SELECT id FROM ledger_accounts WHERE owner_user_id = $1 AND kind = 'USER_AVAILABLE' AND currency = 'IRT') a
           UNION ALL
           SELECT $2::bigint, s.id, 'IRT', NULL, 'DEBIT', 300000, NULL
             FROM (SELECT id FROM ledger_accounts WHERE owner_user_id IS NULL AND kind = 'OPS_ADJUSTMENTS' AND currency = 'IRT') s`,
          [userId, journalId],
        );
        await m.query(
          `UPDATE ledger_accounts SET balance = balance + 300000 WHERE owner_user_id = $1 AND kind = 'USER_AVAILABLE'`,
          [userId],
        );
      });
      await t.dataSource.query(`ANALYZE ledger_entries`);

      const first = await t.http.get(`/wallets/${userId}/ledger`).query({ limit: 50 }).expect(200);
      const deepCursorId = String(Number(decodeCursor(first.body.nextCursor)) - 250000);
      const plan: { 'QUERY PLAN': string }[] = await t.dataSource.query(
        `EXPLAIN SELECT e.id FROM ledger_entries e WHERE e.owner_user_id = $1 AND e.id < $2 ORDER BY e.id DESC LIMIT 51`,
        [userId, deepCursorId],
      );
      // Index-driven top-N: no sequential scan and no sort, whatever the depth of the cursor. (With one user
      // owning almost the whole table the planner may walk the PK backwards instead of the owner index —
      // both are O(limit) here.)
      const planText = plan.map((p) => p['QUERY PLAN']).join('\n');
      expect(planText).toMatch(/Index (Only )?Scan/);
      expect(planText).not.toMatch(/Seq Scan|Sort/);

      const started = Date.now();
      const deep = await t.http
        .get(`/wallets/${userId}/ledger`)
        .query({ limit: 50, cursor: Buffer.from(`le:${deepCursorId}`).toString('base64url') })
        .expect(200);
      expect(deep.body.items).toHaveLength(50);
      expect(Date.now() - started).toBeLessThan(500);
    });
  });

  describe('POST /transfers', () => {
    it('moves money atomically between two users (receiver wallet created on first use)', async () => {
      const [from, to] = [uniqueUser(), uniqueUser()];
      await fund(t, from, '1000000');
      const res = await t.http
        .post('/transfers')
        .set('Idempotency-Key', key())
        .send({ fromUserId: from, toUserId: to, currency: 'IRT', amount: '400000' })
        .expect(201);
      expect(res.body).toMatchObject({ transferId: expect.any(String), status: 'SUCCEEDED', amount: '400000' });
      expect((await wallet(t, from)).available).toBe('600000');
      expect((await wallet(t, to)).available).toBe('400000');
    });

    it('works for USDT with 6 decimals', async () => {
      const [from, to] = [uniqueUser(), uniqueUser()];
      await fund(t, from, '10', 'USDT');
      await t.http
        .post('/transfers')
        .set('Idempotency-Key', key())
        .send({ fromUserId: from, toUserId: to, currency: 'USDT', amount: '0.000001' })
        .expect(201);
      expect((await wallet(t, from, 'USDT')).available).toBe('9.999999');
      expect((await wallet(t, to, 'USDT')).available).toBe('0.000001');
    });

    it('refuses insufficient funds, self-transfers and bad amounts', async () => {
      const [from, to] = [uniqueUser(), uniqueUser()];
      await fund(t, from, '100');
      const post = (body: object) => t.http.post('/transfers').set('Idempotency-Key', key()).send(body);
      expect((await post({ fromUserId: from, toUserId: to, currency: 'IRT', amount: '101' }).expect(422)).body.code).toBe(
        'INSUFFICIENT_FUNDS',
      );
      await post({ fromUserId: from, toUserId: from, currency: 'IRT', amount: '1' }).expect(400);
      await post({ fromUserId: from, toUserId: to, currency: 'IRT', amount: '0' }).expect(400);
      await post({ fromUserId: from, toUserId: to, currency: 'USDT', amount: '1.0000001' }).expect(400);
      expect((await wallet(t, from)).available).toBe('100');
      expect((await wallet(t, to)).available).toBe('0');
    });
  });

  describe('POST /internal/adjustments', () => {
    it('increases a balance with a mandatory reason, as a double-entry journal against the ops expense account', async () => {
      const userId = uniqueUser();
      const res = await t.http
        .post('/internal/adjustments')
        .set('Idempotency-Key', key())
        .send({ userId, currency: 'IRT', amount: '75000', reason: 'compensation INC-7', operator: 'ops.sara' })
        .expect(201);
      expect(res.body).toMatchObject({ adjustmentId: expect.any(String), amount: '75000', operator: 'ops.sara' });
      const lines = await t.dataSource.query(
        `SELECT a.kind, e.direction, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE e.journal_id = $1 ORDER BY a.kind`,
        [res.body.journalId],
      );
      expect(lines).toEqual([
        { kind: 'OPS_ADJUSTMENTS', direction: 'DEBIT', amount: '75000' },
        { kind: 'USER_AVAILABLE', direction: 'CREDIT', amount: '75000' },
      ]);
    });

    it.each([
      [{ reason: '' }, 'reason'],
      [{ reason: '   ' }, 'reason'],
      [{ amount: '-1' }, 'amount'],
      [{ amount: '0' }, 'amount'],
      [{ currency: 'BTC' }, 'currency'],
    ])('rejects %o', async (override, field) => {
      const res = await t.http
        .post('/internal/adjustments')
        .set('Idempotency-Key', key())
        .send({ userId: uniqueUser(), currency: 'IRT', amount: '1000', reason: 'ok', ...override })
        .expect(400);
      expect(res.body.message).toContain(field);
    });

    it('corrects a mistaken adjustment with a reversal journal, but never below zero', async () => {
      const userId = uniqueUser();
      const adj = await t.http
        .post('/internal/adjustments')
        .set('Idempotency-Key', key())
        .send({ userId, currency: 'IRT', amount: '50000', reason: 'oops, wrong user' })
        .expect(201);
      const reversed = await t.http
        .post(`/internal/adjustments/${adj.body.adjustmentId}/reverse`)
        .set('Idempotency-Key', key())
        .send({ reason: 'credited the wrong user' })
        .expect(201);
      expect(reversed.body.reversalJournalId).toEqual(expect.any(String));
      expect((await wallet(t, userId)).available).toBe('0');
      const again = await t.http
        .post(`/internal/adjustments/${adj.body.adjustmentId}/reverse`)
        .set('Idempotency-Key', key())
        .send({ reason: 'again' })
        .expect(409);
      expect(again.body.code).toBe('ALREADY_REVERSED');

      const spent = uniqueUser();
      const adj2 = await t.http
        .post('/internal/adjustments')
        .set('Idempotency-Key', key())
        .send({ userId: spent, currency: 'IRT', amount: '50000', reason: 'x' })
        .expect(201);
      await t.http
        .post('/transfers')
        .set('Idempotency-Key', key())
        .send({ fromUserId: spent, toUserId: uniqueUser(), currency: 'IRT', amount: '50000' })
        .expect(201);
      const blocked = await t.http
        .post(`/internal/adjustments/${adj2.body.adjustmentId}/reverse`)
        .set('Idempotency-Key', key())
        .send({ reason: 'too late' })
        .expect(422);
      expect(blocked.body.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('requires the internal API key when one is configured', async () => {
      const secured = await createTestApp({ env: { INTERNAL_API_KEY: 'ops-secret' }, reset: false });
      try {
        const body = { userId: uniqueUser(), currency: 'IRT', amount: '1', reason: 'x' };
        await secured.http.post('/internal/adjustments').set('Idempotency-Key', key()).send(body).expect(401);
        await secured.http
          .post('/internal/adjustments')
          .set('Idempotency-Key', key())
          .set('X-Internal-Api-Key', 'wrong')
          .send(body)
          .expect(401);
        await secured.http
          .post('/internal/adjustments')
          .set('Idempotency-Key', key())
          .set('X-Internal-Api-Key', 'ops-secret')
          .send(body)
          .expect(201);
      } finally {
        await secured.close();
        process.env.INTERNAL_API_KEY = '';
      }
    });
  });

  it('keeps the ledger consistent', async () => {
    await expectLedgerIntact(t);
  });
});
