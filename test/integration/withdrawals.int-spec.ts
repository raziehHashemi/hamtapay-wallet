import {
  createTestApp,
  expectLedgerIntact,
  fund,
  key,
  payoutWebhook,
  runDispatcher,
  TestApp,
  uniqueUser,
  VALID_IBAN,
  VALID_TRC20,
  wallet,
  withdraw,
} from '../support/test-app';

describe('withdrawals (real PostgreSQL, fake payout provider with the simulator behaviours)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  const get = async (id: string) => (await t.http.get(`/withdrawals/${id}`).expect(200)).body;
  async function fundedWithdrawal(amount = '250000', fundAmount = '1000000') {
    const userId = uniqueUser();
    await fund(t, userId, fundAmount);
    const res = await withdraw(t, userId, amount).expect(201);
    return { userId, id: res.body.withdrawalId as string, body: res.body };
  }

  describe('validation and business rules', () => {
    it.each([
      [{ destination: 'IR820540102680020817909003' }, 400, 'INVALID_DESTINATION'],
      [{ destination: VALID_TRC20 }, 400, 'INVALID_DESTINATION'],
      [{ currency: 'USDT', destination: VALID_IBAN, amount: '20' }, 400, 'INVALID_DESTINATION'],
      [{ amount: '99999' }, 422, 'BELOW_MINIMUM'],
      [{ amount: '0' }, 422, 'BELOW_MINIMUM'],
      [{ currency: 'USDT', destination: VALID_TRC20, amount: '9.999999' }, 422, 'BELOW_MINIMUM'],
      [{ amount: 100000 }, 400, 'VALIDATION_ERROR'],
      [{ amount: '100000.5' }, 400, 'VALIDATION_ERROR'],
      [{ currency: 'EUR' }, 400, 'VALIDATION_ERROR'],
    ])('%o -> %i %s', async (override, httpStatus, code) => {
      const userId = uniqueUser();
      await fund(t, userId, '1000000');
      const res = await t.http
        .post('/withdrawals')
        .set('Idempotency-Key', key())
        .send({ userId, currency: 'IRT', amount: '100000', destination: VALID_IBAN, ...override })
        .expect(httpStatus);
      expect(res.body).toEqual({ code, message: expect.any(String) });
    });

    it('INSUFFICIENT_FUNDS when the available balance is not enough', async () => {
      const userId = uniqueUser();
      await fund(t, userId, '150000');
      expect((await withdraw(t, userId, '150001').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('holds the money immediately: available drops, held rises, the same money cannot be spent twice', async () => {
      const { userId } = await fundedWithdrawal('600000', '1000000');
      expect(await wallet(t, userId)).toMatchObject({ available: '400000', held: '600000', total: '1000000' });
      expect((await withdraw(t, userId, '500000').expect(422)).body.code).toBe('INSUFFICIENT_FUNDS');
      const transfer = await t.http
        .post('/transfers')
        .set('Idempotency-Key', key())
        .send({ fromUserId: userId, toUserId: uniqueUser(), currency: 'IRT', amount: '500000' })
        .expect(422);
      expect(transfer.body.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('enforces the 200M Toman daily cap and gives the cap back when a withdrawal fails', async () => {
      const userId = uniqueUser();
      await fund(t, userId, '400000000');
      const first = await withdraw(t, userId, '150000000').expect(201);
      expect((await withdraw(t, userId, '60000000').expect(422)).body.code).toBe('DAILY_LIMIT_EXCEEDED');
      await withdraw(t, userId, '50000000').expect(201); // exactly 200M
      expect((await withdraw(t, userId, '100000').expect(422)).body.code).toBe('DAILY_LIMIT_EXCEEDED');

      await runDispatcher(t);
      await payoutWebhook(t, { requestId: first.body.withdrawalId, status: 'FAILED', reason: 'BANK_REJECTED' }).expect(200);
      await withdraw(t, userId, '150000000').expect(201); // the failed 150M no longer counts
    });

    it('USDT: 1 USDT fee on top, provider receives the amount only, cap counted in Toman at the configured rate', async () => {
      const userId = uniqueUser();
      await fund(t, userId, '100', 'USDT');
      const res = await t.http
        .post('/withdrawals')
        .set('Idempotency-Key', key())
        .send({ userId, currency: 'USDT', amount: '12.5', destination: VALID_TRC20 })
        .expect(201);
      expect(res.body).toMatchObject({ amount: '12.5', fee: '1', status: 'PENDING' });
      expect(await wallet(t, userId, 'USDT')).toMatchObject({ available: '86.5', held: '13.5' });
      const [usage] = await t.dataSource.query(`SELECT used_irt FROM withdrawal_daily_usage WHERE user_id = $1`, [userId]);
      expect(usage.used_irt).toBe('1250000'); // 12.5 * 100,000

      await runDispatcher(t);
      expect(t.payout.submits.at(-1)).toMatchObject({ type: 'CRYPTO', currency: 'USDT', amount: '12.5', destination: VALID_TRC20 });
      await payoutWebhook(t, { requestId: res.body.withdrawalId, status: 'SUCCEEDED' }).expect(200);
      expect(await wallet(t, userId, 'USDT')).toMatchObject({ available: '86.5', held: '0' });
      const [fee] = await t.dataSource.query(
        `SELECT e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          JOIN ledger_journals j ON j.id = e.journal_id
         WHERE a.kind = 'FEE_REVENUE' AND j.reference_id = $1`,
        [res.body.withdrawalId],
      );
      expect(fee.amount).toBe('1000000');
    });
  });

  describe('provider interaction', () => {
    it('happy path: dispatched as IBAN/IRR (x10), signed webhook settles it', async () => {
      const { userId, id } = await fundedWithdrawal('250000');
      await runDispatcher(t);
      expect(t.payout.submits.at(-1)).toEqual({
        requestId: id,
        type: 'IBAN',
        destination: VALID_IBAN,
        amount: '2500000',
        currency: 'IRR',
      });
      expect((await get(id)).status).toBe('PROCESSING');
      await payoutWebhook(t, { requestId: id, status: 'PROCESSING' }).expect(200);
      await payoutWebhook(t, { requestId: id, status: 'SUCCEEDED', trackingId: 'TRK-1' }).expect(200);
      expect(await get(id)).toMatchObject({ status: 'SUCCEEDED' });
      expect(await wallet(t, userId)).toMatchObject({ available: '750000', held: '0', total: '750000' });
    });

    it('polling resolves a withdrawal whose final webhook never arrives', async () => {
      const { id } = await fundedWithdrawal();
      await runDispatcher(t);
      t.payout.complete(id, 'SUCCEEDED');
      await runDispatcher(t);
      expect((await get(id)).status).toBe('SUCCEEDED');
    });

    it('rejects a webhook with a bad signature (401) and changes nothing', async () => {
      const { id } = await fundedWithdrawal();
      await runDispatcher(t);
      const res = await payoutWebhook(t, { requestId: id, status: 'FAILED' }, { signature: 'ab'.repeat(32) }).expect(401);
      expect(res.body.code).toBe('INVALID_SIGNATURE');
      await payoutWebhook(t, { requestId: id, status: 'FAILED' }, { secret: 'wrong-secret' }).expect(401);
      expect((await get(id)).status).toBe('PROCESSING');
    });

    it('stale PROCESSING / duplicate SUCCEEDED webhooks after the final state are no-ops', async () => {
      const { userId, id } = await fundedWithdrawal();
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: id, status: 'SUCCEEDED' }).expect(200);
      const stale = await payoutWebhook(t, { requestId: id, status: 'PROCESSING' }).expect(200);
      expect(stale.body.applied).toBe('NOOP');
      await Promise.all(Array.from({ length: 5 }, () => payoutWebhook(t, { requestId: id, status: 'SUCCEEDED' })));
      expect((await get(id)).status).toBe('SUCCEEDED');
      expect((await wallet(t, userId)).available).toBe('750000');
      const [{ n }] = await t.dataSource.query(
        `SELECT count(*)::int AS n FROM ledger_journals WHERE reference_id = $1 AND type = 'WITHDRAWAL_SETTLE'`,
        [id],
      );
      expect(n).toBe(1);
    });

    it('FAILED from the provider releases the hold', async () => {
      const { userId, id } = await fundedWithdrawal();
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: id, status: 'FAILED', reason: 'BANK_REJECTED' }).expect(200);
      expect(await get(id)).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_FAILED:BANK_REJECTED' });
      expect(await wallet(t, userId)).toMatchObject({ available: '1000000', held: '0' });
    });

    it('RETURNED after SUCCEEDED gives the money back (Paya bounce)', async () => {
      const { userId, id } = await fundedWithdrawal();
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: id, status: 'SUCCEEDED' }).expect(200);
      expect((await wallet(t, userId)).total).toBe('750000');
      await payoutWebhook(t, { requestId: id, status: 'RETURNED', reason: 'ACCOUNT_CLOSED' }).expect(200);
      expect(await get(id)).toMatchObject({ status: 'FAILED', failureReason: 'RETURNED:ACCOUNT_CLOSED' });
      expect(await wallet(t, userId)).toMatchObject({ available: '1000000', held: '0' });
    });

    it('RETURNED as the first final signal (SUCCEEDED webhook lost): settles then refunds', async () => {
      const { userId, id } = await fundedWithdrawal();
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: id, status: 'RETURNED', reason: 'ACCOUNT_CLOSED' }).expect(200);
      expect((await get(id)).status).toBe('FAILED');
      expect(await wallet(t, userId)).toMatchObject({ available: '1000000', held: '0' });
      const types = await t.dataSource.query(`SELECT type FROM ledger_journals WHERE reference_id = $1 ORDER BY id`, [id]);
      expect(types.map((r: { type: string }) => r.type)).toEqual(['WITHDRAWAL_HOLD', 'WITHDRAWAL_SETTLE', 'WITHDRAWAL_RETURN']);
    });

    it('watches successful IBAN withdrawals and catches a RETURNED by polling', async () => {
      const { userId, id } = await fundedWithdrawal();
      await runDispatcher(t);
      t.payout.complete(id, 'SUCCEEDED');
      await runDispatcher(t); // poll -> SUCCEEDED, stays scheduled for the return watch
      expect((await get(id)).status).toBe('SUCCEEDED');
      t.payout.complete(id, 'RETURNED', 'ACCOUNT_CLOSED');
      await runDispatcher(t);
      expect((await get(id)).status).toBe('FAILED');
      expect((await wallet(t, userId)).available).toBe('1000000');
    });

    it('a 4xx rejection at submit (transfer not created) fails it and releases the funds', async () => {
      const { userId, id } = await fundedWithdrawal();
      t.payout.queue('reject');
      await runDispatcher(t);
      expect((await get(id)).failureReason).toMatch(/^PROVIDER_REJECTED/);
      expect((await wallet(t, userId)).available).toBe('1000000');
    });
  });

  describe('unknown outcomes never cause a double payout', () => {
    it.each(['e503-before', 'e503-after', 'timeout'] as const)(
      '%s: retried with the same requestId, exactly one transfer is created',
      async (behaviour) => {
        const { id } = await fundedWithdrawal();
        t.payout.queue(behaviour);
        await runDispatcher(t); // outcome unknown
        expect((await get(id)).status).toBe('PROCESSING');
        await runDispatcher(t); // re-submit, same requestId
        await runDispatcher(t);
        expect(t.payout.creations.get(id)).toBe(1);
        t.payout.complete(id, 'SUCCEEDED');
        if (behaviour !== 'e503-before') t.payout.unhide(id); // the provider's ~90s hidden window has passed
        await runDispatcher(t);
        expect((await get(id)).status).toBe('SUCCEEDED');
      },
    );

    it('after the provider acknowledged a transfer, a 404 on GET (hidden window) is waited out, never re-submitted', async () => {
      const { id } = await fundedWithdrawal();
      t.payout.queue('e503-after');
      await runDispatcher(t);
      await runDispatcher(t); // re-submit returns the existing transfer -> acknowledged
      const submitsBefore = t.payout.submits.length;
      await runDispatcher(t); // GET -> 404 (hidden)
      await runDispatcher(t);
      expect(t.payout.submits.length).toBe(submitsBefore);
      expect((await get(id)).status).toBe('PROCESSING');
      t.payout.unhide(id);
      t.payout.complete(id, 'SUCCEEDED');
      await runDispatcher(t);
      expect((await get(id)).status).toBe('SUCCEEDED');
    });

    it('crash right after marking PROCESSING (before any HTTP call): recovered and sent once', async () => {
      const { id } = await fundedWithdrawal();
      // what the dispatcher commits before calling the provider; then the process dies
      await t.dataSource.query(
        `UPDATE withdrawals SET status = 'PROCESSING', submitted_at = now(), attempts = 1, next_attempt_at = now() WHERE id = $1`,
        [id],
      );
      await t.dispatcher.runOnce(); // another instance picks it up after the lease
      expect(t.payout.creations.get(id)).toBe(1);
    });

    it('crash after the provider created the transfer but before we recorded the answer: no duplicate', async () => {
      const { id } = await fundedWithdrawal();
      await t.dataSource.query(`UPDATE withdrawals SET status = 'PROCESSING', submitted_at = now() WHERE id = $1`, [id]);
      await t.payout.submit({ requestId: id, type: 'IBAN', destination: VALID_IBAN, amount: '2500000', currency: 'IRR' });
      await runDispatcher(t);
      await runDispatcher(t);
      expect(t.payout.creations.get(id)).toBe(1);
    });

    it('silence is never treated as failure: funds stay held and the withdrawal is flagged for review', async () => {
      const review = await createTestApp({ env: { WITHDRAWAL_REVIEW_AFTER_MS: '0' } });
      try {
        const userId = uniqueUser();
        await fund(review, userId, '1000000');
        const res = await withdraw(review, userId, '300000').expect(201);
        review.payout.unknownForever = true;
        for (let i = 0; i < 5; i++) await runDispatcher(review);
        const [row] = await review.dataSource.query(`SELECT status, needs_review, anomaly FROM withdrawals WHERE id = $1`, [
          res.body.withdrawalId,
        ]);
        expect(row).toMatchObject({ status: 'PROCESSING', needs_review: true });
        expect(await wallet(review, userId)).toMatchObject({ held: '300000' });
        const queue = await review.http.get('/internal/withdrawals/review').expect(200);
        expect(queue.body.map((w: { withdrawalId: string }) => w.withdrawalId)).toContain(res.body.withdrawalId);
      } finally {
        await review.close();
      }
    });
  });

  describe('cancellation (ambiguity #3)', () => {
    it('is allowed while PENDING and releases funds and the cap', async () => {
      const { userId, id } = await fundedWithdrawal('400000');
      const k = key();
      const res = await t.http.post(`/withdrawals/${id}/cancel`).set('Idempotency-Key', k).send({}).expect(200);
      expect(res.body).toMatchObject({ status: 'FAILED', failureReason: 'CANCELLED_BY_USER' });
      expect(await wallet(t, userId)).toMatchObject({ available: '1000000', held: '0' });
      const replay = await t.http.post(`/withdrawals/${id}/cancel`).set('Idempotency-Key', k).send({}).expect(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      await runDispatcher(t);
      expect(t.payout.submits.some((s) => s.requestId === id)).toBe(false);
    });

    it('is refused once the withdrawal was handed to the provider', async () => {
      const { id } = await fundedWithdrawal();
      await runDispatcher(t);
      const res = await t.http.post(`/withdrawals/${id}/cancel`).set('Idempotency-Key', key()).send({}).expect(409);
      expect(res.body.code).toBe('WITHDRAWAL_NOT_CANCELLABLE');
    });

    it('checks the owner when a userId is given', async () => {
      const { id } = await fundedWithdrawal();
      await t.http.post(`/withdrawals/${id}/cancel`).set('Idempotency-Key', key()).send({ userId: 'someone-else' }).expect(404);
    });
  });

  describe('late success after failure (ambiguity #1)', () => {
    it('records the truth, never lets the balance go negative, books the shortfall as debt and blocks the user', async () => {
      const userId = uniqueUser();
      await fund(t, userId, '1000000');
      const first = (await withdraw(t, userId, '1000000').expect(201)).body.withdrawalId;
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: first, status: 'FAILED', reason: 'BANK_REJECTED' }).expect(200);
      expect((await wallet(t, userId)).available).toBe('1000000');

      // the user withdraws the same money again; it succeeds
      const second = (await withdraw(t, userId, '800000').expect(201)).body.withdrawalId;
      await runDispatcher(t);
      await payoutWebhook(t, { requestId: second, status: 'SUCCEEDED' }).expect(200);
      expect((await wallet(t, userId)).available).toBe('200000');

      // ...and now the provider says the FIRST one was paid as well
      const late = await payoutWebhook(t, { requestId: first, status: 'SUCCEEDED' }).expect(200);
      expect(late.body.applied).toBe('LATE_SUCCESS');
      expect((await get(first)).status).toBe('SUCCEEDED');
      expect(await wallet(t, userId)).toMatchObject({ available: '0', held: '0', debt: '800000' });
      const [row] = await t.dataSource.query(`SELECT needs_review, anomaly FROM withdrawals WHERE id = $1`, [first]);
      expect(row.needs_review).toBe(true);
      expect(row.anomaly).toContain('LATE_SUCCESS_AFTER_FAILURE');

      await fund(t, userId, '5000000');
      expect((await withdraw(t, userId, '100000').expect(422)).body.code).toBe('ACCOUNT_RESTRICTED');
      const [{ n }] = await t.dataSource.query(
        `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'withdrawal.late_success' AND aggregate_id = $1`,
        [first],
      );
      expect(n).toBe(1);
    });
  });

  it('keeps the ledger consistent after all of the above', async () => {
    await expectLedgerIntact(t);
  });
});
