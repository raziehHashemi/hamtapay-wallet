const IRANIAN_IBAN = /^IR\d{24}$/;

/**
 * Normalises an Iranian IBAN (Sheba): strips whitespace/dashes, upper-cases, and accepts the 24 digits
 * without the `IR` prefix. Returns `null` when the value is not a structurally valid IBAN with a correct
 * ISO 13616 mod-97 checksum.
 */
export function normalizeIranianIban(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.replace(/[\s-]+/g, '').toUpperCase();
  if (/^\d{24}$/.test(value)) value = `IR${value}`;
  if (!IRANIAN_IBAN.test(value)) return null;
  return ibanChecksumIsValid(value) ? value : null;
}

export function ibanChecksumIsValid(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}
