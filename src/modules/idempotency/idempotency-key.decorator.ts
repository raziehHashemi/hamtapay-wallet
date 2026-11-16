import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { Errors } from '../../common/errors/domain-error';

const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;

/** Extracts and validates the `Idempotency-Key` header (required on every money-moving POST). */
export const IdempotencyKey = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const request = ctx.switchToHttp().getRequest<Request>();
  const value = request.header('idempotency-key');
  if (!value || !KEY_PATTERN.test(value)) throw Errors.idempotencyKeyMissing();
  return value;
});
