import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors/domain-error';
import { parsePositiveAmount } from '../../common/http/money-input';
import { formatMinor } from '../../common/money/money';
import { uuidv7 } from '../../common/util/ids';
import { IdempotencyService, IdempotentResult } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountKind, JournalType, userAccount } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { TransferEntity } from './transfer.entity';
import { CreateTransferDto, TransferResponseDto } from './transfers.dto';

/**
 * Internal user-to-user transfer. One journal (Dr sender AVAILABLE / Cr receiver AVAILABLE) in one database
 * transaction: there is no instant in which money has left the sender but not reached the receiver.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
  ) {}

  async create(dto: CreateTransferDto, key: string): Promise<IdempotentResult<TransferResponseDto>> {
    if (dto.fromUserId === dto.toUserId) throw Errors.validation('fromUserId and toUserId must be different');
    const amount = parsePositiveAmount(dto.currency, dto.amount);
    await this.ledger.ensureUserAccounts(dto.fromUserId, dto.currency);
    await this.ledger.ensureUserAccounts(dto.toUserId, dto.currency);

    return this.idempotency.execute({ scope: 'transfers.create', key, request: dto }, async (manager) => {
      const sender = await this.ledger.getUserBalance(manager, dto.fromUserId, dto.currency);
      if (sender.receivable > 0n) {
        throw Errors.accountRestricted('sender has an outstanding debt; transfers are suspended until it is settled');
      }
      const id = uuidv7();
      const posted = await this.ledger.post(manager, {
        type: JournalType.TRANSFER,
        idempotencyRef: `transfer:${id}`,
        referenceType: 'transfer',
        referenceId: id,
        description: `transfer ${dto.fromUserId} -> ${dto.toUserId}`,
        lines: [
          {
            account: userAccount(dto.fromUserId, dto.currency, AccountKind.USER_AVAILABLE),
            direction: 'DEBIT',
            amount: amount.minor,
          },
          {
            account: userAccount(dto.toUserId, dto.currency, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: amount.minor,
          },
        ],
      });
      const transfer = await manager.getRepository(TransferEntity).save({
        id,
        fromUserId: dto.fromUserId,
        toUserId: dto.toUserId,
        currency: dto.currency,
        amount: amount.minor,
        journalId: posted.journalId,
      });
      await this.outbox.enqueue(manager, {
        type: 'transfer.completed',
        aggregateType: 'transfer',
        aggregateId: id,
        payload: {
          transferId: id,
          fromUserId: dto.fromUserId,
          toUserId: dto.toUserId,
          currency: dto.currency,
          amount: amount.toString(),
        },
      });
      const saved = await manager.getRepository(TransferEntity).findOneByOrFail({ id: transfer.id });
      return {
        transferId: saved.id,
        status: 'SUCCEEDED',
        fromUserId: saved.fromUserId,
        toUserId: saved.toUserId,
        currency: saved.currency,
        amount: formatMinor(saved.currency, saved.amount),
        journalId: saved.journalId,
        createdAt: saved.createdAt.toISOString(),
      };
    });
  }
}
