import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { Currency } from '../../common/money/currency';
import { limitAmountInToman, normalizeDestination, toPayoutRequest } from './withdrawal-rules';
import { signWebhook, verifyWebhookSignature } from './webhook-signature';

describe('withdrawal rules', () => {
  describe('normalizeDestination', () => {
    it('normalises an IBAN for IRT', () => {
      expect(normalizeDestination(Currency.IRT, 'ir82 0540 1026 8002 0817 9090 02')).toBe(
        'IR820540102680020817909002',
      );
    });

    it.each<[Currency, unknown]>([
      [Currency.IRT, 'IR000000000000000000000000'],
      [Currency.IRT, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'],
      [Currency.USDT, 'IR820540102680020817909002'],
      [Currency.USDT, 'not-an-address'],
      [Currency.IRT, 12345],
    ])('rejects %s destination %p with INVALID_DESTINATION', (currency, destination) => {
      try {
        normalizeDestination(currency, destination);
        fail('expected an error');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(ErrorCode.INVALID_DESTINATION);
        expect((error as DomainError).httpStatus).toBe(400);
      }
    });
  });

  describe('limitAmountInToman (ambiguity #2)', () => {
    it('counts IRT as is', () => {
      expect(limitAmountInToman(Currency.IRT, 150_000_000n, 100_000n)).toBe(150_000_000n);
    });
    it('converts USDT at the configured rate', () => {
      expect(limitAmountInToman(Currency.USDT, 10_000_000n /* 10 USDT */, 100_000n)).toBe(1_000_000n);
    });
    it('rounds up so rounding can never help exceed the cap', () => {
      expect(limitAmountInToman(Currency.USDT, 1n /* 0.000001 USDT */, 100_000n)).toBe(1n);
      expect(limitAmountInToman(Currency.USDT, 10_000_001n, 100_000n)).toBe(1_000_001n);
    });
  });

  describe('toPayoutRequest', () => {
    it('sends IRT withdrawals as IBAN transfers in Rial (provider-notes §P1)', () => {
      expect(
        toPayoutRequest({
          id: 'w-1',
          currency: Currency.IRT,
          amount: 250_000n,
          destination: 'IR820540102680020817909002',
        }),
      ).toEqual({
        requestId: 'w-1',
        type: 'IBAN',
        destination: 'IR820540102680020817909002',
        amount: '2500000',
        currency: 'IRR',
      });
    });

    it('sends USDT withdrawals as CRYPTO decimal strings (fee is not part of the transfer)', () => {
      expect(
        toPayoutRequest({
          id: 'w-2',
          currency: Currency.USDT,
          amount: 12_500_000n,
          destination: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        }),
      ).toMatchObject({ type: 'CRYPTO', amount: '12.5', currency: 'USDT' });
    });
  });

  describe('webhook signature', () => {
    const secret = 'hamtapay-sim-secret';
    const body = '{"event":"transfer.updated","status":"SUCCEEDED"}';

    it('accepts HMAC-SHA256(rawBody) in hex', () => {
      expect(verifyWebhookSignature(Buffer.from(body), signWebhook(body, secret), secret)).toBe(true);
    });

    it('rejects a forged signature, a modified body, a wrong secret or a missing header', () => {
      const signature = signWebhook(body, secret);
      expect(verifyWebhookSignature(Buffer.from(body), 'ab'.repeat(32), secret)).toBe(false);
      expect(
        verifyWebhookSignature(Buffer.from(body.replace('SUCCEEDED', 'FAILED')), signature, secret),
      ).toBe(false);
      expect(verifyWebhookSignature(Buffer.from(body), signature, 'other')).toBe(false);
      expect(verifyWebhookSignature(Buffer.from(body), undefined, secret)).toBe(false);
      expect(verifyWebhookSignature(undefined, signature, secret)).toBe(false);
      expect(verifyWebhookSignature(Buffer.from(body), 'not-hex', secret)).toBe(false);
    });
  });
});
