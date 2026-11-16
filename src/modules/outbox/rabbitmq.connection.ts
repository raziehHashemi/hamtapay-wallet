import { Logger, OnApplicationShutdown } from '@nestjs/common';
import * as amqp from 'amqplib';

export const WALLET_EXCHANGE = 'hamtapay.wallet.events';
export const WALLET_DLX = 'hamtapay.wallet.events.dlx';

/**
 * Lazily (re)connects to RabbitMQ. Callers ask for a channel when they need one; on any connection error the
 * cached connection is dropped and the next call reconnects. The broker is never on the critical path of a
 * money movement — if it is down, events wait in the outbox table.
 */
export class RabbitMqConnection implements OnApplicationShutdown {
  private readonly logger = new Logger(RabbitMqConnection.name);
  private connection: amqp.ChannelModel | null = null;
  private connecting: Promise<amqp.ChannelModel> | null = null;
  private healthy = false;

  constructor(private readonly url: string) {}

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
  }
}
