import {
  createTestApp,
  expectLedgerIntact,
  key,
  runDepositPoller,
  TestApp,
  uniqueUser,
  wallet,
} from '../support/test-app';

describe('deposits (real PostgreSQL, fake PSP with the simulator behaviours)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  async function createDeposit(amount = '500000', userId = uniqueUser()) {
    const res = await t.http
      .post('/deposits')
      .set('Idempotency-Key', key())
      .send({ userId, amount })
      .expect(201);
    return {
      userId,
      depositId: res.body.depositId as string,
      token: t.psp.tokenFromUrl(res.body.paymentUrl),
      body: res.body,
    };
  }
  const callback = (token: string, status = 'OK', extra: Record<string, unknown> = {}) =>
    t.http
      .post('/webhooks/psp/callback')
      .send({ token, orderId: undefined, status, ...extra })
      .expect(200);
  const status = async (depositId: string) => (await t.http.get(`/deposits/${depositId}`).expect(200)).body;

  it('registers a deposit and returns the payment link; the PSP is asked for Rial', async () => {
    const { body, token } = await createDeposit('500000');
    expect(body).toMatchObject({
      status: 'PENDING',
      amount: '500000',
      paymentUrl: expect.stringContaining(token),
    });
    const payment = t.psp.payments.get(token)!;
    expect(payment.amountRial).toBe(5_000_000n); // 500,000 Toman = 5,000,000 Rial
    expect(payment.orderId).toBe(body.depositId);
  });

  it('validates input', async () => {
    const send = (body: object) => t.http.post('/deposits').set('Idempotency-Key', key()).send(body);
    expect((await send({ userId: uniqueUser(), amount: 500000 })).body.code).toBe('VALIDATION_ERROR');
    expect((await send({ userId: uniqueUser(), amount: '1000.5' })).status).toBe(400);
    expect((await send({ userId: uniqueUser(), amount: '-5' })).status).toBe(400);
    expect((await send({ amount: '5000' })).status).toBe(400);
    const below = await send({ userId: uniqueUser(), amount: '999' }).expect(422);
    expect(below.body.code).toBe('BELOW_MINIMUM');
  });

  it('happy path: callback -> inquiry -> verify -> credited exactly once', async () => {
    const { userId, depositId, token } = await createDeposit('500000');
    t.psp.pay(token);
    await callback(token);
    expect(await status(depositId)).toMatchObject({
      status: 'SUCCEEDED',
      creditedAmount: '500000',
      refId: expect.any(String),
    });
    expect((await wallet(t, userId)).available).toBe('500000');
  });

  it('10 concurrent duplicate callbacks credit once', async () => {
    const { userId, depositId, token } = await createDeposit('700000');
    t.psp.pay(token);
    await Promise.all(Array.from({ length: 10 }, () => callback(token)));
    expect((await status(depositId)).status).toBe('SUCCEEDED');
    expect((await wallet(t, userId)).available).toBe('700000');
    const [{ n }] = await t.dataSource.query(
      `SELECT count(*)::int AS n FROM ledger_journals WHERE reference_id = $1`,
      [depositId],
    );
    expect(n).toBe(1);
  });

  it('a NOK callback that arrives before the OK one does not fail a paid deposit', async () => {
    const { userId, depositId, token } = await createDeposit();
    t.psp.pay(token);
    await callback(token, 'NOK');
    expect((await status(depositId)).status).toBe('SUCCEEDED');
    await callback(token, 'OK');
    expect((await wallet(t, userId)).available).toBe('500000');
  });

  it('ignores the amount in a (forged) callback and credits what the PSP verified', async () => {
    const { userId, token } = await createDeposit('100000');
    t.psp.pay(token);
    await callback(token, 'OK', { amount: '10000000' }); // simulator sends x10 forged amounts
    expect((await wallet(t, userId)).available).toBe('100000');
  });

  it('a callback before the payer paid changes nothing (verify is never called on an INIT payment)', async () => {
    const { depositId, token } = await createDeposit();
    const verifiesBefore = t.psp.calls.verify;
    await callback(token, 'OK');
    expect((await status(depositId)).status).toBe('PENDING');
    expect(t.psp.calls.verify).toBe(verifiesBefore);
    // the payer pays later: still credited
    t.psp.pay(token);
    await callback(token);
    expect((await status(depositId)).status).toBe('SUCCEEDED');
  });

  it('a missing callback is covered by the poller', async () => {
    const { userId, depositId, token } = await createDeposit('250000');
    t.psp.pay(token);
    await runDepositPoller(t);
    expect((await status(depositId)).status).toBe('SUCCEEDED');
    expect((await wallet(t, userId)).available).toBe('250000');
  });

  it('a verify that answers 503 is retried (deposit waits in VERIFYING, never fails)', async () => {
    const { depositId, token } = await createDeposit();
    t.psp.pay(token);
    t.psp.verify503Once.add(token);
    await callback(token);
    expect((await status(depositId)).status).toBe('VERIFYING');
    await runDepositPoller(t);
    expect((await status(depositId)).status).toBe('SUCCEEDED');
  });

  it('PSP unreachable during inquiry: nothing is decided, the poller retries later', async () => {
    const { depositId, token } = await createDeposit();
    t.psp.pay(token);
    t.psp.inquiryFails = true;
    await callback(token);
    await runDepositPoller(t);
    expect((await status(depositId)).status).toBe('PENDING');
    t.psp.inquiryFails = false;
    await runDepositPoller(t);
    expect((await status(depositId)).status).toBe('SUCCEEDED');
  });

  it('a failed payment fails the deposit and credits nothing', async () => {
    const { userId, depositId, token } = await createDeposit();
    t.psp.pay(token, 'fail');
    await callback(token, 'NOK');
    expect(await status(depositId)).toMatchObject({ status: 'FAILED', failureReason: 'PAYMENT_FAILED' });
    expect((await wallet(t, userId)).available).toBe('0');
  });

  it('a payment reversed by the PSP (not verified in time) fails the deposit', async () => {
    const { depositId, token } = await createDeposit();
    t.psp.pay(token);
    t.psp.reverse(token);
    await runDepositPoller(t);
    expect(await status(depositId)).toMatchObject({ status: 'FAILED', failureReason: 'PAYMENT_REVERSED' });
  });

  it('a verified amount different from the request is credited as paid (never more) and flagged', async () => {
    const { userId, depositId, token } = await createDeposit('500000');
    t.psp.pay(token);
    t.psp.payments.get(token)!.verifyAmountOverride = 4_000_000n;
    await callback(token);
    expect(await status(depositId)).toMatchObject({
      status: 'SUCCEEDED',
      amount: '500000',
      creditedAmount: '400000',
    });
    expect((await wallet(t, userId)).available).toBe('400000');
    const [row] = await t.dataSource.query(`SELECT needs_review, anomaly FROM deposits WHERE id = $1`, [
      depositId,
    ]);
    expect(row.needs_review).toBe(true);
    expect(row.anomaly).toContain('AMOUNT_MISMATCH');
  });

  it('crash after verify, before credit: the next round sees ALREADY_VERIFIED and credits', async () => {
    const { userId, depositId, token } = await createDeposit('300000');
    t.psp.pay(token);
    await t.psp.verify(token); // PSP side verified, our process "died" before recording it
    await runDepositPoller(t);
    expect((await status(depositId)).status).toBe('SUCCEEDED');
    expect((await wallet(t, userId)).available).toBe('300000');
  });

  it('accepts and audits callbacks for unknown tokens without failing', async () => {
    const res = await t.http.post('/webhooks/psp/callback').send({ token: 'nope', status: 'OK' }).expect(200);
    expect(res.body).toEqual({ received: true });
    const [{ n }] = await t.dataSource.query(
      `SELECT count(*)::int AS n FROM inbound_events WHERE source = 'PSP_CALLBACK' AND outcome = 'unknown-token'`,
    );
    expect(n).toBeGreaterThan(0);
  });

  it('returns 404 for unknown or malformed deposit ids', async () => {
    expect((await t.http.get('/deposits/00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await t.http.get('/deposits/not-a-uuid')).body).toEqual({
      code: 'NOT_FOUND',
      message: 'deposit not found',
    });
  });

  it('keeps the ledger consistent', async () => {
    await expectLedgerIntact(t);
  });
});
