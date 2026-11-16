/* eslint-disable no-console */
/**
 * Live demo for the presentation: drives the running stack with the simulator in hostile mode and prints
 * an invariant report.
 *
 *   SIM_TIME_SCALE=10 docker compose up -d --build
 *   npm run demo:hostile                         # HOSTILE_USERS=25 npm run demo:hostile
 */
import { runHostile } from '../test/e2e/support/hostile-run';

async function main(): Promise<void> {
  const report = await runHostile({ users: Number(process.env.HOSTILE_USERS ?? 20), log: (s) => console.log(`> ${s}`) });
  const ok =
    report.providerCrossCheck.doublePayouts === 0 &&
    report.providerCrossCheck.paidButNotSucceeded.length === 0 &&
    report.providerCrossCheck.succeededButNotPaid.length === 0 &&
    report.integrity.ok &&
    report.negativeWallets.length === 0 &&
    report.withdrawals.open === 0;
  console.log('\n=== hostile run report ===');
  console.table({
    users: report.users,
    'deposits succeeded/failed/open': `${report.deposits.succeeded}/${report.deposits.failed}/${report.deposits.open}`,
    'withdrawals created': report.withdrawals.created,
    'withdrawals rejected': JSON.stringify(report.withdrawals.rejected),
    'withdrawals succeeded/failed/open': `${report.withdrawals.succeeded}/${report.withdrawals.failed}/${report.withdrawals.open}`,
    'double payouts at provider': report.providerCrossCheck.doublePayouts,
    'paid but not SUCCEEDED here': report.providerCrossCheck.paidButNotSucceeded.length,
    'SUCCEEDED here but not paid': report.providerCrossCheck.succeededButNotPaid.length,
    'ledger integrity': report.integrity.ok ? 'OK' : JSON.stringify(report.integrity),
    'negative wallets': report.negativeWallets.length,
    'outbox backlog': report.outboxBacklog,
    'elapsed (s)': Math.round(report.elapsedMs / 1000),
  });
  console.log(ok ? '\nALL INVARIANTS HOLD' : '\nINVARIANT VIOLATION — see report above');
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
