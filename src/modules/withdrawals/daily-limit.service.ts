import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { queryOne, queryRows } from '../../database/sql';

/**
 * Per-user daily withdrawal cap (in Toman), enforced by one conditional upsert:
 *
 *   INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET used = used + x WHERE used + x <= cap
 *
 * Concurrent requests (any instance) serialise on the (user, day) row and the predicate is re-checked on the
 * latest version, so the cap holds under any concurrency. "Day" is the Asia/Tehran calendar day computed by
 * the database clock (one clock for all instances).
 */
@Injectable()
export class DailyLimitService {
  constructor(private readonly config: AppConfig) {}

  async consume(
    manager: EntityManager,
    userId: string,
    amountIrt: bigint,
    options: { day?: string; force?: boolean } = {},
  ): Promise<string> {
    const row = await queryOne<{ day: string }>(
      manager,
      `WITH d AS (SELECT COALESCE($5::date, (now() AT TIME ZONE $4)::date) AS day)
       INSERT INTO withdrawal_daily_usage (user_id, day, used_irt)
       SELECT $1, d.day, $2 FROM d WHERE $6::boolean OR $2::bigint <= $3::bigint
       ON CONFLICT (user_id, day) DO UPDATE
          SET used_irt = withdrawal_daily_usage.used_irt + EXCLUDED.used_irt, updated_at = now()
        WHERE $6::boolean OR withdrawal_daily_usage.used_irt + EXCLUDED.used_irt <= $3::bigint
       RETURNING to_char(day, 'YYYY-MM-DD') AS day`,
      [
        userId,
        amountIrt.toString(),
        this.config.rules.dailyWithdrawalLimitIrt.toString(),
        this.config.rules.limitTimezone,
        options.day ?? null,
        options.force ?? false,
      ],
    );
    if (!row) throw Errors.dailyLimitExceeded();
    return row.day;
  }

  /** A withdrawal that did not happen (failed, cancelled, returned) does not count against the cap. */
  async release(manager: EntityManager, userId: string, day: string, amountIrt: bigint): Promise<void> {
    await queryRows(
      manager,
      `UPDATE withdrawal_daily_usage SET used_irt = GREATEST(used_irt - $3::bigint, 0), updated_at = now()
        WHERE user_id = $1 AND day = $2::date`,
      [userId, day, amountIrt.toString()],
    );
  }

  async usedToday(manager: EntityManager, userId: string): Promise<bigint> {
    const row = await queryOne<{ used_irt: string }>(
      manager,
      `SELECT used_irt FROM withdrawal_daily_usage WHERE user_id = $1 AND day = (now() AT TIME ZONE $2)::date`,
      [userId, this.config.rules.limitTimezone],
    );
    return BigInt(row?.used_irt ?? 0);
  }
}
