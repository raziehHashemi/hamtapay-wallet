import { HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes';

/**
 * Expected, business-level failure. Rendered as `{ code, message }` by the global exception filter.
 *
 * `replayable` errors are outcomes of executing a request (e.g. INSUFFICIENT_FUNDS): they are stored with the
 * Idempotency-Key so that a retry with the same key gets the very same answer. Transient failures
 * (gateway down) are not replayable — the client must be able to retry them.
 */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly replayable = true,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  toBody(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

export const Errors = {
  validation: (message: string) =>
    new DomainError(ErrorCode.VALIDATION_ERROR, message, HttpStatus.BAD_REQUEST),
  invalidDestination: (message = 'destination is not a valid IBAN / TRC20 address') =>
    new DomainError(ErrorCode.INVALID_DESTINATION, message, HttpStatus.BAD_REQUEST),
  insufficientFunds: (message = 'available balance is not enough for this operation') =>
    new DomainError(ErrorCode.INSUFFICIENT_FUNDS, message, HttpStatus.UNPROCESSABLE_ENTITY),
  dailyLimitExceeded: (message = 'daily withdrawal limit would be exceeded') =>
    new DomainError(ErrorCode.DAILY_LIMIT_EXCEEDED, message, HttpStatus.UNPROCESSABLE_ENTITY),
  belowMinimum: (message: string) =>
    new DomainError(ErrorCode.BELOW_MINIMUM, message, HttpStatus.UNPROCESSABLE_ENTITY),
  idempotencyKeyReused: () =>
    new DomainError(
      ErrorCode.IDEMPOTENCY_KEY_REUSED,
      'this Idempotency-Key was already used with a different request body',
      HttpStatus.UNPROCESSABLE_ENTITY,
      false,
    ),
  idempotencyInProgress: () =>
    new DomainError(
      ErrorCode.IDEMPOTENCY_IN_PROGRESS,
      'a request with this Idempotency-Key is still being processed',
      HttpStatus.CONFLICT,
      false,
    ),
  idempotencyKeyMissing: () =>
    new DomainError(
      ErrorCode.IDEMPOTENCY_KEY_MISSING,
      'Idempotency-Key header is required (1-255 printable ASCII characters)',
      HttpStatus.BAD_REQUEST,
      false,
    ),
  notFound: (what: string) => new DomainError(ErrorCode.NOT_FOUND, `${what} not found`, HttpStatus.NOT_FOUND),
  notCancellable: (status: string) =>
    new DomainError(
      ErrorCode.WITHDRAWAL_NOT_CANCELLABLE,
      `withdrawal can only be cancelled before it is sent to the payout provider (current status: ${status})`,
      HttpStatus.CONFLICT,
    ),
  accountRestricted: (message: string) =>
    new DomainError(ErrorCode.ACCOUNT_RESTRICTED, message, HttpStatus.UNPROCESSABLE_ENTITY),
  alreadyReversed: () =>
    new DomainError(ErrorCode.ALREADY_REVERSED, 'this adjustment was already reversed', HttpStatus.CONFLICT),
  invalidSignature: () =>
    new DomainError(ErrorCode.INVALID_SIGNATURE, 'webhook signature is invalid', HttpStatus.UNAUTHORIZED, false),
  unauthorized: () =>
    new DomainError(ErrorCode.UNAUTHORIZED, 'missing or invalid internal API key', HttpStatus.UNAUTHORIZED, false),
  gatewayUnavailable: (message = 'payment gateway is temporarily unavailable, retry with the same key') =>
    new DomainError(ErrorCode.GATEWAY_UNAVAILABLE, message, HttpStatus.BAD_GATEWAY, false),
};
