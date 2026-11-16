/* Black-box client for the running docker compose stack (no imports from src/: tests the deployed system). */
import { randomUUID } from 'node:crypto';

export const E2E = {
  base: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
  sim: process.env.E2E_SIM_URL ?? 'http://localhost:8080',
  adminKey: process.env.SIM_ADMIN_KEY ?? 'local-admin-key',
  internalKey: process.env.INTERNAL_API_KEY ?? '',
};

export const IBAN = 'IR820540102680020817909002';
export const TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

async function http<T>(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Res<T>> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed as T, headers: res.headers };
}

export const api = {
  get: <T = any>(path: string) =>
    http<T>(
      `${E2E.base}${path}`,
      'GET',
      undefined,
      E2E.internalKey ? { 'x-internal-api-key': E2E.internalKey } : {},
    ),
  post: <T = any>(path: string, body: unknown, idempotencyKey: string | null = randomUUID()) =>
    http<T>(`${E2E.base}${path}`, 'POST', body, {
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      ...(E2E.internalKey ? { 'x-internal-api-key': E2E.internalKey } : {}),
    }),
};

export const sim = {
  get: <T = any>(path: string) =>
    http<T>(`${E2E.sim}${path}`, 'GET', undefined, { 'x-admin-key': E2E.adminKey }),
  post: <T = any>(path: string, body: unknown) =>
    http<T>(`${E2E.sim}${path}`, 'POST', body, { 'x-admin-key': E2E.adminKey }),
  chaos: (profile: 'off' | 'default' | 'hostile') => sim.post('/__admin/chaos', { profile }),
  /** Queue a deterministic behaviour for the NEXT payment / payout the simulator creates. */
  scenario: (kind: 'payment' | 'payout', flags: string[]) =>
    sim.post('/__admin/scenario', { [kind]: [flags] }),
  payouts: () => sim.get<SimPayout[]>('/__admin/payouts'),
  config: () => sim.get<{ chaos: string; scale: number }>('/__admin/config'),
};

export interface SimPayout {
  requestId: string;
  trackingId: string;
  status: string;
  amount: string;
  currency: string;
  executed: boolean;
  events: string[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil<T>(
  probe: () => Promise<T>,
  done: (v: T) => boolean,
  timeoutMs = 120000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!done(last) && Date.now() < deadline) {
    await sleep(everyMs);
    last = await probe();
  }
  return last;
}

export const isFinal = (s: { status?: string }) => s?.status === 'SUCCEEDED' || s?.status === 'FAILED';

export async function fund(userId: string, amount: string, currency = 'IRT') {
  const res = await api.post('/internal/adjustments', { userId, currency, amount, reason: 'e2e funding' });
  if (res.status !== 201) throw new Error(`funding failed: ${res.status} ${JSON.stringify(res.body)}`);
}

export async function balance(userId: string, currency = 'IRT') {
  const res = await api.get(`/wallets/${userId}`);
  return res.body.balances.find((b: { currency: string }) => b.currency === currency);
}

/** Creates a deposit and makes the payer act on the simulator's payment page. */
export async function payDeposit(userId: string, amount: string, result: 'success' | 'fail' = 'success') {
  const created = await api.post('/deposits', { userId, amount });
  if (created.status !== 201)
    throw new Error(`deposit failed: ${created.status} ${JSON.stringify(created.body)}`);
  const token = String(created.body.paymentUrl).split('/').pop()!;
  const page = await http<{ display: string; amount: string }>(`${E2E.sim}/psp/pay/${token}`, 'GET');
  const paid = await http(`${E2E.sim}/psp/pay/${token}`, 'POST', { result });
  return { depositId: created.body.depositId as string, token, page, paid };
}

export const waitDeposit = (id: string, timeoutMs?: number) =>
  waitUntil(async () => (await api.get(`/deposits/${id}`)).body, isFinal, timeoutMs);
export const waitWithdrawal = (id: string, timeoutMs?: number) =>
  waitUntil(async () => (await api.get(`/withdrawals/${id}`)).body, isFinal, timeoutMs);

export const newUser = (prefix = 'e2e') => `${prefix}-${randomUUID().slice(0, 10)}`;
