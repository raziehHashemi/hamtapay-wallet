import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { parseAmount } from '../../common/http/money-input';
import { Currency } from '../../common/money/currency';
import { formatMinor } from '../../common/money/money';
import { uuidv7 } from '../../common/util/ids';
import { IdempotencyService, IdempotentResult } from '../idempotency/idempotency.service';
import { LedgerService } from '../ledger/ledger.service';
import { AccountKind, JournalType, userAccount } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { DailyLimitService } from './daily-limit.service';
import { WithdrawalEntity, WithdrawalStatus } from './withdrawal.entity';
import { WithdrawalDispatcherWorker } from './withdrawal-dispatcher.worker';
import { WithdrawalProcessor } from './withdrawal-processor.service';
import { limitAmountInToman, normalizeDestination } from './withdrawal-rules';
import { CreateWithdrawalDto, WithdrawalResponseDto } from './withdrawals.dto';

@Injectable()
export class WithdrawalsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerService,
    private readonly limits: DailyLimitService,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly processor: WithdrawalProcessor,
    private readonly dispatcher: WithdrawalDispatcherWorker,
    private readonly config: AppConfig,
  ) {}

  /**
   * Registers a withdrawal. In ONE transaction: move amount+fee AVAILABLE → HELD (fails with
   * INSUFFICIENT_FUNDS instead of going negative), consume the daily cap (DAILY_LIMIT_EXCEEDED), insert the
   * withdrawal as PENDING, enqueue events, store the idempotent response. Sending to the provider happens
   * afterwards in the dispatcher, so a slow or failing provider never holds an API request or a DB lock.
   */
  async create(dto: CreateWithdrawalDto, key: string): Promise<IdempotentResult<WithdrawalResponseDto>> {
    const { currency, userId } = dto;
    const destination = normalizeDestination(currency, dto.destination);
    const amount = parseAmount(currency, dto.amount);
    const minimum = this.config.rules.withdrawalMin[currency];
    if (amount.minor < minimum) {
      throw Errors.belowMinimum(`minimum ${currency} withdrawal is ${formatMinor(currency, minimum)}`);
    }
    const fee = this.config.rules.withdrawalFee[currency];
    const rate = this.config.rules.usdtIrtRate;
    const limitAmount = limitAmountInToman(currency, amount.minor, rate);
    await this.ledger.ensureUserAccounts(userId, currency);

    const request = { userId, currency, amount: amount.toString(), destination };
    const result = await this.idempotency.execute(
      { scope: 'withdrawals.create', key, request },
      async (manager) => {
        const balance = await this.ledger.getUserBalance(manager, userId, currency);
        if (balance.receivable > 0n) {
          throw Errors.accountRestricted('withdrawals are suspended until the outstanding debt is settled');
        }
        const id = uuidv7();
        const total = amount.minor + fee;
        const hold = await this.ledger.post(manager, {
          type: JournalType.WITHDRAWAL_HOLD,
          idempotencyRef: `withdrawal:${id}:hold`,
          referenceType: 'withdrawal',
          referenceId: id,
          description: `hold for withdrawal to ${destination}`,
          lines: [
            {
              account: userAccount(userId, currency, AccountKind.USER_AVAILABLE),
              direction: 'DEBIT',
              amount: total,
            },
            {
              account: userAccount(userId, currency, AccountKind.USER_HELD),
              direction: 'CREDIT',
              amount: total,
            },
          ],
        });
        const limitDay = await this.limits.consume(manager, userId, limitAmount);
        await manager.getRepository(WithdrawalEntity).insert({
          id,
          userId,
          currency,
          amount: amount.minor,
          fee,
          destination,
          status: WithdrawalStatus.PENDING,
          limitDay,
          limitAmountIrt: limitAmount,
          usdtIrtRate: currency === Currency.USDT ? rate : null,
          holdJournalId: hold.journalId,
          nextAttemptAt: new Date(Date.now() + this.config.workers.withdrawalDispatchDelayMs),
        });
        await this.outbox.enqueue(manager, {
          type: 'withdrawal.created',
          aggregateType: 'withdrawal',
          aggregateId: id,
          payload: {
            withdrawalId: id,
            userId,
            currency,
            amount: amount.toString(),
            fee: formatMinor(currency, fee),
          },
        });
        return toWithdrawalResponse(await manager.getRepository(WithdrawalEntity).findOneByOrFail({ id }));
      },
    );
    if (!result.replayed) this.dispatcher.nudge();
    return result;
  }

  async get(id: string): Promise<WithdrawalResponseDto> {
    const withdrawal = await this.dataSource.getRepository(WithdrawalEntity).findOneBy({ id });
    if (!withdrawal) throw Errors.notFound('withdrawal');
    return toWithdrawalResponse(withdrawal);
  }

  async cancel(id: string, key: string, userId?: string): Promise<IdempotentResult<WithdrawalResponseDto>> {
    return this.idempotency.execute(
      { scope: 'withdrawals.cancel', key, request: { id, userId: userId ?? null } },
      async (manager) => toWithdrawalResponse(await this.processor.cancelInTransaction(manager, id, userId)),
      { successStatus: 200 },
    );
  }

  async reviewQueue(): Promise<WithdrawalResponseDto[]> {
    const rows = await this.dataSource
      .getRepository(WithdrawalEntity)
      .find({ where: { needsReview: true }, order: { createdAt: 'ASC' }, take: 200 });
    return rows.map((w) => ({ ...toWithdrawalResponse(w), anomaly: w.anomaly, lastError: w.lastError }));
  }
}

export function toWithdrawalResponse(w: WithdrawalEntity): WithdrawalResponseDto {
  return {
    withdrawalId: w.id,
    status: w.status,
    userId: w.userId,
    currency: w.currency,
    amount: formatMinor(w.currency, w.amount),
    fee: formatMinor(w.currency, w.fee),
    destination: w.destination,
    failureReason: w.failureReason,
    trackingId: w.providerTrackingId,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  };
}
