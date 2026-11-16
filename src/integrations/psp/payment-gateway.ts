/**
 * Port for the payment gateway (PSP). Amounts at this boundary are in **Rial**, as on every Iranian rail;
 * the service converts from/to Toman at the edge.
 */
export type PspPaymentStatus = 'INIT' | 'PAID' | 'FAILED' | 'VERIFIED' | 'REVERSED';

export interface CreatePaymentCommand {
  amountRial: bigint;
  orderId: string;
  callbackUrl: string;
}

export interface CreatedPayment {
  token: string;
  paymentUrl: string;
}

export interface PaymentInquiry {
  token: string;
  orderId: string | null;
  status: PspPaymentStatus | string;
  amountRial: bigint;
  refId: string | null;
}

export type VerifyOutcome =
  | { kind: 'VERIFIED'; amountRial: bigint; refId: string; alreadyVerified: boolean }
  | { kind: 'NOT_PAID'; code: number; message: string }
  | { kind: 'EXPIRED'; code: number; message: string }
  | { kind: 'UNKNOWN_TOKEN' }
  | { kind: 'UNAVAILABLE'; reason: string };

/** Transport error or 5xx: the call may be retried. */
export class PaymentGatewayUnavailableError extends Error {}
/** 4xx: the PSP rejected the request; retrying the same request will not help. */
export class PaymentGatewayRejectedError extends Error {
  constructor(
    message: string,
    readonly pspCode: unknown,
  ) {
    super(message);
  }
}

export abstract class PaymentGateway {
  abstract createPayment(command: CreatePaymentCommand): Promise<CreatedPayment>;
  /** `null` when the PSP does not know the token. */
  abstract inquire(token: string): Promise<PaymentInquiry | null>;
  abstract verify(token: string): Promise<VerifyOutcome>;
  abstract fetchSettlementCsv(date: string): Promise<string>;
}
