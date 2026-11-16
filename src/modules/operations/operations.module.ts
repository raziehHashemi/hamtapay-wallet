import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LedgerModule } from '../ledger/ledger.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AdjustmentEntity } from './adjustment.entity';
import { AdjustmentsService } from './adjustments.service';
import { OperationsController } from './operations.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AdjustmentEntity]), LedgerModule, OutboxModule],
  controllers: [OperationsController],
  providers: [AdjustmentsService],
})
export class OperationsModule {}
