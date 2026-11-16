/** Port for the payout provider (bank transfer to IBAN / on-chain TRC20). */
export type ProviderTransferStatus = 'ACCEPTED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'RETURNED';

export interface PayoutRequest {
  /** Our withdrawal id. Deterministic, so every retry of the same withdrawal is the same provider transfer. */
  requestId: string;
  type: 'IBAN' | 'CRYPTO';
  destination: string;
  /** IBAN: integer Rial. CRYPTO: USDT decimal string. */
  amount: string;
  currency: 'IRR' | 'USDT';
}

export interface ProviderTransfer {
  requestId: string;
  trackingId: string | null;
  status: ProviderTransferStatus;
  reason: string | null;
  /** When the provider says the status changed (used as the event time). */
  occurredAt: string | null;
}

export type PayoutCallResult =
  | { kind: 'OK'; transfer: ProviderTransfer }
  /** Definitive rejection: the transfer was NOT created (validation error). Safe to fail the withdrawal. */
  | { kind: 'REJECTED'; httpStatus: number; error: string }
  | { kind: 'NOT_FOUND' }
  /** 5xx, timeout, connection reset: the outcome is UNKNOWN. Never treat as failure. */
  | { kind: 'UNKNOWN'; reason: string };

export abstract class PayoutGateway {
  /** Idempotent by `requestId`: re-submitting returns the existing transfer instead of creating another. */
  abstract submit(request: PayoutRequest): Promise<PayoutCallResult>;
  abstract getTransfer(requestId: string): Promise<PayoutCallResult>;
}

export const PROVIDER_STATUSES: readonly ProviderTransferStatus[] = [
  'ACCEPTED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'RETURNED',
];

export function isProviderStatus(value: unknown): value is ProviderTransferStatus {
  return typeof value === 'string' && (PROVIDER_STATUSES as readonly string[]).includes(value);
}
