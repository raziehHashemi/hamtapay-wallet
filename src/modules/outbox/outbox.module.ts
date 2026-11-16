import { Module } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { DisabledEventPublisher, EventPublisher } from './event-publisher';
import { OutboxRelayWorker } from './outbox-relay.worker';
import { OutboxService } from './outbox.service';
import { RabbitMqEventPublisher } from './rabbitmq-event.publisher';
import { RabbitMqConnection } from './rabbitmq.connection';

@Module({
  providers: [
    OutboxService,
    {
      provide: RabbitMqConnection,
      inject: [AppConfig],
      useFactory: (config: AppConfig) =>
        config.rabbitmqUrl ? new RabbitMqConnection(config.rabbitmqUrl) : null,
    },
    {
      provide: EventPublisher,
      inject: [RabbitMqConnection],
      useFactory: (connection: RabbitMqConnection | null) =>
        connection ? new RabbitMqEventPublisher(connection) : new DisabledEventPublisher(),
    },
    OutboxRelayWorker,
  ],
  exports: [OutboxService, EventPublisher, RabbitMqConnection, OutboxRelayWorker],
})
export class OutboxModule {}
