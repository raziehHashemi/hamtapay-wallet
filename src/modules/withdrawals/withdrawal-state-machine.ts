import type { ProviderTransferStatus } from '../../integrations/payout/payout-gateway';
import { WithdrawalStatus } from './withdrawal.entity';

export const FAILURE_PREFIX = {
  CANCELLED: 'CANCELLED_BY_USER',
  REJECTED: 'PROVIDER_REJECTED',
  FAILED: 'PROVIDER_FAILED',
  RETURNED: 'RETURNED',
} as const;

export interface WithdrawalView {
  status: WithdrawalStatus;
  failureReason: string | null;
}

export type Transition =
  /** Duplicate, stale or out-of-order signal: nothing to do. */
  | { kind: 'NOOP' }
  /** Still in flight; remember what the provider said. */
  | { kind: 'TRACK' }
  /** Hold → paid out. */
  | { kind: 'SUCCEED' }
  /** Hold → back to available. */
  | { kind: 'FAIL'; reason: string }
  /** Paid out, then bounced: (settle first if we never saw the success) + refund. */
  | { kind: 'RETURN'; reason: string; settleFirst: boolean }
  /** We had released the funds, the provider now says the money left (ambiguity #1). */
  | { kind: 'LATE_SUCCESS' }
  /** Contradicts a final state in a way we refuse to auto-apply; flag for a human. */
  | { kind: 'ANOMALY'; note: string };

/**
 * Pure transition table for provider observations (webhook, poll, or submit response).
 *
 * Properties:
 *  - monotonic: a final state is never regressed by a stale PROCESSING/ACCEPTED (provider sends those);
 *  - idempotent: applying the same observation twice is a NOOP the second time;
 *  - silence never fails a withdrawal: only an explicit FAILED/RETURNED from the provider (or a user cancel
 *    before submission) releases funds.
 */
export function decideTransition(
  current: WithdrawalView,
  observed: ProviderTransferStatus,
  reason: string | null,
): Transition {
  const providerReason = reason ?? 'UNSPECIFIED';
  switch (current.status) {
    case WithdrawalStatus.PENDING:
    case WithdrawalStatus.PROCESSING:
      switch (observed) {
        case 'ACCEPTED':
        case 'PROCESSING':
          return { kind: 'TRACK' };
        case 'SUCCEEDED':
          return { kind: 'SUCCEED' };
        case 'FAILED':
          return { kind: 'FAIL', reason: `${FAILURE_PREFIX.FAILED}:${providerReason}` };
        case 'RETURNED':
          return { kind: 'RETURN', reason: `${FAILURE_PREFIX.RETURNED}:${providerReason}`, settleFirst: true };
      }
      break;

    case WithdrawalStatus.SUCCEEDED:
      switch (observed) {
        case 'RETURNED':
          return { kind: 'RETURN', reason: `${FAILURE_PREFIX.RETURNED}:${providerReason}`, settleFirst: false };
        case 'FAILED':
          return { kind: 'ANOMALY', note: 'provider reported FAILED (signed) after SUCCEEDED' };
        default:
          return { kind: 'NOOP' };
      }

    case WithdrawalStatus.FAILED: {
      const wasReturned = current.failureReason?.startsWith(FAILURE_PREFIX.RETURNED) ?? false;
      if (wasReturned) return { kind: 'NOOP' };
      switch (observed) {
        case 'SUCCEEDED':
          return { kind: 'LATE_SUCCESS' };
        case 'RETURNED':
          return { kind: 'ANOMALY', note: 'provider reported RETURNED for a withdrawal we had failed' };
        default:
          return { kind: 'NOOP' };
      }
    }
  }
  return { kind: 'NOOP' };
}

const PROVIDER_RANK: Record<ProviderTransferStatus, number> = {
  ACCEPTED: 1,
  PROCESSING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  RETURNED: 4,
};

/** Keeps `provider_status` monotonic as well (stale webhooks arrive after the final one). */
export function isNewerProviderStatus(previous: string | null, next: ProviderTransferStatus): boolean {
  if (!previous) return true;
  const prev = PROVIDER_RANK[previous as ProviderTransferStatus] ?? 0;
  return PROVIDER_RANK[next] > prev;
}
