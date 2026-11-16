import { ibanChecksumIsValid, normalizeIranianIban } from './iban';
import { isValidTrc20Address } from './trc20';
import { isValidUserId } from './user-id';

describe('Iranian IBAN (Sheba)', () => {
  it.each(['IR820540102680020817909002', 'IR062960000000100324200001'])('accepts %s', (iban) => {
    expect(normalizeIranianIban(iban)).toBe(iban);
  });

  it('normalises spacing, dashes, lower case and a missing IR prefix', () => {
    expect(normalizeIranianIban('ir82 0540 1026 8002 0817 9090 02')).toBe('IR820540102680020817909002');
    expect(normalizeIranianIban('IR82-0540-1026-8002-0817-9090-02')).toBe('IR820540102680020817909002');
    expect(normalizeIranianIban('820540102680020817909002')).toBe('IR820540102680020817909002');
  });

  it.each([
    'IR820540102680020817909003', // checksum broken (last digit)
    'IR000000000000000000000000', // the "zero" IBAN the provider only rejects asynchronously
    'IR82054010268002081790900', // 23 digits
    'DE89370400440532013000', // valid German IBAN, not Iranian
    'IRAB0540102680020817909002',
    '',
  ])('rejects %p', (iban) => {
    expect(normalizeIranianIban(iban)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeIranianIban(820540102680020817909002)).toBeNull();
    expect(normalizeIranianIban(null)).toBeNull();
  });

  it('implements ISO 13616 mod-97', () => {
    expect(ibanChecksumIsValid('GB82WEST12345698765432')).toBe(true);
    expect(ibanChecksumIsValid('GB82WEST12345698765431')).toBe(false);
  });
});

describe('TRC20 address', () => {
  it('accepts a base58 T-address', () => {
    expect(isValidTrc20Address('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
  });
  it.each([
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6', // too short
    'XR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', // wrong prefix
    'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj0t', // '0' is not base58
    '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', // ERC20
    'IR820540102680020817909002',
  ])('rejects %p', (address) => {
    expect(isValidTrc20Address(address)).toBe(false);
  });
});

describe('user id', () => {
  it.each(['user-42', '42', 'a.b_c:d@e', 'x'.repeat(64)])('accepts %p', (id) =>
    expect(isValidUserId(id)).toBe(true),
  );
  it.each(['', 'x'.repeat(65), 'has space', 'semi;colon', "quote'", 42])('rejects %p', (id) =>
    expect(isValidUserId(id)).toBe(false),
  );
});
