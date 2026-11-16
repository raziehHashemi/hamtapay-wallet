import { CURRENCY_SCALE, Currency } from './currency';

/** Upper bound for a single amount (in minor units). Keeps every sum far away from BIGINT overflow. */
export const MAX_MINOR_UNITS = 10n ** 15n;

const INTEGER_PATTERN = /^\d+$/;
const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export class InvalidAmountError extends Error {}

/**
 * Immutable money value. The amount is an integer number of minor units held in a `bigint`,
 * so no arithmetic in the service ever goes through IEEE-754 floating point.
 */
export class Money {
  private constructor(
    readonly currency: Currency,
    readonly minor: bigint,
  ) {}

  static of(currency: Currency, minor: bigint): Money {
    return new Money(currency, minor);
  }

  static zero(currency: Currency): Money {
    return new Money(currency, 0n);
  }

  /**
   * Parses the API string representation. IRT must be an integer (Toman); USDT may carry up to 6 decimals.
   * Signs, exponents, separators, whitespace and JSON numbers are all rejected on purpose.
   */
  static parse(currency: Currency, value: unknown): Money {
    if (typeof value !== 'string') {
      throw new InvalidAmountError('amount must be a string');
    }
    const scale = CURRENCY_SCALE[currency];
    if (scale === 0) {
      if (!INTEGER_PATTERN.test(value)) {
        throw new InvalidAmountError(`amount must be an integer string for ${currency}`);
      }
      return Money.bounded(currency, BigInt(value));
    }
    const match = DECIMAL_PATTERN.exec(value);
    if (!match) {
      throw new InvalidAmountError(`amount must be a decimal string for ${currency}`);
    }
    const [, whole, fraction = ''] = match;
    if (fraction.length > scale) {
      throw new InvalidAmountError(`${currency} supports at most ${scale} decimal places`);
    }
    const minor = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0');
    return Money.bounded(currency, minor);
  }

  private static bounded(currency: Currency, minor: bigint): Money {
    if (minor > MAX_MINOR_UNITS) {
      throw new InvalidAmountError('amount is too large');
    }
    return new Money(currency, minor);
  }

  plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.minor + other.minor);
  }

  minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.currency, this.minor - other.minor);
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  lessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minor === other.minor;
  }

  /** Canonical API string: integer for IRT, trimmed decimal for USDT ("10.5", "0.000001", "12"). */
  toString(): string {
    return formatMinor(this.currency, this.minor);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new Error(`currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

export function formatMinor(currency: Currency, minor: bigint): string {
  const scale = CURRENCY_SCALE[currency];
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (scale === 0) {
    return `${negative ? '-' : ''}${abs.toString()}`;
  }
  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

/** Toman → Rial. External Iranian rails (PSP, Paya/IBAN payouts, settlement files) speak Rial. */
export const RIAL_PER_TOMAN = 10n;

export function tomanToRial(toman: bigint): bigint {
  return toman * RIAL_PER_TOMAN;
}
