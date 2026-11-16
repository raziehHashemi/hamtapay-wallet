import {
  CreatedPayment,
  CreatePaymentCommand,
  PaymentGateway,
  PaymentGatewayUnavailableError,
  PaymentInquiry,
  VerifyOutcome,
} from '../../src/integrations/psp/payment-gateway';

type Status = 'INIT' | 'PAID' | 'FAILED' | 'VERIFIED' | 'REVERSED';

interface FakePayment {
  token: string;
  orderId: string;
  amountRial: bigint;
  status: Status;
  refId: string | null;
  verifyAmountOverride?: bigint;
}

/**
 * In-memory PSP reproducing the behaviours observed on the real simulator (docs/provider-notes.md):
 * verify on an unpaid payment answers NOT_PAID (-51), verify is idempotent (ALREADY_VERIFIED), a reversed
 * payment answers EXPIRED (-54), verify can fail with 503 once.
 */
export class FakePaymentGateway extends PaymentGateway {
  readonly payments = new Map<string, FakePayment>();
  readonly calls = { create: 0, inquire: 0, verify: 0 };
  createFails = false;
  inquiryFails = false;
  verify503Once = new Set<string>();
  settlementCsv = '';
  private seq = 0;

  async createPayment(command: CreatePaymentCommand): Promise<CreatedPayment> {
    this.calls.create++;
    if (this.createFails) throw new PaymentGatewayUnavailableError('PSP create returned 503');
    const token = `T${++this.seq}${Date.now().toString(36)}`;
    this.payments.set(token, {
      token,
      orderId: command.orderId,
      amountRial: command.amountRial,
      status: 'INIT',
      refId: null,
    });
    return { token, paymentUrl: `http://psp.test/pay/${token}` };
  }

  async inquire(token: string): Promise<PaymentInquiry | null> {
    this.calls.inquire++;
    if (this.inquiryFails) throw new PaymentGatewayUnavailableError('inquiry down');
    const p = this.payments.get(token);
    return p ? { token, orderId: p.orderId, status: p.status, amountRial: p.amountRial, refId: p.refId } : null;
  }

  async verify(token: string): Promise<VerifyOutcome> {
    this.calls.verify++;
    const p = this.payments.get(token);
    if (!p) return { kind: 'UNKNOWN_TOKEN' };
    if (this.verify503Once.delete(token)) return { kind: 'UNAVAILABLE', reason: 'verify returned HTTP 503' };
    const amountRial = p.verifyAmountOverride ?? p.amountRial;
    if (p.status === 'VERIFIED') return { kind: 'VERIFIED', amountRial, refId: p.refId!, alreadyVerified: true };
    if (p.status === 'PAID') {
      p.status = 'VERIFIED';
      return { kind: 'VERIFIED', amountRial, refId: p.refId!, alreadyVerified: false };
    }
    if (p.status === 'REVERSED') return { kind: 'EXPIRED', code: -54, message: 'reversed' };
    return { kind: 'NOT_PAID', code: -51, message: 'payment not successful' };
  }

  async fetchSettlementCsv(): Promise<string> {
    return this.settlementCsv;
  }

  // ---- test controls ----
  tokenFromUrl(paymentUrl: string): string {
    return paymentUrl.split('/').pop()!;
  }

  pay(token: string, result: 'success' | 'fail' = 'success'): void {
    const p = this.payments.get(token)!;
    if (p.status !== 'INIT') throw new Error('already processed');
    p.status = result === 'success' ? 'PAID' : 'FAILED';
    if (p.status === 'PAID') p.refId = String(1_000_000_000 + this.payments.size);
  }

  reverse(token: string): void {
    this.payments.get(token)!.status = 'REVERSED';
  }
}
