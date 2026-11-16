import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DepositEntity } from './deposit.entity';
import { DepositPollerWorker } from './deposit-poller.worker';
import { DepositReconciler } from './deposit-reconciler.service';
import { DepositsController } from './deposits.controller';
import { DepositsService } from './deposits.service';

@Module({
  imports: [TypeOrmModule.forFeature([DepositEntity]), LedgerModule, OutboxModule],
  controllers: [DepositsController],
  providers: [DepositsService, DepositReconciler, DepositPollerWorker],
  exports: [DepositReconciler, DepositPollerWorker],
})
export class DepositsModule {}
