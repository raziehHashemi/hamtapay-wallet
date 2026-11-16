/* eslint-disable no-console */
/**
 * Key property #5 live: "if the service dies at any step of a withdrawal and restarts, no withdrawal stays in an
 * unknown state and none is paid twice". Creates withdrawals, SIGKILLs every API replica while they are in flight
 * (provider webhooks are lost meanwhile), restarts them and checks the outcome against the simulator's records.
 *
 *   SIM_TIME_SCALE=10 docker compose up -d --build
 *   npm run demo:crash
 */
import { execSync } from 'node:child_process';
import { api, fund, IBAN, isFinal, newUser, sim, sleep, waitUntil } from '../test/e2e/support/e2e-client';

const COUNT = Number(process.env.CRASH_WITHDRAWALS ?? 40);
const compose = (args: string) => execSync(`docker compose ${args}`, { stdio: 'pipe' }).toString().trim();

async function main(): Promise<void> {
  await sim.chaos('hostile');
  const userId = newUser('crash');
  await fund(userId, String(COUNT * 200_000));
  const ids: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const res = await api.post('/withdrawals', { userId, currency: 'IRT', amount: '200000', destination: IBAN });
    if (res.status === 201) ids.push(res.body.withdrawalId);
  }
  const statusesAtCrash = await Promise.all(
    ids.map(async (id) => {
      try {
        return (await api.get(`/withdrawals/${id}`)).body.status ?? 'unreachable';
      } catch {
        return 'unreachable';
      }
    }),
  );
  console.log(`> created ${ids.length} withdrawals; killing every wallet-api replica (SIGKILL)...`);
  compose('kill -s SIGKILL wallet-api');
  console.log(`> API down. Provider keeps working and its webhooks fail for ~8s...`);
  await sleep(8000);
  console.log('> restarting wallet-api replicas');
  compose('up -d wallet-api');
  await waitUntil(
    async () => {
      try {
        return (await api.get('/health')).status;
      } catch {
        return 0;
      }
    },
    (s) => s === 200,
    120000,
    1000,
  );
  console.log('> back up; waiting for every withdrawal to reach a final state');
  const finals = await waitUntil(
    async () => Promise.all(ids.map(async (id) => (await api.get(`/withdrawals/${id}`)).body)),
    (all) => all.every(isFinal),
    300000,
    2000,
  );
  const payouts = (await sim.payouts()).body;
  const perRequest = new Map<string, number>();
  for (const p of payouts) perRequest.set(p.requestId, (perRequest.get(p.requestId) ?? 0) + 1);
  const mismatched = finals.filter((w) => {
    const p = payouts.find((x) => x.requestId === w.withdrawalId);
    if (!p) return w.status !== 'FAILED';
    if (p.status === 'SUCCEEDED') return w.status !== 'SUCCEEDED';
    return w.status !== 'FAILED';
  });
  const integrity = (await api.get('/internal/ledger/integrity')).body;
  await sim.chaos('default');

  const report = {
    withdrawals: ids.length,
    'status when killed': JSON.stringify(
      statusesAtCrash.reduce<Record<string, number>>((a, s) => ({ ...a, [s]: (a[s] ?? 0) + 1 }), {}),
    ),
    'final SUCCEEDED': finals.filter((w) => w.status === 'SUCCEEDED').length,
    'final FAILED': finals.filter((w) => w.status === 'FAILED').length,
    'left non-final': finals.filter((w) => !isFinal(w)).length,
    'requestIds paid twice': [...perRequest.values()].filter((n) => n > 1).length,
    'our status != provider status': mismatched.length,
    'ledger integrity': integrity.ok ? 'OK' : 'BROKEN',
  };
  console.table(report);
  const ok = report['left non-final'] === 0 && report['requestIds paid twice'] === 0 && mismatched.length === 0 && integrity.ok;
  console.log(ok ? '\nRECOVERED: nothing lost, nothing paid twice' : '\nFAILED: see report');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
