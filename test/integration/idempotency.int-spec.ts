import { createTestApp, fund, key, TestApp, uniqueUser, VALID_IBAN, wallet, withdraw } from '../support/test-app';

describe('Idempotency-Key (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  it('is required on money-moving POSTs', async () => {
    const res = await t.http
      .post('/withdrawals')
      .send({ userId: uniqueUser(), currency: 'IRT', amount: '100000', destination: VALID_IBAN })
      .expect(400);
    expect(res.body).toEqual({ code: 'IDEMPOTENCY_KEY_MISSING', message: expect.any(String) });
  });

  it('replays the stored response for a sequential retry; the effect happens once', async () => {
    const user = uniqueUser();
    const k = key();
    const body = { userId: user, currency: 'IRT', amount: '300000', reason: 'retry test' };
    const first = await t.http.post('/internal/adjustments').set('Idempotency-Key', k).send(body).expect(201);
    const second = await t.http.post('/internal/adjustments').set('Idempotency-Key', k).send(body).expect(201);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect((await wallet(t, user)).available).toBe('300000');
  });

  it('treats a logically equal body (different key order) as the same request', async () => {
    const user = uniqueUser();
    const k = key();
    await t.http.post('/internal/adjustments').set('Idempotency-Key', k)
      .send({ userId: user, currency: 'IRT', amount: '1', reason: 'r' }).expect(201);
    await t.http.post('/internal/adjustments').set('Idempotency-Key', k)
      .send({ reason: 'r', amount: '1', currency: 'IRT', userId: user }).expect(201);
    expect((await wallet(t, user)).available).toBe('1');
  });

  it('rejects the same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    const user = uniqueUser();
    const k = key();
    await t.http.post('/internal/adjustments').set('Idempotency-Key', k)
      .send({ userId: user, currency: 'IRT', amount: '100', reason: 'a' }).expect(201);
    const res = await t.http.post('/internal/adjustments').set('Idempotency-Key', k)
      .send({ userId: user, currency: 'IRT', amount: '999', reason: 'a' }).expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await wallet(t, user)).available).toBe('100');
  });

  it('50 concurrent requests with the same key: exactly one effect, every caller gets the same answer', async () => {
    const user = uniqueUser();
    await fund(t, user, '10000000');
    const k = key();
    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        t.http
          .post('/withdrawals')
          .set('Idempotency-Key', k)
          .send({ userId: user, currency: 'IRT', amount: '250000', destination: VALID_IBAN }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    expect(new Set(responses.map((r) => r.body.withdrawalId)).size).toBe(1);
    const [{ n }] = await t.dataSource.query(`SELECT count(*)::int AS n FROM withdrawals WHERE user_id = $1`, [user]);
    expect(n).toBe(1);
    expect(await wallet(t, user)).toMatchObject({ available: '9750000', held: '250000' });
  });

  it('stores business errors: a retry gets the same 422 even if the balance changed meanwhile', async () => {
    const user = uniqueUser();
    const k = key();
    const first = await withdraw(t, user, '500000', { key: k }).expect(422);
    expect(first.body.code).toBe('INSUFFICIENT_FUNDS');
    await fund(t, user, '1000000');
    const retry = await withdraw(t, user, '500000', { key: k }).expect(422);
    expect(retry.body).toEqual(first.body);
    expect((await wallet(t, user)).available).toBe('1000000');
  });

  it('does not store transient gateway failures: the same key can be retried', async () => {
    const user = uniqueUser();
    const k = key();
    t.psp.createFails = true;
    const failed = await t.http.post('/deposits').set('Idempotency-Key', k).send({ userId: user, amount: '50000' }).expect(502);
    expect(failed.body.code).toBe('GATEWAY_UNAVAILABLE');
    t.psp.createFails = false;
    const ok = await t.http.post('/deposits').set('Idempotency-Key', k).send({ userId: user, amount: '50000' }).expect(201);
    expect(ok.body.status).toBe('PENDING');
    const [{ n }] = await t.dataSource.query(`SELECT count(*)::int AS n FROM deposits WHERE user_id = $1`, [user]);
    expect(n).toBe(1);
  });

  it('scopes keys per operation', async () => {
    const user = uniqueUser();
    const k = key();
    await t.http.post('/internal/adjustments').set('Idempotency-Key', k)
      .send({ userId: user, currency: 'IRT', amount: '5000000', reason: 'x' }).expect(201);
    await withdraw(t, user, '100000', { key: k }).expect(201);
  });
});
