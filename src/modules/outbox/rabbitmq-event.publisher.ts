import type { ConfirmChannel } from 'amqplib';
import { EventPublisher } from './event-publisher';
import type { EventEnvelope } from './outbox.service';
import { RabbitMqConnection, WALLET_EXCHANGE } from './rabbitmq.connection';

/**
 * Publishes to a durable topic exchange with persistent messages and publisher confirms. The routing key is
 * the event type (e.g. `wallet.balance_changed`), the AMQP `messageId` is the outbox event id, which is what
 * consumers de-duplicate on.
 */
export class RabbitMqEventPublisher extends EventPublisher {
  readonly name = 'rabbitmq';
  private channel: ConfirmChannel | null = null;

  constructor(private readonly connection: RabbitMqConnection) {
    super();
  }

  isHealthy(): boolean {
    return this.connection.isHealthy();
  }

  async publish(events: EventEnvelope[]): Promise<void> {
    const channel = await this.getChannel();
    try {
      for (const event of events) {
        channel.publish(WALLET_EXCHANGE, event.type, Buffer.from(JSON.stringify(event)), {
          persistent: true,
          contentType: 'application/json',
          messageId: event.eventId,
          type: event.type,
          timestamp: Math.floor(Date.parse(event.occurredAt) / 1000),
        });
      }
      await channel.waitForConfirms();
    } catch (error) {
      this.channel = null;
      await channel.close().catch(() => undefined);
      throw error;
    }
  }

  private async getChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      const channel = await this.connection.confirmChannel();
      channel.on('error', () => (this.channel = null));
      channel.on('close', () => (this.channel = null));
      this.channel = channel;
    }
    return this.channel;
  }
}
