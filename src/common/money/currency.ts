export enum Currency {
  IRT = 'IRT',
  USDT = 'USDT',
}

export const SUPPORTED_CURRENCIES: readonly Currency[] = [Currency.IRT, Currency.USDT];

/** Number of decimal places stored for each currency. Amounts are kept as integer minor units. */
export const CURRENCY_SCALE: Readonly<Record<Currency, number>> = {
  [Currency.IRT]: 0, // integer Toman
  [Currency.USDT]: 6, // micro-USDT
};

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}
