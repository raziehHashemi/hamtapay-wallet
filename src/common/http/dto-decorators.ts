import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches } from 'class-validator';
import { Currency, SUPPORTED_CURRENCIES } from '../money/currency';
import { NormalizeUserId, USER_ID_PATTERN } from '../validation/user-id';

export function UserIdField(description = 'Opaque user id; the wallet is created on first use'): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ example: 'user-42', description, pattern: USER_ID_PATTERN.source }),
    NormalizeUserId(),
    IsString({ message: 'userId must be a string' }),
    Matches(USER_ID_PATTERN, { message: 'userId must be 1-64 chars of [A-Za-z0-9._:@-]' }),
  );
}

export function CurrencyField(allowed: readonly Currency[] = SUPPORTED_CURRENCIES): PropertyDecorator {
  return applyDecorators(
    ApiProperty({ enum: allowed, example: allowed[0] }),
    Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value)),
    IsIn(allowed as Currency[], { message: `currency must be one of ${allowed.join(', ')}` }),
  );
}

export function AmountField(example = '250000'): PropertyDecorator {
  return applyDecorators(
    ApiProperty({
      example,
      description: 'Decimal string. IRT: integer Toman. USDT: up to 6 decimals. JSON numbers are rejected.',
    }),
    IsString({ message: 'amount must be a string (e.g. "250000")' }),
  );
}
