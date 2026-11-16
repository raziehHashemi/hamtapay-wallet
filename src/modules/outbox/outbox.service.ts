import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { uuidv7 } from '../../common/util/ids';
import { queryOne } from '../../database/sql';

export interface OutboxMessage {
  type: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

/** Published envelope (what consumers receive). */
export interface EventEnvelope {
  eventId: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/**
 * Transactional outbox. `enqueue` MUST be called with the same transactional EntityManager that changes
 * the balance: the event exists if and only if the change committed, so a crash right after COMMIT can
 * never lose it. The relay publishes it later (at-least-once).
 */
@Injectable()
export class OutboxService {
  async enqueue(manager: EntityManager, message: OutboxMessage): Promise<string> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('outbox events must be written inside the business transaction');
    }
    const eventId = uuidv7();
    await queryOne(
      manager,
      `INSERT INTO outbox_events (event_id, event_type, aggregate_type, aggregate_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, message.type, message.aggregateType, message.aggregateId, JSON.stringify(message.payload)],
    );
    return eventId;
  }
}
