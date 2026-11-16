import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { PollingWorker } from '../../common/worker/polling-worker';
import { queryRows } from '../../database/sql';
import { EventPublisher } from './event-publisher';
import type { EventEnvelope } from './outbox.service';

const BATCH = 100;

/**
 * Moves committed outbox rows to the broker. Rows are claimed with `FOR UPDATE SKIP LOCKED` (so several
 * instances relay in parallel without double-sending in the normal case) and marked published only after the
 * broker confirmed them. A crash between "confirmed" and "marked" re-publishes the batch: delivery is
 * at-least-once by design, consumers de-duplicate by `eventId`.
 */
@Injectable()
export class OutboxRelayWorker extends PollingWorker {
  protected readonly intervalMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
    private readonly config: AppConfig,
  ) {
    super();
    this.intervalMs = config.workers.outboxIntervalMs;
  }

  protected enabled(): boolean {
    return this.config.workersEnabled && this.config.rabbitmqUrl !== null;
  }

  protected async tick(): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const rows = await queryRows<{
        id: string;
        event_id: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        manager,
        `SELECT id, event_id, event_type, aggregate_type, aggregate_id, payload, created_at
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`,
      );
      if (!rows.length) return false;

      const envelopes: EventEnvelope[] = rows.map((r) => ({
        eventId: r.event_id,
        type: r.event_type,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        occurredAt: r.created_at.toISOString(),
        data: r.payload,
      }));
      const ids = rows.map((r) => r.id);
      try {
        await this.publisher.publish(envelopes);
      } catch (error) {
        await queryRows(
          manager,
          `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1::bigint[])`,
          [ids, String((error as Error).message).slice(0, 500)],
        );
        this.logger.warn(`publish failed, ${rows.length} events stay in the outbox: ${(error as Error).message}`);
        return false;
      }
      await queryRows(manager, `UPDATE outbox_events SET published_at = now() WHERE id = ANY($1::bigint[])`, [ids]);
      return rows.length === BATCH;
    });
  }
}
