import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DailyLimitService } from './daily-limit.service';
import { PayoutWebhookService } from './payout-webhook.service';
import { WithdrawalEntity } from './withdrawal.entity';
import { WithdrawalDispatcherWorker } from './withdrawal-dispatcher.worker';
import { WithdrawalProcessor } from './withdrawal-processor.service';
import { WithdrawalsController } from './withdrawals.controller';
import { WithdrawalsService } from './withdrawals.service';

@Module({
  imports: [TypeOrmModule.forFeature([WithdrawalEntity]), LedgerModule, OutboxModule],
  controllers: [WithdrawalsController],
  providers: [
    WithdrawalsService,
    WithdrawalProcessor,
    WithdrawalDispatcherWorker,
    DailyLimitService,
    PayoutWebhookService,
  ],
  exports: [WithdrawalProcessor, WithdrawalDispatcherWorker, DailyLimitService],
})
export class WithdrawalsModule {}
