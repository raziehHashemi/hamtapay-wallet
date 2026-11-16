/* Shared by the hostile E2E test and `npm run demo:hostile` (live demo for the presentation). */
import { randomUUID } from 'node:crypto';
import { api, fund, IBAN, isFinal, newUser, sim, SimPayout, waitUntil } from './e2e-client';

export interface HostileReport {
  users: number;
  deposits: { created: number; succeeded: number; failed: number; open: number };
  withdrawals: { created: number; rejected: Record<string, number>; succeeded: number; failed: number; open: number };
  duplicateRetries: { sent: number; extraEffects: number };
  providerCrossCheck: {
    transfers: number;
    doublePayouts: number;
    paidButNotSucceeded: string[];
    succeededButNotPaid: string[];
  };
  integrity: { ok: boolean; negativeBalances: number; drift: number; unbalanced: number };
  outboxBacklog: number;
  negativeWallets: string[];
  elapsedMs: number;
}

/**
 * Many users, in parallel, under SIM_CHAOS=hostile: deposits (paid on the PSP page), withdrawals racing on the
 * same balance, every withdrawal POST retried with the same Idempotency-Key. Then waits for everything to
 * settle and checks the invariants against our ledger AND the simulator's own record of executed transfers.
 */
export async function runHostile(options: { users: number; log?: (s: string) => void }): Promise<HostileReport> {
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  await sim.chaos('hostile');
  const users = Array.from({ length: options.users }, () => newUser('hostile'));
  const depositIds: string[] = [];
  const withdrawalIds = new Set<string>();
  const rejected: Record<string, number> = {};
  let duplicateRetries = 0;
  let extraEffects = 0;

  log(`hostile run: ${users.length} users`);
  await Promise.all(
    users.map(async (userId) => {
      await fund(userId, '2000000');
      // a real deposit through the PSP
      const created = await api.post('/deposits', { userId, amount: '300000' });
      if (created.status === 201) {
        depositIds.push(created.body.depositId);
        const token = String(created.body.paymentUrl).split('/').pop();
        await fetch(`${process.env.E2E_SIM_URL ?? 'http://localhost:8080'}/psp/pay/${token}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ result: 'success' }),
        });
      }
      // 6 concurrent withdrawals of 400k on a 2M balance (only 5 can be held), each sent twice with the same key
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          const k = randomUUID();
          const body = { userId, currency: 'IRT', amount: '400000', destination: IBAN };
          const [r1, r2] = await Promise.all([api.post('/withdrawals', body, k), api.post('/withdrawals', body, k)]);
          duplicateRetries++;
          if (r1.status === 201 && r2.status === 201 && r1.body.withdrawalId !== r2.body.withdrawalId) extraEffects++;
          for (const r of [r1, r2]) {
            if (r.status === 201) withdrawalIds.add(r.body.withdrawalId);
          }
          if (r1.status !== 201) rejected[r1.body.code] = (rejected[r1.body.code] ?? 0) + 1;
        }),
      );
    }),
  );
  log(`created ${depositIds.length} deposits, ${withdrawalIds.size} withdrawals; waiting for final states...`);

  const finalOf = async (path: string, ids: string[]) =>
    waitUntil(
      async () => Promise.all(ids.map(async (id) => (await api.get(`${path}/${id}`)).body)),
      (all) => all.every(isFinal),
      300000,
      2000,
    );
  const deposits = await finalOf('/deposits', depositIds);
  const withdrawals = await finalOf('/withdrawals', [...withdrawalIds]);

  const payouts: SimPayout[] = (await sim.payouts()).body;
  const byRequest = new Map<string, SimPayout[]>();
  for (const p of payouts) byRequest.set(p.requestId, [...(byRequest.get(p.requestId) ?? []), p]);
  const ours = withdrawals.filter((w) => w?.withdrawalId);
  const paidButNotSucceeded = ours
    .filter((w) => {
      const p = byRequest.get(w.withdrawalId)?.[0];
      return p && p.executed && p.status === 'SUCCEEDED' && w.status !== 'SUCCEEDED';
    })
    .map((w) => w.withdrawalId);
  const succeededButNotPaid = ours
    .filter((w) => w.status === 'SUCCEEDED' && !byRequest.get(w.withdrawalId)?.[0]?.executed)
    .map((w) => w.withdrawalId);

  const negativeWallets: string[] = [];
  for (const userId of users) {
    const wallet = (await api.get(`/wallets/${userId}`)).body;
    if (wallet.balances.some((b: { available: string; held: string }) => b.available.startsWith('-') || b.held.startsWith('-'))) {
      negativeWallets.push(userId);
    }
  }
  const integrity = (await api.get('/internal/ledger/integrity')).body;
  const health = await waitUntil(async () => (await api.get('/health')).body, (h) => h.outboxBacklog === 0, 30000);
  await sim.chaos('default');

  return {
    users: users.length,
    deposits: {
      created: depositIds.length,
      succeeded: deposits.filter((d) => d.status === 'SUCCEEDED').length,
      failed: deposits.filter((d) => d.status === 'FAILED').length,
      open: deposits.filter((d) => !isFinal(d)).length,
    },
    withdrawals: {
      created: withdrawalIds.size,
      rejected,
      succeeded: ours.filter((w) => w.status === 'SUCCEEDED').length,
      failed: ours.filter((w) => w.status === 'FAILED').length,
      open: ours.filter((w) => !isFinal(w)).length,
    },
    duplicateRetries: { sent: duplicateRetries, extraEffects },
    providerCrossCheck: {
      transfers: ours.filter((w) => byRequest.has(w.withdrawalId)).length,
      doublePayouts: [...byRequest.values()].filter((list) => list.length > 1).length,
      paidButNotSucceeded,
      succeededButNotPaid,
    },
    integrity: {
      ok: integrity.ok,
      negativeBalances: integrity.negativeBalances,
      drift: integrity.balanceDrift.length,
      unbalanced: integrity.unbalancedJournals.length,
    },
    outboxBacklog: health.outboxBacklog,
    negativeWallets,
    elapsedMs: Date.now() - started,
  };
}
