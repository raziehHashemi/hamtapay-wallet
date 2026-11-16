import { exponentialBackoffMs } from './backoff';
import { canonicalJson, sha256Hex } from './canonical-json';
import { decodeCursor, encodeCursor } from './cursor';
import { isUuid, uuidv7 } from './ids';

describe('canonicalJson', () => {
  it('is independent of key order, recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      canonicalJson({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 }),
    );
  });
  it('drops undefined and stringifies bigint', () => {
    expect(canonicalJson({ a: undefined, b: 10n })).toBe('{"b":"10"}');
  });
  it('hashes with sha256', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor('12345'))).toBe('12345');
  });
  it.each(['', 'garbage', Buffer.from('le:abc').toString('base64url'), Buffer.from('xx:1').toString('base64url')])(
    'rejects %p',
    (c) => expect(decodeCursor(c)).toBeNull(),
  );
});

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 ids', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
  it('is time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
  });
  it('fits the payout requestId length (8..64)', () => {
    expect(uuidv7().length).toBe(36);
  });
});

describe('exponentialBackoffMs', () => {
  it('doubles and caps', () => {
    expect([0, 1, 2, 3, 10].map((n) => exponentialBackoffMs(n, 1000, 5000))).toEqual([1000, 2000, 4000, 5000, 5000]);
  });
  it('treats negative attempts as zero', () => {
    expect(exponentialBackoffMs(-3, 1000, 5000)).toBe(1000);
  });
});
