import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { DomainError, Errors } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-codes';
import { canonicalJson, sha256Hex } from '../../common/util/canonical-json';
import { pgErrorCode, queryOne, queryRows } from '../../database/sql';

const MAX_ATTEMPTS = 3;

export interface IdempotentRequest {
  /** Operation name, e.g. `withdrawals.create`. Keys are unique per scope. */
  scope: string;
  key: string;
  /** Normalised request (DTO + path params). Its hash detects a key reused with a different body. */
  request: unknown;
}

export interface IdempotentResult<T> {
  body: T;
  replayed: boolean;
}

interface StoredKey {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

/**
 * Idempotency-Key handling, with the key row written in the SAME transaction as the business effect:
 *
 *   BEGIN
 *     INSERT key ... ON CONFLICT DO NOTHING      -- a concurrent duplicate blocks here until we finish
 *     SAVEPOINT work
 *       <business writes>                         -- e.g. hold funds, insert withdrawal, outbox event
 *     (on a business error: ROLLBACK TO SAVEPOINT work — the error itself becomes the stored outcome)
 *     UPDATE key SET response = ...
 *   COMMIT
 *
 * Consequences: the effect happened  <=>  the key is completed; a crash at any point leaves either both or
 * neither; two identical requests racing (same or different instances) produce exactly one effect and both
 * get the same response; no "IN_PROGRESS" row can be orphaned by a crash.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute<T>(
    request: IdempotentRequest,
    work: (manager: EntityManager) => Promise<T>,
    options: { successStatus?: number } = {},
  ): Promise<IdempotentResult<T>> {
    // Defence in depth: if PostgreSQL aborts the transaction as a deadlock victim or on a serialization
    // failure, nothing of it survived (key row included), so running it again is safe.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.executeOnce(request, work, options);
      } catch (error) {
        const code = pgErrorCode(error);
        if ((code !== '40P01' && code !== '40001') || attempt >= MAX_ATTEMPTS) throw error;
        this.logger.warn(
          `${request.scope}: transaction aborted (${code}), retrying (${attempt}/${MAX_ATTEMPTS})`,
        );
      }
    }
  }

  private async executeOnce<T>(
    request: IdempotentRequest,
    work: (manager: EntityManager) => Promise<T>,
    options: { successStatus?: number },
  ): Promise<IdempotentResult<T>> {
    const hash = sha256Hex(canonicalJson({ scope: request.scope, request: request.request }));
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('READ COMMITTED');
    try {
      const claimed = await queryRows(
        runner.manager,
        `INSERT INTO idempotency_keys (scope, key, request_hash) VALUES ($1, $2, $3)
         ON CONFLICT (scope, key) DO NOTHING RETURNING key`,
        [request.scope, request.key, hash],
      );

      if (claimed.length === 0) {
        const stored = await queryOne<StoredKey>(
          runner.manager,
          `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND key = $2`,
          [request.scope, request.key],
        );
        await runner.commitTransaction();
        return this.replay<T>(stored, hash);
      }

      await runner.query('SAVEPOINT idempotent_work');
      let body: unknown;
      let status = options.successStatus ?? 201;
      let failure: DomainError | null = null;
      try {
        body = await work(runner.manager);
      } catch (error) {
        if (!(error instanceof DomainError) || !error.replayable) throw error;
        await runner.query('ROLLBACK TO SAVEPOINT idempotent_work');
        failure = error;
        status = error.httpStatus;
        body = error.toBody();
      }

      await runner.query(
        `UPDATE idempotency_keys SET response_status = $3, response_body = $4, completed_at = now()
          WHERE scope = $1 AND key = $2`,
        [request.scope, request.key, status, JSON.stringify(body)],
      );
      await runner.commitTransaction();
      if (failure) throw failure;
      return { body: body as T, replayed: false };
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private replay<T>(stored: StoredKey | null, hash: string): IdempotentResult<T> {
    // A row without a stored response cannot be observed (insert+complete share one transaction);
    // defensively treat it as "still running".
    if (!stored || stored.response_status === null) throw Errors.idempotencyInProgress();
    if (stored.request_hash !== hash) throw Errors.idempotencyKeyReused();
    if (stored.response_status >= 400) {
      const body = stored.response_body as { code: ErrorCode; message: string };
      this.logger.debug(`replaying stored error ${body.code}`);
      throw new DomainError(body.code, body.message, stored.response_status);
    }
    return { body: stored.response_body as T, replayed: true };
  }
}
