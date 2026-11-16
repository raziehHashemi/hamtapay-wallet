import { AppConfig } from '../../src/config/app-config';
import { NotificationProjector } from '../../src/modules/notifications/notification.projector';
import { EventPublisher } from '../../src/modules/outbox/event-publisher';
import { OutboxRelayWorker } from '../../src/modules/outbox/outbox-relay.worker';
import type { EventEnvelope } from '../../src/modules/outbox/outbox.service';
import { createTestApp, fund, key, payoutWebhook, runDispatcher, TestApp, uniqueUser, withdraw } from '../support/test-app';

class RecordingPublisher extends EventPublisher {
  readonly name = 'recording';
  readonly published: EventEnvelope[] = [];
  failing = false;
  async publish(events: EventEnvelope[]): Promise<void> {
    if (this.failing) throw new Error('broker down');
    this.published.push(...events);
  }
  isHealthy(): boolean {
    return !this.failing;
  }
}

describe('events: transactional outbox -> broker -> idempotent consumer (real PostgreSQL)', () => {
  let t: TestApp;
  let publisher: RecordingPublisher;
  let relay: OutboxRelayWorker;

  beforeAll(async () => {
    t = await createTestApp();
    publisher = new RecordingPublisher();
    relay = new OutboxRelayWorker(t.dataSource, publisher, t.app.get(AppConfig));
  });
  afterAll(() => t.close());

  it('every balance change produces an event that survives until the broker confirms it', async () => {
    const userId = uniqueUser();
    publisher.failing = true;
    await fund(t, userId, '1000');
    await relay.runOnce(); // broker down: nothing lost, attempts recorded
    const [pending] = await t.dataSource.query(
      `SELECT count(*)::int AS n, max(attempts) AS attempts FROM outbox_events WHERE published_at IS NULL AND aggregate_id = $1`,
      [userId],
    );
    expect(pending.n).toBeGreaterThan(0);
    expect(pending.attempts).toBeGreaterThan(0);

    publisher.failing = false; // broker is back
    while (await relay.runOnce()) {
      /* drain */
    }
    const types = publisher.published.filter((e) => e.aggregateId === userId).map((e) => e.type);
    expect(types).toContain('wallet.balance_changed');
    const [left] = await t.dataSource.query(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
    expect(left.n).toBe(0);
  });

  it('balance_changed carries the new balances', async () => {
    const userId = uniqueUser();
    await fund(t, userId, '2000000');
    await withdraw(t, userId, '500000').expect(201);
    while (await relay.runOnce()) {
      /* drain */
    }
    const last = publisher.published.filter((e) => e.type === 'wallet.balance_changed' && e.aggregateId === userId).at(-1)!;
    expect(last.data).toMatchObject({ userId, currency: 'IRT', available: '1500000', held: '500000', journalType: 'WITHDRAWAL_HOLD' });
  });

  it('the consumer applies a re-delivered event only once', async () => {
    const projector = t.app.get(NotificationProjector);
    const event = publisher.published.find((e) => e.type === 'wallet.balance_changed')!;
    expect(await projector.handle(event)).toBe('applied');
    expect(await projector.handle(event)).toBe('duplicate');
    expect(await projector.handle({ ...event })).toBe('duplicate');
    const [{ n }] = await t.dataSource.query(`SELECT count(*)::int AS n FROM user_notifications WHERE event_id = $1`, [
      event.eventId,
    ]);
    expect(n).toBe(1);
  });
});

describe('reconciliation against the PSP settlement report (real PostgreSQL)', () => {
  let t: TestApp;
  beforeAll(async () => (t = await createTestApp()));
  afterAll(() => t.close());

  it('reports what is only on one side or differs, and changes nothing', async () => {
    // one real deposit (matched), one deposit the PSP settled differently, one IBAN withdrawal + fee
    const userId = uniqueUser();
    const deposit = async (amount: string) => {
      const res = await t.http.post('/deposits').set('Idempotency-Key', key()).send({ userId, amount }).expect(201);
      const token = t.psp.tokenFromUrl(res.body.paymentUrl);
      t.psp.pay(token);
      await t.http.post('/webhooks/psp/callback').send({ token, status: 'OK' }).expect(200);
      return (await t.http.get(`/deposits/${res.body.depositId}`)).body.refId as string;
    };
    const refA = await deposit('500000');
    const refB = await deposit('300000');
    await fund(t, userId, '10000000');
    const wid = (await withdraw(t, userId, '1000000').expect(201)).body.withdrawalId;
    await runDispatcher(t);
    await payoutWebhook(t, { requestId: wid, status: 'SUCCEEDED' }).expect(200);
    const [{ provider_tracking_id: trk }] = await t.dataSource.query(`SELECT provider_tracking_id FROM withdrawals WHERE id = $1`, [wid]);
    const ourOnly = await deposit('100000'); // the PSP "forgot" this one

    const [{ today }] = await t.dataSource.query(`SELECT to_char((now() AT TIME ZONE 'Asia/Tehran')::date, 'YYYY-MM-DD') AS today`);
    const balanceBefore = await t.http.get(`/wallets/${userId}`);
    t.psp.settlementCsv =
      '﻿ردیف,تاریخ,شماره پیگیری,نوع تراکنش,مبلغ (ریال),شرح\r\n' +
      `1,۱۴۰۵/۰۸/۲۵,000${refA},واریز درگاه,"۵٬۰۰۰٬۰۰۰",x\r\n` +
      `2,1405/08/25, ${refB} ,واریز درگاه,"3,100,000",y\r\n` +
      `2,1405/08/25, ${refB} ,واریز درگاه,"3,100,000",y\r\n` +
      `3,1405/08/25,${trk},برداشت پایا,"-10,000,000",z\r\n` +
      `4,1405/08/25,${trk},کارمزد,"-2,500",fee\r\n` +
      `5,1405/08/25,7777777777,واریز درگاه,"2,000,000",پرداخت اینترنتی نامشخص\r\n`;

    const res = await t.http.post('/reconciliation/run').send({ date: today }).expect(200);
    expect(res.body.summary).toMatchObject({
      settlementRows: 5,
      duplicateLinesIgnored: 1,
      matched: 2,
      bankFeeRows: 1,
      bankFeesRial: '-2500',
    });
    const mismatches = res.body.mismatches.map((m: { type: string; reference: string }) => `${m.type}:${m.reference}`).sort();
    expect(mismatches).toEqual([`AMOUNT_MISMATCH:${refB}`, `MISSING_IN_LEDGER:7777777777`, `MISSING_IN_SETTLEMENT:${ourOnly}`].sort());
    expect(res.body.mismatches.find((m: { type: string }) => m.type === 'AMOUNT_MISMATCH')).toMatchObject({
      settlementAmount: '3100000',
      ledgerAmount: '3000000',
      currency: 'IRR',
    });
    expect((await t.http.get(`/wallets/${userId}`)).body).toEqual(balanceBefore.body);
    const [{ n }] = await t.dataSource.query(`SELECT count(*)::int AS n FROM reconciliation_reports`);
    expect(n).toBe(1);
  });

  it('validates the date', async () => {
    await t.http.post('/reconciliation/run').send({ date: '2026-13-01' }).expect(400);
    await t.http.post('/reconciliation/run').send({ date: '16/11/2026' }).expect(400);
  });
});
