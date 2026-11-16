import { Transform } from 'class-transformer';

/** User ids are opaque strings from the identity service (no registration here). */
export const USER_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,64}$/;

/** Accepts a JSON string, or a safe integer that is turned into its string form. */
export function NormalizeUserId(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value,
  );
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}
