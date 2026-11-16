/**
 * Opaque keyset-pagination cursor. It encodes the last seen ledger entry id, so the next page is an index
 * range scan (`id < cursor`) whose cost does not depend on how deep the client has paged.
 */
const PREFIX = 'le:';
const MAX_BIGINT = 2n ** 63n - 1n; // PostgreSQL BIGINT

export function encodeCursor(lastId: string): string {
  return Buffer.from(`${PREFIX}${lastId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.startsWith(PREFIX)) return null;
    const id = decoded.slice(PREFIX.length);
    // 19 digits can still exceed BIGINT; such a cursor must be a 400, not a database error.
    return /^\d{1,19}$/.test(id) && BigInt(id) <= MAX_BIGINT ? id : null;
  } catch {
    return null;
  }
}
