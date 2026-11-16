import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively, so logically equal payloads hash identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const v = (value as Record<string, unknown>)[key];
        if (v !== undefined) acc[key] = sortKeys(v);
        return acc;
      }, {});
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
