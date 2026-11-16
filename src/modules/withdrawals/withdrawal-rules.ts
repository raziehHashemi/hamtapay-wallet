import { Errors } from '../../common/errors/domain-error';
import { CURRENCY_SCALE, Currency } from '../../common/money/currency';
import { formatMinor } from '../../common/money/money';
import { normalizeIranianIban } from '../../common/validation/iban';
import { isValidTrc20Address } from '../../common/validation/trc20';
import type { PayoutRequest } from '../../integrations/payout/payout-gateway';
import { tomanToRial } from '../../common/money/money';

/**
 * IRT → IBAN (Sheba, validated with the ISO 13616 checksum). USDT → TRC20 address.
 * The provider accepts any non-empty destination and fails it *asynchronously* (INVALID_IBAN /
 * INVALID_ADDRESS, provider-notes §P4), which would hold the user's funds for nothing — so we reject up front.
 */
export function normalizeDestination(currency: Currency, destination: unknown): string {
  if (currency === Currency.IRT) {
    const iban = normalizeIranianIban(destination);
    if (!iban) throw Errors.invalidDestination('destination must be a valid Iranian IBAN (IR + 24 digits)');
    return iban;
  }
  if (!isValidTrc20Address(destination)) throw Errors.invalidDestination('destination must be a TRC20 address');
  return destination;
}

/**
 * Amount counted against the per-user daily cap, which is defined in Toman (ambiguity #2): USDT is
 * converted at the configured rate and rounded UP, so rounding can never let a user exceed the cap.
 */
export function limitAmountInToman(currency: Currency, amountMinor: bigint, usdtIrtRate: bigint): bigint {
  if (currency === Currency.IRT) return amountMinor;
  const scale = 10n ** BigInt(CURRENCY_SCALE[Currency.USDT]);
  const product = amountMinor * usdtIrtRate;
  return (product + scale - 1n) / scale;
}

/** Our withdrawal → provider transfer. Paya/IBAN transfers are in **Rial** (our API is Toman). */
export function toPayoutRequest(w: {
  id: string;
  currency: Currency;
  amount: bigint;
  destination: string;
}): PayoutRequest {
  if (w.currency === Currency.IRT) {
    return {
      requestId: w.id,
      type: 'IBAN',
      destination: w.destination,
      amount: tomanToRial(w.amount).toString(),
      currency: 'IRR',
    };
  }
  return {
    requestId: w.id,
    type: 'CRYPTO',
    destination: w.destination,
    amount: formatMinor(Currency.USDT, w.amount),
    currency: 'USDT',
  };
}
