/**
 * End-to-end against the real stack (`docker compose up`, recommended with SIM_TIME_SCALE=10):
 * nginx -> 2 API replicas -> PostgreSQL / RabbitMQ, and the provided simulator as PSP + payout provider.
 * Provider misbehaviour is injected deterministically through the simulator's scenario queue.
 */
import {
  api,
  balance,
  fund,
  IBAN,
  isFinal,
  newUser,
  payDeposit,
  sim,
  sleep,
  TRC20,
  waitDeposit,
  waitUntil,
  waitWithdrawal,
} from './support/e2e-client';

describe('E2E: wallet service + simulator', () => {
  beforeAll(async () => {
    const health = await api.get('/health');
    if (health.status !== 200) throw new Error(`stack is not up at ${process.env.E2E_BASE_URL ?? 'http://localhost:3000'}`);
    const cfg = await sim.config();
    if (cfg.status !== 200) throw new Error('simulator admin API not reachable (SIM_ADMIN_KEY?)');
    await sim.chaos('off'); // deterministic: only the scenarios we queue misbehave
  });
  afterAll(async () => {
    await sim.chaos('default');
  });

  it('exposes the contract: zero wallet for a new user, OpenAPI document, health', async () => {
    const user = newUser();
    expect((await api.get(`/wallets/${user}`)).body.balances[0]).toMatchObject({ currency: 'IRT', available: '0' });
    expect((await api.get('/docs-json')).body.paths['/withdrawals']).toBeDefined();
    expect((await api.get('/health')).body).toMatchObject({ status: 'ok', database: 'up', broker: 'up' });
  });

  describe('deposits through the real PSP simulator', () => {
    it('happy path: the payer pays, the wallet is credited (PSP page shows the Toman amount)', async () => {
      const user = newUser();
      const { depositId, page } = await payDeposit(user, '120000');
      expect(page.body.display).toContain('۱۲۰٬۰۰۰'); // simulator divides our Rial amount by 10 for the payer
      const final = await waitDeposit(depositId);
      expect(final).toMatchObject({ status: 'SUCCEEDED', creditedAmount: '120000' });
      expect((await balance(user)).available).toBe('120000');
    });

    it.each([
      ['NOK callback first, then OK', ['orderCb']],
      ['forged x10 amount + duplicate callbacks', ['forgeCb', 'dupCb']],
      ['callback never arrives', ['missCb']],
      ['verify answers 503 once', ['verify503']],
    ])('%s -> credited exactly the paid amount, once', async (_, flags) => {
      const user = newUser();
      await sim.scenario('payment', flags);
      const { depositId } = await payDeposit(user, '50000');
      const final = await waitDeposit(depositId, 90000);
      expect(final).toMatchObject({ status: 'SUCCEEDED', creditedAmount: '50000' });
      await sleep(3000); // let late duplicates/forgeries arrive
      expect((await balance(user)).available).toBe('50000');
    });

    it('a payment the payer cancels ends FAILED, nothing credited', async () => {
      const user = newUser();
      const { depositId } = await payDeposit(user, '50000', 'fail');
      expect(await waitDeposit(depositId)).toMatchObject({ status: 'FAILED' });
      expect((await balance(user)).available).toBe('0');
    });
  });

  describe('withdrawals through the real payout simulator', () => {
    async function withdrawal(flags: string[] | null, amount = '100000', fundWith = '1000000') {
      const user = newUser();
      await fund(user, fundWith);
      if (flags) await sim.scenario('payout', flags);
      const res = await api.post('/withdrawals', { userId: user, currency: 'IRT', amount, destination: IBAN });
      expect(res.status).toBe(201);
      return { user, id: res.body.withdrawalId as string };
    }
    const providerView = async (id: string) => (await sim.payouts()).body.filter((p) => p.requestId === id);

    it('happy path: paid out in Rial, settled, exactly one provider transfer', async () => {
      const { user, id } = await withdrawal([]);
      expect(await waitWithdrawal(id)).toMatchObject({ status: 'SUCCEEDED', trackingId: expect.stringMatching(/^TRK/) });
      const transfers = await providerView(id);
      expect(transfers).toHaveLength(1);
      expect(transfers[0]).toMatchObject({ amount: '1000000', currency: 'IRR', executed: true });
      expect(await balance(user)).toMatchObject({ available: '900000', held: '0' });
    });

    it.each([
      ['503 before create', ['e503-before']],
      ['503 after create (hidden from GET)', ['e503-after']],
      ['connection dropped after create', ['timeout']],
      ['final webhook missing', ['missWh']],
      ['forged FAILED webhook after success', ['forgeWh']],
      ['duplicate + stale webhooks', ['dupWh', 'staleWh']],
    ])('%s -> SUCCEEDED once, never paid twice', async (_, flags) => {
      const { user, id } = await withdrawal(flags);
      expect(await waitWithdrawal(id, 150000)).toMatchObject({ status: 'SUCCEEDED' });
      await sleep(2500); // forged / stale webhooks arrive after the final one
      expect((await api.get(`/withdrawals/${id}`)).body.status).toBe('SUCCEEDED');
      const transfers = await providerView(id);
      expect(transfers).toHaveLength(1);
      expect(transfers[0].executed).toBe(true);
      expect(await balance(user)).toMatchObject({ available: '900000', held: '0' });
    });

    it('bank rejection -> FAILED and the money is available again', async () => {
      const { user, id } = await withdrawal(['fail']);
      expect(await waitWithdrawal(id)).toMatchObject({ status: 'FAILED', failureReason: 'PROVIDER_FAILED:BANK_REJECTED' });
      expect(await balance(user)).toMatchObject({ available: '1000000', held: '0' });
    });

    it('Paya return after success (ACCOUNT_CLOSED) -> money back to the user', async () => {
      const { user, id } = await withdrawal(['returned']);
      expect((await waitWithdrawal(id)).status).toBe('SUCCEEDED');
      const returned = await waitUntil(
        async () => (await api.get(`/withdrawals/${id}`)).body,
        (w) => w.status === 'FAILED',
        150000,
      );
      expect(returned.failureReason).toBe('RETURNED:ACCOUNT_CLOSED');
      expect(await balance(user)).toMatchObject({ available: '1000000', held: '0' });
    });

    it('USDT to TRC20 with the 1 USDT fee', async () => {
      const user = newUser();
      await fund(user, '50', 'USDT');
      const res = await api.post('/withdrawals', { userId: user, currency: 'USDT', amount: '20.5', destination: TRC20 });
      expect(res.status).toBe(201);
      expect(await waitWithdrawal(res.body.withdrawalId)).toMatchObject({ status: 'SUCCEEDED', fee: '1' });
      expect(await balance(user, 'USDT')).toMatchObject({ available: '28.5', held: '0' });
      const [transfer] = (await sim.payouts()).body.filter((p) => p.requestId === res.body.withdrawalId);
      expect(transfer).toMatchObject({ amount: '20.5', currency: 'USDT' });
    });

    it('contract errors', async () => {
      const user = newUser();
      await fund(user, '150000');
      const post = (body: object) => api.post('/withdrawals', { userId: user, currency: 'IRT', destination: IBAN, ...body });
      expect((await post({ amount: '100000', destination: 'IR000000000000000000000000' })).body.code).toBe('INVALID_DESTINATION');
      expect((await post({ amount: '50000' })).body.code).toBe('BELOW_MINIMUM');
      expect((await post({ amount: '200000' })).body.code).toBe('INSUFFICIENT_FUNDS');
      const k = 'e2e-reused-' + user;
      await api.post('/withdrawals', { userId: user, currency: 'IRT', destination: IBAN, amount: '100000' }, k);
      const reused = await api.post('/withdrawals', { userId: user, currency: 'IRT', destination: IBAN, amount: '110000' }, k);
      expect(reused).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    });
  });

  it('transfers between users are atomic', async () => {
    const [x, y] = [newUser(), newUser()];
    await fund(x, '300000');
    const res = await api.post('/transfers', { fromUserId: x, toUserId: y, currency: 'IRT', amount: '120000' });
    expect(res.status).toBe(201);
    expect((await balance(x)).available).toBe('180000');
    expect((await balance(y)).available).toBe('120000');
  });

  it('reconciliation reports the PSP settlement rows we do not know (and matches the rest)', async () => {
    const [{ today }] = [{ today: new Date(Date.now() + 3.5 * 3600_000).toISOString().slice(0, 10) }];
    const res = await api.post('/reconciliation/run', { date: today }, null);
    expect(res.status).toBe(200);
    expect(res.body.summary.matched).toBeGreaterThan(0);
    expect(res.body.mismatches.some((m: { type: string; kind: string }) => m.type === 'MISSING_IN_LEDGER' && m.kind === 'DEPOSIT')).toBe(true);
    expect(res.body.summary.bankFeeRows).toBeGreaterThan(0);
  });

  it('the ledger is intact after everything above', async () => {
    const report = await waitUntil(async () => (await api.get('/internal/ledger/integrity')).body, (r) => r.ok, 10000);
    expect(report).toMatchObject({ ok: true, unbalancedJournals: [], balanceDrift: [], negativeBalances: 0 });
  });

  it('every committed change reached the broker (outbox drained)', async () => {
    const health = await waitUntil(async () => (await api.get('/health')).body, (h) => h.outboxBacklog === 0, 20000);
    expect(health.outboxBacklog).toBe(0);
  });

  it('no deposit or withdrawal is left in a non-final state', async () => {
    // (pending deposits that were never paid excluded: they are legitimately open)
    const pendingWithdrawals = await waitUntil(
      async () => {
        const payouts = (await sim.payouts()).body;
        const ours = await Promise.all(payouts.map(async (p) => (await api.get(`/withdrawals/${p.requestId}`)).body));
        return ours.filter((w) => w?.withdrawalId && !isFinal(w));
      },
      (open) => open.length === 0,
      60000,
    );
    expect(pendingWithdrawals).toEqual([]);
  });
});
