import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { PollingWorker } from '../../common/worker/polling-worker';
import { queryRows } from '../../database/sql';
import { DepositReconciler } from './deposit-reconciler.service';

const BATCH = 20;
const LEASE_SECONDS = 60;

/**
 * Covers missing callbacks and transient verify failures. Due deposits are claimed by pushing their
 * `next_check_at` one lease into the future (FOR UPDATE SKIP LOCKED), so concurrent instances never work on
 * the same deposit at the same time and a crashed instance's claims expire on their own.
 */
@Injectable()
export class DepositPollerWorker extends PollingWorker {
  protected readonly intervalMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly reconciler: DepositReconciler,
    private readonly config: AppConfig,
  ) {
    super();
    this.intervalMs = config.workers.pollIntervalMs;
  }

  protected enabled(): boolean {
    return this.config.workersEnabled;
  }

  protected async tick(): Promise<boolean> {
    const due = await queryRows<{ id: string }>(
      this.dataSource.manager,
      `UPDATE deposits
          SET check_attempts = check_attempts + 1,
              next_check_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id IN (SELECT id FROM deposits
                      WHERE next_check_at <= now()
                      ORDER BY next_check_at
                      LIMIT ${BATCH}
                      FOR UPDATE SKIP LOCKED)
      RETURNING id`,
    );
    await Promise.all(
      due.map((d) =>
        this.reconciler.reconcile(d.id, 'poll').catch((error: Error) => {
          this.logger.error(`reconcile ${d.id} failed: ${error.message}`);
        }),
      ),
    );
    return due.length === BATCH;
  }
}
