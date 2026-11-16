import { Errors } from '../errors/domain-error';
import { Currency } from '../money/currency';
import { InvalidAmountError, Money } from '../money/money';

/** Parses a request amount; malformed input becomes a 400 VALIDATION_ERROR with a precise message. */
export function parseAmount(currency: Currency, value: unknown, field = 'amount'): Money {
  try {
    return Money.parse(currency, value);
  } catch (error) {
    if (error instanceof InvalidAmountError) throw Errors.validation(`${field}: ${error.message}`);
    throw error;
  }
}

export function parsePositiveAmount(currency: Currency, value: unknown, field = 'amount'): Money {
  const money = parseAmount(currency, value, field);
  if (!money.isPositive()) throw Errors.validation(`${field} must be greater than zero`);
  return money;
}
