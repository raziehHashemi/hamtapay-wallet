import { runHostile } from './support/hostile-run';

describe('E2E: hostile simulator (SIM_CHAOS=hostile)', () => {
  it('many users racing deposits, withdrawals and duplicate retries: every invariant holds', async () => {
    const report = await runHostile({ users: Number(process.env.HOSTILE_USERS ?? 15), log: console.log });
    console.log(JSON.stringify(report, null, 2));

    // each user: 2M funded, six 400k withdrawals racing -> at most 5 can be held; duplicates add nothing
    expect(report.withdrawals.created).toBeLessThanOrEqual(report.users * 5);
    expect(report.withdrawals.rejected.INSUFFICIENT_FUNDS ?? 0).toBeGreaterThanOrEqual(report.users);
    expect(report.withdrawals.open).toBe(0);
    expect(report.deposits.open).toBe(0);
    expect(report.providerCrossCheck.doublePayouts).toBe(0);
    expect(report.providerCrossCheck.paidButNotSucceeded).toEqual([]);
    expect(report.providerCrossCheck.succeededButNotPaid).toEqual([]);
    expect(report.integrity).toEqual({ ok: true, negativeBalances: 0, drift: 0, unbalanced: 0 });
    expect(report.negativeWallets).toEqual([]);
    expect(report.duplicateRetries.extraEffects).toBe(0);
    expect(report.outboxBacklog).toBe(0);
  });
});
