import { Currency } from './currency';
import { formatMinor, InvalidAmountError, MAX_MINOR_UNITS, Money, tomanToRial } from './money';

describe('Money', () => {
  describe('parse IRT (integer Toman)', () => {
    it.each([
      ['0', 0n],
      ['1', 1n],
      ['100000', 100000n],
      ['200000000', 200000000n],
      ['000123', 123n],
    ])('parses %s', (input, expected) => {
      expect(Money.parse(Currency.IRT, input).minor).toBe(expected);
    });

    it.each(['1.5', '1.0', '-1', '+1', '1e5', ' 100', '100 ', '1,000', '', '۱۰۰', '0x10', 'NaN'])(
      'rejects %p',
      (input) => {
        expect(() => Money.parse(Currency.IRT, input)).toThrow(InvalidAmountError);
      },
    );

    it('rejects JSON numbers (floats are never accepted for money)', () => {
      expect(() => Money.parse(Currency.IRT, 100000)).toThrow('amount must be a string');
      expect(() => Money.parse(Currency.IRT, 0.1 + 0.2)).toThrow(InvalidAmountError);
    });

    it('rejects absurdly large amounts', () => {
      expect(() => Money.parse(Currency.IRT, (MAX_MINOR_UNITS + 1n).toString())).toThrow('too large');
    });
  });

  describe('parse USDT (6 decimals)', () => {
    it.each([
      ['10', 10_000_000n],
      ['10.5', 10_500_000n],
      ['0.000001', 1n],
      ['1.123456', 1_123_456n],
      ['12.10', 12_100_000n],
    ])('parses %s', (input, expected) => {
      expect(Money.parse(Currency.USDT, input).minor).toBe(expected);
    });

    it.each(['1.1234567', '.5', '5.', '-0.1', '1,5', '1e-6'])('rejects %p', (input) => {
      expect(() => Money.parse(Currency.USDT, input)).toThrow(InvalidAmountError);
    });

    it('is exact where binary floating point is not', () => {
      const a = Money.parse(Currency.USDT, '0.1');
      const b = Money.parse(Currency.USDT, '0.2');
      expect(a.plus(b).toString()).toBe('0.3');
    });
  });

  it('formats canonically', () => {
    expect(formatMinor(Currency.USDT, 10_500_000n)).toBe('10.5');
    expect(formatMinor(Currency.USDT, 1n)).toBe('0.000001');
    expect(formatMinor(Currency.USDT, 12_000_000n)).toBe('12');
    expect(formatMinor(Currency.USDT, -1_500_000n)).toBe('-1.5');
    expect(formatMinor(Currency.IRT, 250000n)).toBe('250000');
    expect(Money.parse(Currency.USDT, '010.500').toString()).toBe('10.5');
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of(Currency.IRT, 1n).plus(Money.of(Currency.USDT, 1n))).toThrow('currency mismatch');
  });

  it('compares and checks sign', () => {
    const ten = Money.of(Currency.IRT, 10n);
    expect(ten.isPositive()).toBe(true);
    expect(Money.zero(Currency.IRT).isZero()).toBe(true);
    expect(ten.minus(Money.of(Currency.IRT, 11n)).minor).toBe(-1n);
    expect(Money.of(Currency.IRT, 9n).lessThan(ten)).toBe(true);
    expect(ten.equals(Money.of(Currency.IRT, 10n))).toBe(true);
  });

  it('converts Toman to Rial for Iranian rails (x10)', () => {
    expect(tomanToRial(100_000n)).toBe(1_000_000n);
  });
});
