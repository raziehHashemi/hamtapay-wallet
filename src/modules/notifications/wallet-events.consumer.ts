import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown, Optional } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import { AppConfig } from '../../config/app-config';
import type { EventEnvelope } from '../outbox/outbox.service';
import { RabbitMqConnection, WALLET_DLX, WALLET_EXCHANGE } from '../outbox/rabbitmq.connection';
import { NotificationProjector } from './notification.projector';

export const NOTIFICATIONS_QUEUE = 'notifications.wallet-events';
const DEAD_LETTER_QUEUE = `${NOTIFICATIONS_QUEUE}.dlq`;
const RECONNECT_MS = 5000;

/** RabbitMQ subscription for the notifications projector (manual ack, prefetch, dead-letter queue). */
@Injectable()
export class WalletEventsConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WalletEventsConsumer.name);
  private channel: Channel | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly projector: NotificationProjector,
    private readonly config: AppConfig,
    @Optional() private readonly connection: RabbitMqConnection | null,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.workersEnabled && this.connection) void this.subscribe();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.channel?.close().catch(() => undefined);
  }

  private async subscribe(): Promise<void> {
    if (this.stopped || !this.connection) return;
    try {
      const channel = await this.connection.channel();
      await channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
      await channel.bindQueue(DEAD_LETTER_QUEUE, WALLET_DLX, '#');
      await channel.assertQueue(NOTIFICATIONS_QUEUE, { durable: true, deadLetterExchange: WALLET_DLX });
      await channel.bindQueue(NOTIFICATIONS_QUEUE, WALLET_EXCHANGE, '#');
      await channel.prefetch(20);
      channel.on('close', () => this.scheduleResubscribe());
      channel.on('error', (error: Error) => this.logger.warn(`channel error: ${error.message}`));
      await channel.consume(NOTIFICATIONS_QUEUE, (msg) => void this.onMessage(channel, msg), { noAck: false });
      this.channel = channel;
      this.logger.log(`consuming ${NOTIFICATIONS_QUEUE}`);
    } catch (error) {
      this.logger.warn(`cannot subscribe yet: ${(error as Error).message}`);
      this.scheduleResubscribe();
    }
  }

  private scheduleResubscribe(): void {
    this.channel = null;
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.subscribe();
    }, RECONNECT_MS);
  }

  private async onMessage(channel: Channel, msg: ConsumeMessage | null): Promise<void> {
    if (!msg) return;
    let event: EventEnvelope;
    try {
      event = JSON.parse(msg.content.toString('utf8')) as EventEnvelope;
      if (!event.eventId) throw new Error('missing eventId');
    } catch (error) {
      this.logger.error(`poison message sent to DLQ: ${(error as Error).message}`);
      channel.nack(msg, false, false);
      return;
    }
    try {
      const outcome = await this.projector.handle(event);
      if (outcome === 'duplicate') this.logger.debug(`duplicate event ${event.eventId} ignored`);
      channel.ack(msg);
    } catch (error) {
      this.logger.warn(`handling ${event.eventId} failed: ${(error as Error).message}`);
      // retry once via redelivery, then dead-letter
      channel.nack(msg, false, !msg.fields.redelivered);
    }
  }
}
