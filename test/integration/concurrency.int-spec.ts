import { FakePayoutGateway } from '../support/fake-payout-gateway';
import {
  createTestApp,
  expectLedgerIntact,
  fund,
  key,
  payoutWebhook,
  TestApp,
  uniqueUser,
  VALID_IBAN,
  wallet,
} from '../support/test-app';

/**
 * The brief's key property #1/#2: "if 100 concurrent withdrawals arrive from several instances on one balance,
 * the balance never goes negative and the daily cap holds" and "the same Idempotency-Key, sequential or
 * concurrent, has exactly one effect". Two independent Nest applications (own connection pools, own workers)
 * share one PostgreSQL — exactly like two replicas behind the load balancer.
 */
describe('concurrency across two service instances (real PostgreSQL)', () => {
  let a: TestApp;
  let b: TestApp;
  const sharedPayout = new FakePayoutGateway();

  beforeAll(async () => {
    a = await createTestApp({ payout: sharedPayout });
    b = await createTestApp({ payout: sharedPayout, reset: false });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const instance = (i: number) => (i % 2 === 0 ? a : b);
  /** Both instances' dispatchers race until neither finds due work. */
  const drainDispatchers = async () => {
    while ((await Promise.all([a.dispatcher.runOnce(), b.dispatcher.runOnce()])).some(Boolean)) {
      /* keep racing */
    }
  };
  const fire = (count: number, body: (i: number) => object, k: (i: number) => string = () => key()) =>
    Promise.all(
      Array.from({ length: count }, (_, i) =>
        instance(i).http.post('/withdrawals').set('Idempotency-Key', k(i)).send(body(i)),
      ),
    );
  const tally = (responses: { status: number; body: { code?: string } }[]) =>
    responses.reduce<Record<string, number>>((acc, r) => {
      const label = r.status === 201 ? '201' : `${r.status} ${r.body.code}`;
      acc[label] = (acc[label] ?? 0) + 1;
      return acc;
    }, {});

  it('100 concurrent withdrawals on one balance: exactly the affordable ones succeed, never negative', async () => {
    const userId = uniqueUser('race');
    await fund(a, userId, '10000000'); // affords exactly 40 x 250,000
    const responses = await fire(100, () => ({
      userId,
      currency: 'IRT',
      amount: '250000',
      destination: VALID_IBAN,
    }));

    expect(tally(responses)).toEqual({ '201': 40, '422 INSUFFICIENT_FUNDS': 60 });
    expect(await wallet(a, userId)).toMatchObject({ available: '0', held: '10000000', total: '10000000' });
    const [{ n, total }] = await a.dataSource.query(
      `SELECT count(*)::int AS n, sum(amount)::text AS total FROM withdrawals WHERE user_id = $1`,
      [userId],
    );
    expect({ n, total }).toEqual({ n: 40, total: '10000000' });
    await expectLedgerIntact(a);
  });

  it('100 concurrent withdrawals with plenty of money: the 200M Toman daily cap is never exceeded', async () => {
    const userId = uniqueUser('cap');
    await fund(a, userId, '1000000000');
    const responses = await fire(100, () => ({
      userId,
      currency: 'IRT',
      amount: '3000000',
      destination: VALID_IBAN,
    }));

    expect(tally(responses)).toEqual({ '201': 66, '422 DAILY_LIMIT_EXCEEDED': 34 }); // 66 x 3M = 198M <= 200M
    const [usage] = await a.dataSource.query(
      `SELECT used_irt FROM withdrawal_daily_usage WHERE user_id = $1`,
      [userId],
    );
    expect(usage.used_irt).toBe('198000000');
    expect(await wallet(a, userId)).toMatchObject({ available: '802000000', held: '198000000' });
  });

  it('random amounts racing against both the balance and the cap keep every invariant', async () => {
    const userId = uniqueUser('mix');
    await fund(a, userId, '150000000');
    const amounts = Array.from({ length: 100 }, (_, i) => 100_000 + ((i * 7919) % 50) * 100_000); // 0.1M .. 5M
    const responses = await fire(100, (i) => ({
      userId,
      currency: 'IRT',
      amount: String(amounts[i]),
      destination: VALID_IBAN,
    }));
    const accepted = responses
      .map((r, i) => (r.status === 201 ? BigInt(amounts[i]) : 0n))
      .reduce((s, v) => s + v, 0n);
    expect(accepted).toBeLessThanOrEqual(150_000_000n);
    expect(responses.every((r) => [201, 422].includes(r.status))).toBe(true);
    const w = await wallet(a, userId);
    expect(BigInt(w.available) + BigInt(w.held)).toBe(150_000_000n);
    expect(BigInt(w.held)).toBe(accepted);
    expect(BigInt(w.available)).toBeGreaterThanOrEqual(0n);
    await expectLedgerIntact(a);
  });

  it('the same Idempotency-Key sent 40 times concurrently to both instances creates one withdrawal', async () => {
    const userId = uniqueUser('idem');
    await fund(a, userId, '5000000');
    const k = key();
    const responses = await fire(
      40,
      () => ({ userId, currency: 'IRT', amount: '1000000', destination: VALID_IBAN }),
      () => k,
    );
    expect(tally(responses)).toEqual({ '201': 40 });
    expect(new Set(responses.map((r) => (r.body as { withdrawalId: string }).withdrawalId)).size).toBe(1);
    expect(await wallet(b, userId)).toMatchObject({ available: '4000000', held: '1000000' });
  });

  it('opposite transfers A->B and B->A at the same time: no deadlock, money conserved', async () => {
    const x = uniqueUser('x');
    const y = uniqueUser('y');
    await fund(a, x, '1000000');
    await fund(a, y, '1000000');
    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, i) =>
        instance(i)
          .http.post('/transfers')
          .set('Idempotency-Key', key())
          .send(
            i % 2 === 0
              ? { fromUserId: x, toUserId: y, currency: 'IRT', amount: '10000' }
              : { fromUserId: y, toUserId: x, currency: 'IRT', amount: '10000' },
          ),
      ),
    );
    expect(responses.every((r) => r.status === 201)).toBe(true);
    const [wx, wy] = [await wallet(a, x), await wallet(a, y)];
    expect(BigInt(wx.available) + BigInt(wy.available)).toBe(2_000_000n);
    expect(wx.available).toBe('1000000');
  });

  it('two dispatchers racing over the same pending withdrawals submit each exactly once', async () => {
    const userId = uniqueUser('disp');
    await fund(a, userId, '100000000');
    const created = await fire(30, () => ({
      userId,
      currency: 'IRT',
      amount: '100000',
      destination: VALID_IBAN,
    }));
    const ids = created.map((r) => (r.body as { withdrawalId: string }).withdrawalId);
    await drainDispatchers();
    for (const id of ids) expect(sharedPayout.creations.get(id)).toBe(1);
    expect(sharedPayout.submits.filter((s) => ids.includes(s.requestId))).toHaveLength(30);
  });

  it('a burst of duplicate webhooks on both instances plus pollers settles a withdrawal exactly once', async () => {
    const userId = uniqueUser('wh');
    await fund(a, userId, '1000000');
    const res = await a.http
      .post('/withdrawals')
      .set('Idempotency-Key', key())
      .send({ userId, currency: 'IRT', amount: '500000', destination: VALID_IBAN })
      .expect(201);
    const id = res.body.withdrawalId;
    await drainDispatchers();
    sharedPayout.complete(id, 'SUCCEEDED');
    await a.dataSource.query(`UPDATE withdrawals SET next_attempt_at = now() WHERE id = $1`, [id]);
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        payoutWebhook(instance(i), { requestId: id, status: 'SUCCEEDED' }),
      ),
      a.dispatcher.runOnce(),
      b.dispatcher.runOnce(),
    ]);
    const [{ n }] = await a.dataSource.query(
      `SELECT count(*)::int AS n FROM ledger_journals WHERE reference_id = $1 AND type = 'WITHDRAWAL_SETTLE'`,
      [id],
    );
    expect(n).toBe(1);
    expect(await wallet(a, userId)).toMatchObject({ available: '500000', held: '0' });
    await expectLedgerIntact(a);
  });
});
