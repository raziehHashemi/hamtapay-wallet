/** TRON base58 address: `T` + 33 base58 characters (no 0, O, I, l). Same rule the payout provider applies. */
const TRC20_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function isValidTrc20Address(input: unknown): input is string {
  return typeof input === 'string' && TRC20_ADDRESS.test(input);
}
