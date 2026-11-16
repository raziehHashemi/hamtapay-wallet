import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { queryRows } from '../../database/sql';
import type { EventEnvelope } from '../outbox/outbox.service';

export const NOTIFICATIONS_CONSUMER = 'notifications';

/**
 * Sample downstream consumer ("notify the user"). It shows the receiving half of exactly-once *effects*:
 * the inbox row (consumer, eventId) and the side effect are written in one transaction, so a re-delivered or
 * re-published event is recognised and skipped.
 */
@Injectable()
export class NotificationProjector {
  constructor(private readonly dataSource: DataSource) {}

  async handle(event: EventEnvelope): Promise<'applied' | 'duplicate'> {
    return this.dataSource.transaction(async (manager) => {
      const first = await queryRows(
        manager,
        `INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING event_id`,
        [NOTIFICATIONS_CONSUMER, event.eventId],
      );
      if (!first.length) return 'duplicate';

      const userId = typeof event.data.userId === 'string' ? event.data.userId : null;
      if (userId) {
        await queryRows(
          manager,
          `INSERT INTO user_notifications (event_id, user_id, event_type, payload) VALUES ($1, $2, $3, $4)`,
          [event.eventId, userId, event.type, JSON.stringify(event.data)],
        );
      }
      return 'applied';
    });
  }
}
