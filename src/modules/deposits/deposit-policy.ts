import { RIAL_PER_TOMAN } from '../../common/money/money';
import { exponentialBackoffMs } from '../../common/util/backoff';
import type { VerifyOutcome } from '../../integrations/psp/payment-gateway';

/**
 * Pure decision rules for deposits (no I/O), derived from observed PSP behaviour (docs/provider-notes.md):
 *  - the callback is unauthenticated, can be missing, duplicated, out of order (NOK before OK) or forged
 *    (OK with a 10x amount) => it is only a trigger; truth comes from inquiry + verify;
 *  - `verify` on a payment that is not paid yet answers "FAILED" (-51) => we never call verify before the
 *    inquiry says PAID, otherwise a payer who pays a minute later would be lost;
 *  - a PAID payment that is not verified within 10 minutes is reversed by the PSP => verify promptly.
 */
export type InquiryDecision =
  | { action: 'WAIT' }
  | { action: 'VERIFY' }
  | { action: 'FAIL'; reason: string }
  | { action: 'ANOMALY'; reason: string };

export function decideOnInquiry(pspStatus: string | null): InquiryDecision {
  switch (pspStatus) {
    case 'INIT':
      return { action: 'WAIT' };
    case 'PAID':
    case 'VERIFIED':
      return { action: 'VERIFY' };
    case 'FAILED':
      return { action: 'FAIL', reason: 'PAYMENT_FAILED' };
    case 'REVERSED':
      return { action: 'FAIL', reason: 'PAYMENT_REVERSED' };
    case null:
      return { action: 'ANOMALY', reason: 'PSP_UNKNOWN_TOKEN' };
    default:
      return { action: 'ANOMALY', reason: `PSP_UNEXPECTED_STATUS_${pspStatus}` };
  }
}

export type VerifyDecision =
  | { action: 'CREDIT'; creditToman: bigint; refId: string; verifiedRial: bigint; anomaly: string | null }
  | { action: 'FAIL'; reason: string }
  | { action: 'RETRY'; reason: string };

/**
 * Credits exactly what the PSP verified (server-to-server), never what the callback claimed.
 * If the verified amount differs from the requested one we still credit what was really paid — "a paid
 * deposit must always be credited" and "never more than was paid" — and flag the deposit for review.
 */
export function decideOnVerify(expectedToman: bigint, outcome: VerifyOutcome): VerifyDecision {
  switch (outcome.kind) {
    case 'VERIFIED': {
      const creditToman = outcome.amountRial / RIAL_PER_TOMAN; // floor: never more than paid
      const expectedRial = expectedToman * RIAL_PER_TOMAN;
      if (creditToman <= 0n)
        return { action: 'RETRY', reason: `verified amount ${outcome.amountRial} is not creditable` };
      const anomaly =
        outcome.amountRial === expectedRial
          ? null
          : `AMOUNT_MISMATCH: requested ${expectedRial} IRR, verified ${outcome.amountRial} IRR`;
      return {
        action: 'CREDIT',
        creditToman,
        refId: outcome.refId,
        verifiedRial: outcome.amountRial,
        anomaly,
      };
    }
    case 'EXPIRED':
      return { action: 'FAIL', reason: 'PAYMENT_REVERSED' };
    case 'NOT_PAID':
      // Only reachable through a race with the inquiry; the next round re-reads the status.
      return { action: 'RETRY', reason: `verify answered ${outcome.code}` };
    case 'UNKNOWN_TOKEN':
      return { action: 'RETRY', reason: 'verify: unknown token' };
    case 'UNAVAILABLE':
      return { action: 'RETRY', reason: outcome.reason };
  }
}

export interface DepositPollingConfig {
  depositFirstCheckMs: number;
  depositPollCapMs: number;
  depositStopPollingAfterMs: number;
}

export const VERIFY_RETRY_MS = 3000;

/** When to look at an open deposit again; `null` = stop polling (callbacks are still honoured). */
export function nextDepositCheckDelayMs(
  state: { verifying: boolean; attempts: number; ageMs: number },
  config: DepositPollingConfig,
): number | null {
  if (state.verifying) return VERIFY_RETRY_MS; // the PSP reverses unverified payments after 10 minutes
  if (state.ageMs >= config.depositStopPollingAfterMs) return null;
  return exponentialBackoffMs(
    Math.max(0, state.attempts - 1),
    config.depositFirstCheckMs,
    config.depositPollCapMs,
  );
}
