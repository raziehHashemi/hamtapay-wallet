/* eslint-disable no-console */
/**
 * Black-box probe of the external-services simulator. Every request/response and every inbound
 * callback/webhook is written to docs/evidence/simulator-probe.log; docs/provider-notes.md quotes from it.
 *
 *   docker compose -f docker-compose.probe.yml up -d     # simulator only, webhooks pointed at this script
 *   npm run probe:simulator
 *
 * Env: SIM_URL (http://localhost:8080), HOOK_PORT (39999), HOOK_HOST (host.docker.internal),
 *      SIM_ADMIN_KEY (enables deterministic scenarios), HOSTILE_SAMPLES (40)
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, IncomingMessage } from 'node:http';
import { join } from 'node:path';

const SIM = process.env.SIM_URL ?? 'http://localhost:8080';
const HOOK_PORT = Number(process.env.HOOK_PORT ?? 39999);
const HOOK_BASE = `http://${process.env.HOOK_HOST ?? 'host.docker.internal'}:${HOOK_PORT}`;
const ADMIN_KEY = process.env.SIM_ADMIN_KEY ?? '';
const SECRET = process.env.WEBHOOK_SECRET ?? 'hamtapay-sim-secret';
const SAMPLES = Number(process.env.HOSTILE_SAMPLES ?? 40);
const OUT_DIR = join(__dirname, '..', 'docs', 'evidence');
const LOG = join(OUT_DIR, 'simulator-probe.log');

const VALID_IBAN = 'IR820540102680020817909002';
const VALID_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

interface Inbound {
  at: number;
  path: string;
  headers: Record<string, string | undefined>;
  raw: string;
  json: Record<string, unknown>;
  signatureValid?: boolean;
}

const t0 = Date.now();
const inbound: Inbound[] = [];
/** Requests whose webhook deliveries we answer with 500 the first time (to observe provider retries). */
const failFirstDeliveryFor = new Set<string>();
const alreadyFailedEvents = new Set<string>();

function log(line: string): void {
  const stamped = `[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${line}`;
  console.log(stamped);
  appendFileSync(LOG, stamped + '\n');
}

function section(title: string): void {
  log('');
  log(`=== ${title} ===`);
}

async function call(method: string, path: string, body?: unknown, timeoutMs = 60000) {
  const started = Date.now();
  try {
    const res = await fetch(`${SIM}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(ADMIN_KEY ? { 'x-admin-key': ADMIN_KEY } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    log(`${method} ${path} ${body ? JSON.stringify(body) : ''} -> ${res.status} ${text.slice(0, 400)} (${Date.now() - started}ms)`);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* csv */
    }
    return { status: res.status, text, json };
  } catch (error) {
    log(`${method} ${path} ${body ? JSON.stringify(body) : ''} -> TRANSPORT ERROR ${(error as Error).name}: ${(error as Error).message} (${Date.now() - started}ms)`);
    return { status: 0, text: '', json: {} as Record<string, unknown> };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const admin = (path: string, body?: unknown) => call('POST', `/__admin/${path}`, body);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

function startListener(): Promise<void> {
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    const entry: Inbound = {
      at: Date.now(),
      path: req.url ?? '',
      headers: { 'x-signature': req.headers['x-signature'] as string, 'x-event-id': req.headers['x-event-id'] as string },
      raw,
      json,
    };
    if (entry.headers['x-signature']) {
      entry.signatureValid = createHmac('sha256', SECRET).update(raw).digest('hex') === entry.headers['x-signature'];
    }
    inbound.push(entry);
    const eventId = entry.headers['x-event-id'];
    const failThis =
      !!eventId && failFirstDeliveryFor.has(String(json.requestId)) && !alreadyFailedEvents.has(eventId);
    if (failThis) alreadyFailedEvents.add(eventId!);
    log(
      `<<< INBOUND ${req.method} ${entry.path} ${raw}` +
        (entry.headers['x-signature'] ? ` sig=${entry.headers['x-signature'].slice(0, 12)}… valid=${entry.signatureValid}` : '') +
        (eventId ? ` x-event-id=${eventId}` : '') +
        (failThis ? ' -> answering 500 on purpose' : ''),
    );
    res.writeHead(failThis ? 500 : 200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  return new Promise((resolve) => server.listen(HOOK_PORT, '0.0.0.0', () => resolve()));
}

const callbacksFor = (token: string) => inbound.filter((i) => i.path.startsWith('/callback') && i.json.token === token);
const webhooksFor = (requestId: string) => inbound.filter((i) => i.path.startsWith('/webhook') && i.json.requestId === requestId);

async function newPayment(amountRial = '1000000', scenario?: string[]) {
  if (scenario) await admin('scenario', { payment: [scenario] });
  const orderId = `probe-${randomUUID().slice(0, 8)}`;
  const created = await call('POST', '/psp/payments', { amount: amountRial, callbackUrl: `${HOOK_BASE}/callback`, orderId });
  return { token: String(created.json.token), orderId, created };
}

async function newPayout(scenario?: string[], overrides: Record<string, unknown> = {}, timeoutMs = 60000) {
  if (scenario) await admin('scenario', { payout: [scenario] });
  const requestId = `probe-${randomUUID()}`;
  const body = { requestId, type: 'IBAN', destination: VALID_IBAN, amount: '1000000', currency: 'IRR', ...overrides };
  const res = await call('POST', '/payout/transfers', body, timeoutMs);
  return { requestId, body, res };
}

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

async function deterministic(): Promise<void> {
  const config = await call('GET', '/__admin/config');
  if (config.status !== 200) {
    log('admin API not enabled (SIM_ADMIN_KEY missing) - skipping deterministic scenarios');
    return;
  }
  await admin('chaos', { profile: 'off' });

  section('E1 PSP amount unit: amount we send is shown to the payer divided by 10 (=> Rial)');
  {
    const p = await newPayment('1000000');
    await call('GET', `/psp/pay/${p.token}`);
  }

  section('E2 PSP validation: minimum amount and integer-only');
  await call('POST', '/psp/payments', { amount: '9999', callbackUrl: `${HOOK_BASE}/callback`, orderId: 'x' });
  await call('POST', '/psp/payments', { amount: '10000.5', callbackUrl: `${HOOK_BASE}/callback`, orderId: 'x' });
  await call('POST', '/psp/payments', { amount: '10000', orderId: 'no-callback' });

  section('E3 verify BEFORE the payer paid returns HTTP 200 code -51 FAILED (indistinguishable from a real failure)');
  {
    const p = await newPayment();
    await call('POST', '/psp/verify', { token: p.token });
    await call('GET', `/psp/payments/${p.token}`);
    log('-> the payment is still INIT and can still be paid afterwards:');
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await call('POST', '/psp/verify', { token: p.token });
  }

  section('E4 happy path callback: status OK/NOK (not SUCCESS/FAILED), unsigned; verify is idempotent (code 101)');
  {
    const p = await newPayment('1000000', []);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await waitFor(() => callbacksFor(p.token).length >= 1, 5000);
    await call('POST', '/psp/verify', { token: p.token });
    await call('POST', '/psp/verify', { token: p.token });
    const f = await newPayment('1000000', []);
    await call('POST', `/psp/pay/${f.token}`, { result: 'fail' });
    await waitFor(() => callbacksFor(f.token).length >= 1, 5000);
    await call('POST', '/psp/verify', { token: f.token });
    await call('POST', `/psp/pay/${f.token}`, { result: 'success' });
  }

  section('E5 duplicate callbacks (dupCb)');
  {
    const p = await newPayment('1000000', ['dupCb']);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await sleep(6000);
    log(`callbacks received for ${p.token}: ${callbacksFor(p.token).length}`);
  }

  section('E6 out-of-order callbacks (orderCb): NOK first, then OK, for a PAID payment');
  {
    const p = await newPayment('1000000', ['orderCb']);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await waitFor(() => callbacksFor(p.token).length >= 2, 6000);
    await call('GET', `/psp/payments/${p.token}`);
  }

  section('E7 forged callback (forgeCb): extra OK callback carrying amount x10');
  {
    const p = await newPayment('1000000', ['forgeCb']);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await waitFor(() => callbacksFor(p.token).length >= 2, 6000);
    await call('POST', '/psp/verify', { token: p.token });
  }

  section('E8 missing callback (missCb): payment is PAID but no callback ever arrives');
  {
    const p = await newPayment('1000000', ['missCb']);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await sleep(4000);
    log(`callbacks received for ${p.token}: ${callbacksFor(p.token).length}`);
    await call('GET', `/psp/payments/${p.token}`);
  }

  section('E9 verify returns 503 once (verify503)');
  {
    const p = await newPayment('1000000', ['verify503']);
    await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
    await call('POST', '/psp/verify', { token: p.token });
    await call('POST', '/psp/verify', { token: p.token });
  }

  section('E10 unverified PAID payment is auto-reversed after 600s/SIM_TIME_SCALE');
  {
    const cfg = (await call('GET', '/__admin/config')).json as { scale?: number };
    const waitMs = Math.ceil((600 / Number(cfg.scale ?? 1)) * 1000) + 1500;
    if (waitMs > 70000) {
      log(`skipped: needs ${waitMs}ms at scale ${cfg.scale}`);
    } else {
      const p = await newPayment('1000000', []);
      await call('POST', `/psp/pay/${p.token}`, { result: 'success' });
      log(`waiting ${waitMs}ms without verifying...`);
      await sleep(waitMs);
      await call('GET', `/psp/payments/${p.token}`);
      await call('POST', '/psp/verify', { token: p.token });
    }
  }

  section('E11 payout create is idempotent by requestId (even with a different body)');
  {
    const p = await newPayout([]);
    await call('POST', '/payout/transfers', p.body);
    await call('POST', '/payout/transfers', { ...p.body, amount: '999999999' });
  }

  section('E12 payout validation: IBAN needs IRR integer; destination checked only later (async FAILED)');
  {
    await call('POST', '/payout/transfers', { requestId: 'short', type: 'IBAN', destination: VALID_IBAN, amount: '1', currency: 'IRR' });
    await call('POST', '/payout/transfers', { requestId: `probe-${randomUUID()}`, type: 'IBAN', destination: VALID_IBAN, amount: '100.5', currency: 'IRR' });
    await call('POST', '/payout/transfers', { requestId: `probe-${randomUUID()}`, type: 'IBAN', destination: VALID_IBAN, amount: '1000', currency: 'IRT' });
    const bad = await newPayout([], { destination: 'IR000000000000000000000000' });
    await waitFor(() => webhooksFor(bad.requestId).some((w) => w.json.status === 'FAILED'), 15000);
    await call('GET', `/payout/transfers/${bad.requestId}`);
  }

  section('E13 503 BEFORE create (e503-before): transfer not created');
  {
    const p = await newPayout(['e503-before']);
    await call('GET', `/payout/transfers/${p.requestId}`);
    await call('POST', '/payout/transfers', p.body);
  }

  section('E14 503 AFTER create (e503-after): transfer IS created, GET hides it (404) for 90s/scale; re-POST reveals it');
  {
    const p = await newPayout(['e503-after']);
    await call('GET', `/payout/transfers/${p.requestId}`);
    await call('POST', '/payout/transfers', p.body);
    await sleep(3000);
    await call('GET', `/payout/transfers/${p.requestId}`);
    log(`webhooks already received for this "failed" request: ${webhooksFor(p.requestId).map((w) => w.json.status).join(', ')}`);
  }

  section('E15 timeout (timeout): connection held then destroyed; transfer created and hidden');
  {
    const p = await newPayout(['timeout'], {}, 60000);
    await call('GET', `/payout/transfers/${p.requestId}`);
    await call('POST', '/payout/transfers', p.body);
  }

  section('E16 webhooks: signature, duplicate (dupWh), stale PROCESSING after final (staleWh)');
  {
    const p = await newPayout(['dupWh', 'staleWh']);
    await sleep(8000);
    for (const w of webhooksFor(p.requestId)) {
      log(`  webhook status=${w.json.status} eventId=${w.json.eventId} occurredAt=${w.json.occurredAt} sigValid=${w.signatureValid}`);
    }
  }

  section('E17 forged FAILED webhook after SUCCEEDED (forgeWh): signature does not verify');
  {
    const p = await newPayout(['forgeWh']);
    await waitFor(() => webhooksFor(p.requestId).some((w) => w.json.status === 'FAILED'), 15000);
    for (const w of webhooksFor(p.requestId)) {
      log(`  webhook status=${w.json.status} sigValid=${w.signatureValid}`);
    }
    await call('GET', `/payout/transfers/${p.requestId}`);
  }

  section('E18 missing final webhook (missWh): only PROCESSING arrives; GET shows the final state');
  {
    const p = await newPayout(['missWh']);
    await sleep(6000);
    log(`  webhooks: ${webhooksFor(p.requestId).map((w) => w.json.status).join(', ')}`);
    await call('GET', `/payout/transfers/${p.requestId}`);
  }

  section('E19 SUCCEEDED then RETURNED (returned): Paya transfer bounces later (ACCOUNT_CLOSED)');
  {
    const p = await newPayout(['returned']);
    await waitFor(() => webhooksFor(p.requestId).some((w) => w.json.status === 'RETURNED'), 60000);
    log(`  webhooks: ${webhooksFor(p.requestId).map((w) => `${w.json.status}@${w.json.occurredAt}`).join(', ')}`);
    await call('GET', `/payout/transfers/${p.requestId}`);
  }

  section('E20 bank rejection (fail): FAILED with reason BANK_REJECTED');
  {
    const p = await newPayout(['fail']);
    await waitFor(() => webhooksFor(p.requestId).some((w) => w.json.status === 'FAILED'), 15000);
    await call('GET', `/payout/transfers/${p.requestId}`);
  }

  section('E21 webhook retries when we answer non-2xx (exponential 1,2,4,8,16 s / scale)');
  {
    const requestId = `probe-${randomUUID()}`;
    failFirstDeliveryFor.add(requestId);
    await admin('scenario', { payout: [[]] });
    await call('POST', '/payout/transfers', {
      requestId,
      type: 'IBAN',
      destination: VALID_IBAN,
      amount: '1000000',
      currency: 'IRR',
    });
    await sleep(10000);
    for (const w of webhooksFor(requestId)) {
      log(`  delivery status=${w.json.status} eventId=${w.json.eventId} at=+${((w.at - t0) / 1000).toFixed(2)}s`);
    }
  }

  section('E22 settlement CSV (raw, hex of first bytes shows the BOM)');
  {
    const today = new Date(Date.now() + 3.5 * 3600 * 1000).toISOString().slice(0, 10);
    const csv = await call('GET', `/psp/settlement?date=${today}`);
    // fetch's text() silently strips a UTF-8 BOM, so look at the raw bytes
    const raw = Buffer.from(await (await fetch(`${SIM}/psp/settlement?date=${today}`)).arrayBuffer());
    log(`first raw bytes (hex): ${raw.subarray(0, 8).toString('hex')}  (efbbbf = UTF-8 BOM)`);
    writeFileSync(join(OUT_DIR, 'settlement-sample.csv'), raw);
    log(`full CSV written to docs/evidence/settlement-sample.csv (${csv.text.split('\n').length} lines)`);
    const again = await call('GET', `/psp/settlement?date=${today}`);
    log(`second fetch identical: ${createHash('sha256').update(csv.text).digest('hex') === createHash('sha256').update(again.text).digest('hex')}`);
    await call('GET', `/psp/settlement?date=not-a-date`);
  }
}

async function hostileStatistics(): Promise<void> {
  section(`H hostile-mode statistics over ${SAMPLES} payments and ${SAMPLES} payouts (random chaos, no scenarios)`);
  if (ADMIN_KEY) await admin('chaos', { profile: 'hostile' });
  const tally: Record<string, number> = {};
  const inc = (k: string) => (tally[k] = (tally[k] ?? 0) + 1);

  const payments = await Promise.all(
    Array.from({ length: SAMPLES }, async () => {
      const orderId = `stat-${randomUUID().slice(0, 8)}`;
      const created = await call('POST', '/psp/payments', { amount: '500000', callbackUrl: `${HOOK_BASE}/callback`, orderId });
      const token = String(created.json.token);
      await call('POST', `/psp/pay/${token}`, { result: 'success' });
      return token;
    }),
  );
  const payouts = await Promise.all(
    Array.from({ length: SAMPLES }, async () => {
      const requestId = `stat-${randomUUID()}`;
      const r = await call('POST', '/payout/transfers', { requestId, type: 'IBAN', destination: VALID_IBAN, amount: '1000000', currency: 'IRR' }, 15000);
      if (r.status === 503) inc('payout POST 503');
      if (r.status === 0) inc('payout POST timeout/reset');
      return requestId;
    }),
  );
  log('waiting 40s for callbacks/webhooks...');
  await sleep(40000);
  for (const token of payments) {
    const cbs = callbacksFor(token);
    if (cbs.length === 0) inc('payment: callback missing');
    if (cbs.length > 1) inc('payment: duplicate callbacks');
    if (cbs[0]?.json.status === 'NOK') inc('payment: first callback NOK although PAID');
    if (cbs.some((c) => c.json.amount !== undefined)) inc('payment: forged amount in callback');
    const v = await call('POST', '/psp/verify', { token });
    if (v.status === 503) inc('payment: verify 503');
  }
  for (const id of payouts) {
    const whs = webhooksFor(id);
    const statuses = whs.map((w) => w.json.status);
    const ids = whs.map((w) => w.json.eventId);
    if (new Set(ids).size < ids.length) inc('payout: duplicate webhook delivery');
    if (whs.some((w) => w.signatureValid === false)) inc('payout: forged (bad signature) webhook');
    const finalIdx = statuses.findIndex((s) => s === 'SUCCEEDED' || s === 'FAILED');
    if (finalIdx >= 0 && statuses.slice(finalIdx + 1).includes('PROCESSING')) inc('payout: stale PROCESSING after final');
    if (!whs.some((w) => w.signatureValid && (w.json.status === 'SUCCEEDED' || w.json.status === 'FAILED'))) inc('payout: no signed final webhook (yet)');
    if (statuses.includes('RETURNED')) inc('payout: RETURNED after SUCCEEDED');
  }
  log('observed counts: ' + JSON.stringify(tally, null, 0));
  if (ADMIN_KEY) await admin('chaos', { profile: 'default' });
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(LOG, `# simulator probe ${new Date().toISOString()} SIM=${SIM} hooks=${HOOK_BASE}\n`);
  await startListener();
  await call('GET', '/health');
  await deterministic();
  await hostileStatistics();
  log('done');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
