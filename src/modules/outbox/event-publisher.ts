import type { EventEnvelope } from './outbox.service';

/** Port for the message broker. The relay only needs "publish these, confirm or throw". */
export abstract class EventPublisher {
  abstract readonly name: string;
  /** Resolves only after the broker has durably accepted every message (publisher confirms). */
  abstract publish(events: EventEnvelope[]): Promise<void>;
  abstract isHealthy(): boolean;
}

/** Used when no broker is configured: events simply stay in the outbox table (nothing is lost). */
export class DisabledEventPublisher extends EventPublisher {
  readonly name = 'disabled';
  async publish(): Promise<void> {
    throw new Error('no message broker configured (RABBITMQ_URL is empty)');
  }
  isHealthy(): boolean {
    return false;
  }
}
