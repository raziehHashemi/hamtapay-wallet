import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { PollingWorker } from '../../common/worker/polling-worker';
import { queryRows } from '../../database/sql';
import { WithdrawalProcessor } from './withdrawal-processor.service';

const BATCH = 20;

/**
 * Drives withdrawals that need a provider call: new ones (PENDING), unresolved ones (PROCESSING) and
 * successful IBAN ones still inside the return-watch window.
 *
 * The claim is one statement: it flips PENDING → PROCESSING (committed BEFORE any HTTP call, so after a crash
 * we always know the transfer may exist) and pushes `next_attempt_at` one lease into the future. Rows are
 * picked with FOR UPDATE SKIP LOCKED, so instances never contend, and an instance that dies mid-call simply
 * lets its lease expire — the next claimant re-submits the same requestId, which the provider de-duplicates.
 * This is what makes "crash at any step" safe: no withdrawal can stay in an unknown state, none is paid twice.
 */
@Injectable()
export class WithdrawalDispatcherWorker extends PollingWorker {
  protected readonly intervalMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly processor: WithdrawalProcessor,
    private readonly config: AppConfig,
  ) {
    super();
    this.intervalMs = config.workers.pollIntervalMs;
  }

  protected enabled(): boolean {
    return this.config.workersEnabled;
  }

  protected async tick(): Promise<boolean> {
    const claimed = await queryRows<{ id: string }>(
      this.dataSource.manager,
      `UPDATE withdrawals w
          SET status = CASE WHEN w.status = 'PENDING' THEN 'PROCESSING' ELSE w.status END,
              submitted_at = CASE WHEN w.status = 'PENDING' THEN now() ELSE w.submitted_at END,
              attempts = w.attempts + 1,
              next_attempt_at = now() + make_interval(secs => $1::double precision / 1000),
              updated_at = now()
        WHERE w.id IN (SELECT id FROM withdrawals
                        WHERE next_attempt_at <= now()
                        ORDER BY next_attempt_at
                        LIMIT ${BATCH}
                        FOR UPDATE SKIP LOCKED)
      RETURNING w.id`,
      [this.config.workers.withdrawalLeaseMs],
    );
    await Promise.all(
      claimed.map((row) =>
        this.processor.process(row.id).catch((error: Error) => {
          // the lease expires and another attempt follows; nothing is lost
          this.logger.error(`withdrawal ${row.id} step failed: ${error.message}`, error.stack);
        }),
      ),
    );
    return claimed.length === BATCH;
  }
}
