import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { NotificationProjector } from './notification.projector';
import { WalletEventsConsumer } from './wallet-events.consumer';

@Module({
  imports: [OutboxModule],
  providers: [NotificationProjector, WalletEventsConsumer],
  exports: [NotificationProjector],
})
export class NotificationsModule {}
