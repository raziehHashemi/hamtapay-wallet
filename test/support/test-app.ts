import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { PayoutGateway } from '../../src/integrations/payout/payout-gateway';
import { PaymentGateway } from '../../src/integrations/psp/payment-gateway';
import { DepositPollerWorker } from '../../src/modules/deposits/deposit-poller.worker';
import { LedgerIntegrityService } from '../../src/modules/ledger/ledger-integrity.service';
import { signWebhook } from '../../src/modules/withdrawals/webhook-signature';
import { WithdrawalDispatcherWorker } from '../../src/modules/withdrawals/withdrawal-dispatcher.worker';
import { FakePaymentGateway } from './fake-payment-gateway';
import { FakePayoutGateway } from './fake-payout-gateway';

export const WEBHOOK_SECRET = 'test-webhook-secret';
export const VALID_IBAN = 'IR820540102680020817909002';
export const VALID_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface TestApp {
  app: INestApplication;
  http: TestAgent;
  psp: FakePaymentGateway;
  payout: FakePayoutGateway;
  dataSource: DataSource;
  dispatcher: WithdrawalDispatcherWorker;
  depositPoller: DepositPollerWorker;
  integrity: LedgerIntegrityService;
  close(): Promise<void>;
}

/**
 * Boots the real AppModule (real PostgreSQL, real HTTP pipeline, real workers code) with the two external
 * adapters replaced by deterministic fakes. Background loops are disabled; tests drive workers with runOnce().
 * Several instances can share one database to emulate horizontal scaling.
 */
export async function createTestApp(
  options: { psp?: FakePaymentGateway; payout?: FakePayoutGateway; env?: Record<string, string>; reset?: boolean } = {},
): Promise<TestApp> {
  Object.assign(process.env, {
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    DB_POOL_SIZE: '40',
    WORKERS_ENABLED: 'false',
    RABBITMQ_URL: '',
    INTERNAL_API_KEY: '',
    PAYOUT_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PUBLIC_BASE_URL: 'http://wallet.test',
    WITHDRAWAL_DISPATCH_DELAY_MS: '0',
    ...options.env,
  });
  const psp = options.psp ?? new FakePaymentGateway();
  const payout = options.payout ?? new FakePayoutGateway();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PaymentGateway)
    .useValue(psp)
    .overrideProvider(PayoutGateway)
    .useValue(payout)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: true, logger: ['error'] });
  configureApp(app);
  await app.init();
  if (options.reset !== false) await resetDatabase(app.get(DataSource));
  return {
    app,
    http: request(app.getHttpServer()),
    psp,
    payout,
    dataSource: app.get(DataSource),
    dispatcher: app.get(WithdrawalDispatcherWorker),
    depositPoller: app.get(DepositPollerWorker),
    integrity: app.get(LedgerIntegrityService),
    close: () => app.close(),
  };
}

export const uniqueUser = (prefix = 'u') => `${prefix}-${randomUUID().slice(0, 12)}`;
export const key = () => randomUUID();

/** Credits a wallet through the operations endpoint (double-entry, idempotent). */
export async function fund(t: TestApp, userId: string, amount: string, currency = 'IRT'): Promise<void> {
  await t.http
    .post('/internal/adjustments')
    .set('Idempotency-Key', key())
    .send({ userId, currency, amount, reason: 'test funding' })
    .expect(201);
}

export async function wallet(t: TestApp, userId: string, currency = 'IRT') {
  const res = await t.http.get(`/wallets/${userId}`).expect(200);
  return res.body.balances.find((b: { currency: string }) => b.currency === currency) as {
    available: string;
    held: string;
    total: string;
    debt: string;
  };
}

export function withdraw(t: TestApp, userId: string, amount: string, extra: Record<string, unknown> = {}) {
  return t.http
    .post('/withdrawals')
    .set('Idempotency-Key', (extra.key as string) ?? key())
    .send({ userId, currency: 'IRT', amount, destination: VALID_IBAN, ...extra, key: undefined });
}

/** Sends a payout webhook exactly like the provider: HMAC-SHA256 over the raw JSON body. */
export function payoutWebhook(
  t: TestApp,
  body: Record<string, unknown>,
  options: { signature?: string; secret?: string } = {},
) {
  const raw = JSON.stringify({ event: 'transfer.updated', eventId: `evt_${randomUUID()}`, ...body });
  return t.http
    .post('/webhooks/payout')
    .set('content-type', 'application/json')
    .set('x-signature', options.signature ?? signWebhook(raw, options.secret ?? WEBHOOK_SECRET))
    .send(raw);
}

/** Makes every scheduled row due now, then runs one worker batch (simulates time passing). */
export async function runDispatcher(t: TestApp): Promise<void> {
  await t.dataSource.query(`UPDATE withdrawals SET next_attempt_at = now() WHERE next_attempt_at IS NOT NULL`);
  await t.dispatcher.runOnce();
}

export async function runDepositPoller(t: TestApp): Promise<void> {
  await t.dataSource.query(`UPDATE deposits SET next_check_at = now() WHERE next_check_at IS NOT NULL`);
  await t.depositPoller.runOnce();
}

export async function expectLedgerIntact(t: TestApp): Promise<void> {
  const report = await t.integrity.check();
  expect({
    ok: report.ok,
    unbalanced: report.unbalancedJournals,
    drift: report.balanceDrift,
    negative: report.negativeBalances,
  }).toEqual({ ok: true, unbalanced: [], drift: [], negative: 0 });
}

/** Clean slate for a test file: business data and user accounts go, schema and system accounts stay. */
export async function resetDatabase(dataSource: DataSource): Promise<void> {
  await dataSource.query(
    `TRUNCATE deposits, withdrawals, withdrawal_daily_usage, transfers, adjustments, idempotency_keys,
              outbox_events, processed_events, user_notifications, inbound_events, reconciliation_reports,
              ledger_entries, ledger_journals RESTART IDENTITY CASCADE`,
  );
  await dataSource.query(`DELETE FROM ledger_accounts WHERE owner_user_id IS NOT NULL`);
}
