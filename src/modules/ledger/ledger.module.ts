import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { LedgerIntegrityService } from './ledger-integrity.service';
import { LedgerService } from './ledger.service';

@Module({
  imports: [OutboxModule],
  providers: [LedgerService, LedgerIntegrityService],
  exports: [LedgerService, LedgerIntegrityService],
})
export class LedgerModule {}
