import {
  PayoutCallResult,
  PayoutGateway,
  PayoutRequest,
  ProviderTransferStatus,
} from '../../src/integrations/payout/payout-gateway';

/** Behaviour for the next *creating* submit (observed on the real simulator, provider-notes §P2/§P3). */
export type SubmitBehaviour =
  | 'ok'
  /** 503, transfer NOT created */
  | 'e503-before'
  /** 503, transfer created anyway and hidden from GET */
  | 'e503-after'
  /** connection dropped, transfer created and hidden from GET */
  | 'timeout'
  /** 400 validation error, not created */
  | 'reject';

interface FakeTransfer {
  request: PayoutRequest;
  trackingId: string;
  status: ProviderTransferStatus;
  reason: string | null;
  hidden: boolean;
}

/**
 * In-memory payout provider. Like the real one it is idempotent by requestId (a re-submit returns the
 * existing transfer). `creations` counts how many distinct transfers were created per requestId — the
 * "never paid twice" assertions check it is never above 1.
 */
export class FakePayoutGateway extends PayoutGateway {
  readonly transfers = new Map<string, FakeTransfer>();
  readonly creations = new Map<string, number>();
  readonly submits: PayoutRequest[] = [];
  readonly gets: string[] = [];
  private behaviours: SubmitBehaviour[] = [];
  unknownForever = false;
  private seq = 0;

  queue(...behaviours: SubmitBehaviour[]): void {
    this.behaviours.push(...behaviours);
  }

  async submit(request: PayoutRequest): Promise<PayoutCallResult> {
    this.submits.push(request);
    if (this.unknownForever) return { kind: 'UNKNOWN', reason: 'timed out' };
    const existing = this.transfers.get(request.requestId);
    if (existing) return { kind: 'OK', transfer: this.view(existing) };
    const behaviour = this.behaviours.shift() ?? 'ok';
    if (behaviour === 'reject') return { kind: 'REJECTED', httpStatus: 400, error: 'INVALID_AMOUNT' };
    if (behaviour === 'e503-before') return { kind: 'UNKNOWN', reason: 'HTTP 503' };
    const transfer: FakeTransfer = {
      request,
      trackingId: `TRK${++this.seq}`,
      status: 'ACCEPTED',
      reason: null,
      hidden: behaviour !== 'ok',
    };
    this.transfers.set(request.requestId, transfer);
    this.creations.set(request.requestId, (this.creations.get(request.requestId) ?? 0) + 1);
    if (behaviour === 'e503-after') return { kind: 'UNKNOWN', reason: 'HTTP 503' };
    if (behaviour === 'timeout') return { kind: 'UNKNOWN', reason: 'timed out' };
    return { kind: 'OK', transfer: this.view(transfer) };
  }

  async getTransfer(requestId: string): Promise<PayoutCallResult> {
    this.gets.push(requestId);
    if (this.unknownForever) return { kind: 'UNKNOWN', reason: 'timed out' };
    const t = this.transfers.get(requestId);
    if (!t || t.hidden) return { kind: 'NOT_FOUND' };
    return { kind: 'OK', transfer: this.view(t) };
  }

  // ---- test controls ----
  complete(requestId: string, status: ProviderTransferStatus, reason: string | null = null): void {
    const t = this.transfers.get(requestId);
    if (!t) throw new Error(`no transfer ${requestId}`);
    t.status = status;
    t.reason = reason;
  }

  unhide(requestId: string): void {
    this.transfers.get(requestId)!.hidden = false;
  }

  maxCreationsPerRequest(): number {
    return Math.max(0, ...this.creations.values());
  }

  private view(t: FakeTransfer) {
    return {
      requestId: t.request.requestId,
      trackingId: t.trackingId,
      status: t.status,
      reason: t.reason,
      occurredAt: new Date().toISOString(),
    };
  }
}
