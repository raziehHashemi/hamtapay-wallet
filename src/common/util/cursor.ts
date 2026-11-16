/**
 * Opaque keyset-pagination cursor. It encodes the last seen ledger entry id, so the next page is an index
 * range scan (`id < cursor`) whose cost does not depend on how deep the client has paged.
 */
const PREFIX = 'le:';

export function encodeCursor(lastId: string): string {
  return Buffer.from(`${PREFIX}${lastId}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!decoded.startsWith(PREFIX)) return null;
    const id = decoded.slice(PREFIX.length);
    return /^\d{1,19}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
