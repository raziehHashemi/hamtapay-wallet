import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Errors } from '../../common/errors/domain-error';
import { parsePositiveAmount } from '../../common/http/money-input';
import { formatMinor } from '../../common/money/money';
import { uuidv7 } from '../../common/util/ids';
import { IdempotencyService, IdempotentResult } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountKind, JournalType, systemAccount, userAccount } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { AdjustmentEntity } from './adjustment.entity';
import { AdjustmentResponseDto, CreateAdjustmentDto, ReverseAdjustmentDto } from './adjustments.dto';

/**
 * Manual balance increase by the operations team (e.g. compensating an error).
 * Double-entry: Dr OPS_ADJUSTMENTS (expense) / Cr user AVAILABLE. A mistaken adjustment is never edited or
 * deleted; it is corrected by a reversal journal (Dr user AVAILABLE / Cr OPS_ADJUSTMENTS).
 */
@Injectable()
export class AdjustmentsService {
  constructor(
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
  ) {}

  async create(dto: CreateAdjustmentDto, key: string): Promise<IdempotentResult<AdjustmentResponseDto>> {
    const amount = parsePositiveAmount(dto.currency, dto.amount);
    await this.ledger.ensureUserAccounts(dto.userId, dto.currency);

    return this.idempotency.execute({ scope: 'adjustments.create', key, request: dto }, async (manager) => {
      const id = uuidv7();
      const posted = await this.ledger.post(manager, {
        type: JournalType.ADJUSTMENT,
        idempotencyRef: `adjustment:${id}`,
        referenceType: 'adjustment',
        referenceId: id,
        description: dto.reason,
        lines: [
          {
            account: systemAccount(dto.currency, AccountKind.OPS_ADJUSTMENTS),
            direction: 'DEBIT',
            amount: amount.minor,
          },
          {
            account: userAccount(dto.userId, dto.currency, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: amount.minor,
          },
        ],
      });
      const entity = await manager.getRepository(AdjustmentEntity).save({
        id,
        userId: dto.userId,
        currency: dto.currency,
        amount: amount.minor,
        reason: dto.reason,
        operator: dto.operator ?? null,
        journalId: posted.journalId,
        reversalJournalId: null,
        reversalReason: null,
        reversedAt: null,
      });
      await this.outbox.enqueue(manager, {
        type: 'adjustment.created',
        aggregateType: 'adjustment',
        aggregateId: id,
        payload: {
          adjustmentId: id,
          userId: dto.userId,
          currency: dto.currency,
          amount: amount.toString(),
          reason: dto.reason,
        },
      });
      return this.toResponse(await this.reload(manager, entity.id));
    });
  }

  async reverse(
    id: string,
    dto: ReverseAdjustmentDto,
    key: string,
  ): Promise<IdempotentResult<AdjustmentResponseDto>> {
    return this.idempotency.execute(
      { scope: 'adjustments.reverse', key, request: { id, ...dto } },
      async (manager) => {
        const repo = manager.getRepository(AdjustmentEntity);
        const adjustment = await repo.findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        if (!adjustment) throw Errors.notFound('adjustment');
        if (adjustment.reversalJournalId) throw Errors.alreadyReversed();
        // Fails with INSUFFICIENT_FUNDS if the user already spent the money: the balance can never go negative.
        const posted = await this.ledger.reverse(manager, adjustment.journalId, {
          type: JournalType.ADJUSTMENT_REVERSAL,
          idempotencyRef: `adjustment:${id}:reversal`,
          referenceType: 'adjustment',
          referenceId: id,
          description: dto.reason,
        });
        await repo.update(
          { id },
          { reversalJournalId: posted.journalId, reversalReason: dto.reason, reversedAt: new Date() },
        );
        return this.toResponse(await this.reload(manager, id));
      },
    );
  }

  private async reload(manager: EntityManager, id: string): Promise<AdjustmentEntity> {
    return manager.getRepository(AdjustmentEntity).findOneOrFail({ where: { id } });
  }

  private toResponse(a: AdjustmentEntity): AdjustmentResponseDto {
    return {
      adjustmentId: a.id,
      journalId: a.journalId,
      userId: a.userId,
      currency: a.currency,
      amount: formatMinor(a.currency, a.amount),
      reason: a.reason,
      operator: a.operator,
      reversalJournalId: a.reversalJournalId,
      createdAt: a.createdAt.toISOString(),
    };
  }
}
