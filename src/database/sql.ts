import { EntityManager, QueryFailedError } from 'typeorm';

/**
 * Runs a parameterised SQL statement and always returns the rows (TypeORM's `manager.query` returns
 * `[rows, count]` for UPDATE/DELETE, which is easy to get wrong in money code).
 * When `manager` is transactional, the statement runs inside that transaction.
 */
export async function queryRows<T>(
  manager: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const runner = manager.queryRunner ?? manager.connection.createQueryRunner();
  const owned = !manager.queryRunner;
  try {
    const result = await runner.query(sql, params, true);
    return result.records as T[];
  } finally {
    if (owned) await runner.release();
  }
}

export async function queryOne<T>(
  manager: EntityManager,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await queryRows<T>(manager, sql, params);
  return rows[0] ?? null;
}

/** PostgreSQL SQLSTATE of a failed query, e.g. `23505` (unique_violation), `23514` (check_violation). */
export function pgErrorCode(error: unknown): string | undefined {
  if (error instanceof QueryFailedError) {
    return (error.driverError as { code?: string } | undefined)?.code;
  }
  return undefined;
}

export function pgConstraint(error: unknown): string | undefined {
  if (error instanceof QueryFailedError) {
    return (error.driverError as { constraint?: string } | undefined)?.constraint;
  }
  return undefined;
}

export const toBigInt = (value: string | number | bigint | null | undefined): bigint =>
  value === null || value === undefined ? 0n : BigInt(value);
