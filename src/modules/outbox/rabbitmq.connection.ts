import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import * as amqp from 'amqplib';

export const WALLET_EXCHANGE = 'hamtapay.wallet.events';
export const WALLET_DLX = 'hamtapay.wallet.events.dlx';

/**
 * Durable queues that must exist before anything is published. A topic exchange silently drops messages
 * that match no queue, so the topology is declared by *both* sides (publisher and consumer) — an event
 * published before its consumer first started is still queued for it.
 */
export const DURABLE_SUBSCRIPTIONS = [{ queue: 'notifications.wallet-events', bindingKey: '#' }] as const;

/**
 * Lazily (re)connects to RabbitMQ. Callers ask for a channel when they need one; on any connection error the
 * cached connection is dropped and the next call reconnects. The broker is never on the critical path of a
 * money movement — if it is down, events wait in the outbox table.
 */
export class RabbitMqConnection implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection: amqp.ChannelModel | null = null;
  private connecting: Promise<amqp.ChannelModel> | null = null;
  private healthy = false;

  constructor(private readonly url: string) {}

  /** Connect eagerly so /health reflects the broker state from the start. */
  onApplicationBootstrap(): void {
    this.connect().catch((error: Error) => this.logger.warn(`RabbitMQ not reachable yet: ${error.message}`));
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async confirmChannel(): Promise<amqp.ConfirmChannel> {
    const connection = await this.connect();
    const channel = await connection.createConfirmChannel();
    await this.assertTopology(channel);
    return channel;
  }

  async channel(): Promise<amqp.Channel> {
    const connection = await this.connect();
    const channel = await connection.createChannel();
    await this.assertTopology(channel);
    return channel;
  }

  async onApplicationShutdown(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.healthy = false;
    await connection?.close().catch(() => undefined);
  }

  private async connect(): Promise<amqp.ChannelModel> {
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = amqp
        .connect(this.url, { timeout: 5000 })
        .then((connection) => {
          connection.on('error', (error: Error) => this.logger.warn(`connection error: ${error.message}`));
          connection.on('close', () => {
            this.healthy = false;
            this.connection = null;
          });
          this.connection = connection;
          this.healthy = true;
          this.logger.log('connected to RabbitMQ');
          return connection;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  private async assertTopology(channel: amqp.Channel): Promise<void> {
    await channel.assertExchange(WALLET_EXCHANGE, 'topic', { durable: true });
    await channel.assertExchange(WALLET_DLX, 'topic', { durable: true });
    for (const { queue, bindingKey } of DURABLE_SUBSCRIPTIONS) {
      await channel.assertQueue(`${queue}.dlq`, { durable: true });
      await channel.bindQueue(`${queue}.dlq`, WALLET_DLX, bindingKey);
      await channel.assertQueue(queue, { durable: true, deadLetterExchange: WALLET_DLX });
      await channel.bindQueue(queue, WALLET_EXCHANGE, bindingKey);
    }
  }
}
