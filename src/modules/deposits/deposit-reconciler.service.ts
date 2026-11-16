import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Currency } from '../../common/money/currency';
import { formatMinor } from '../../common/money/money';
import { queryRows } from '../../database/sql';
import { PaymentGateway, PaymentGatewayUnavailableError } from '../../integrations/psp/payment-gateway';
import { LedgerService } from '../ledger/ledger.service';
import { AccountKind, JournalType, systemAccount, userAccount } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { DepositEntity, DepositStatus, isFinalDepositStatus } from './deposit.entity';
import { decideOnInquiry, decideOnVerify, nextDepositCheckDelayMs } from './deposit-policy';

export type ReconcileTrigger = 'callback' | 'poll';

/**
 * Drives one deposit towards a final state. Called by the PSP callback and by the poller — concurrently, on
 * any instance. Safe because (1) PSP inquiry/verify are idempotent, (2) every state change happens under a
 * row lock and re-checks the current status, (3) the credit journal has a unique idempotency ref.
 */
@Injectable()
export class DepositReconciler {
  private readonly logger = new Logger(DepositReconciler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: PaymentGateway,
    private readonly ledger: LedgerService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfig,
  ) {}

  async reconcile(depositId: string, trigger: ReconcileTrigger): Promise<void> {
    const deposit = await this.dataSource.getRepository(DepositEntity).findOneBy({ id: depositId });
    if (!deposit || isFinalDepositStatus(deposit.status) || !deposit.pspToken) return;

    let inquiry;
    try {
      inquiry = await this.gateway.inquire(deposit.pspToken);
    } catch (error) {
      if (!(error instanceof PaymentGatewayUnavailableError)) throw error;
      this.logger.warn(`deposit ${depositId}: inquiry unavailable (${error.message})`);
      await this.reschedule(depositId);
      return;
    }

    const decision = decideOnInquiry(inquiry?.status ?? null);
    switch (decision.action) {
      case 'WAIT':
        // A callback for an unpaid payment does not move the poll schedule; a poll books the next one.
        await this.reschedule(depositId, { pspStatus: 'INIT', keepSchedule: trigger === 'callback' });
        return;
      case 'FAIL':
        await this.fail(depositId, decision.reason, inquiry?.status ?? null);
        return;
      case 'ANOMALY':
        this.logger.error(`deposit ${depositId}: ${decision.reason}`);
        await this.reschedule(depositId, { anomaly: decision.reason });
        return;
      case 'VERIFY':
        break;
    }

    await this.markVerifying(depositId, inquiry!.status);
    const outcome = await this.gateway.verify(deposit.pspToken);
    const verdict = decideOnVerify(deposit.amount, outcome);
    switch (verdict.action) {
      case 'CREDIT':
        await this.credit(
          depositId,
          verdict.creditToman,
          verdict.refId,
          verdict.verifiedRial,
          verdict.anomaly,
        );
        return;
      case 'FAIL':
        await this.fail(depositId, verdict.reason, 'REVERSED');
        return;
      case 'RETRY':
        this.logger.warn(`deposit ${depositId}: verify will be retried (${verdict.reason})`);
        await this.reschedule(depositId);
        return;
    }
  }

  private async credit(
    depositId: string,
    creditToman: bigint,
    refId: string,
    verifiedRial: bigint,
    anomaly: string | null,
  ): Promise<void> {
    await this.withLockedDeposit(depositId, async (manager, deposit) => {
      if (deposit.status === DepositStatus.SUCCEEDED) return; // a concurrent callback/poll got here first
      if (deposit.status === DepositStatus.FAILED) {
        // Cannot happen with this PSP (FAILED/REVERSED are terminal there) — but never silently drop money.
        this.logger.error(
          `deposit ${depositId} is FAILED but the PSP verified a payment; flagged for review`,
        );
        await manager.update(
          DepositEntity,
          { id: depositId },
          { needsReview: true, anomaly: 'VERIFIED_AFTER_FAILED' },
        );
        return;
      }
      const posted = await this.ledger.post(manager, {
        type: JournalType.DEPOSIT,
        idempotencyRef: `deposit:${depositId}:credit`,
        referenceType: 'deposit',
        referenceId: depositId,
        description: `PSP refId ${refId}`,
        lines: [
          {
            account: systemAccount(Currency.IRT, AccountKind.PSP_CLEARING),
            direction: 'DEBIT',
            amount: creditToman,
          },
          {
            account: userAccount(deposit.userId, Currency.IRT, AccountKind.USER_AVAILABLE),
            direction: 'CREDIT',
            amount: creditToman,
          },
        ],
      });
      await queryRows(
        manager,
        `UPDATE deposits
            SET status = 'SUCCEEDED', psp_status = 'VERIFIED', psp_ref_id = $2, verified_amount_rial = $3,
                credited_amount = $4, journal_id = $5, anomaly = $6, needs_review = $7,
                verified_at = now(), finalized_at = now(), next_check_at = NULL, updated_at = now()
          WHERE id = $1`,
        [
          depositId,
          refId,
          verifiedRial.toString(),
          creditToman.toString(),
          posted.journalId,
          anomaly,
          anomaly !== null,
        ],
      );
      await this.outbox.enqueue(manager, {
        type: 'deposit.succeeded',
        aggregateType: 'deposit',
        aggregateId: depositId,
        payload: {
          depositId,
          userId: deposit.userId,
          amount: formatMinor(Currency.IRT, creditToman),
          refId,
          anomaly,
        },
      });
      this.logger.log(`deposit ${depositId} credited ${creditToman} IRT (refId ${refId})`);
    });
  }

  private async fail(depositId: string, reason: string, pspStatus: string | null): Promise<void> {
    await this.withLockedDeposit(depositId, async (manager, deposit) => {
      if (isFinalDepositStatus(deposit.status)) return;
      await queryRows(
        manager,
        `UPDATE deposits SET status = 'FAILED', failure_reason = $2, psp_status = COALESCE($3, psp_status),
                finalized_at = now(), next_check_at = NULL, updated_at = now()
          WHERE id = $1`,
        [depositId, reason, pspStatus],
      );
      await this.outbox.enqueue(manager, {
        type: 'deposit.failed',
        aggregateType: 'deposit',
        aggregateId: depositId,
        payload: { depositId, userId: deposit.userId, reason },
      });
      this.logger.log(`deposit ${depositId} failed: ${reason}`);
    });
  }

  private async markVerifying(depositId: string, pspStatus: string): Promise<void> {
    await queryRows(
      this.dataSource.manager,
      `UPDATE deposits SET status = 'VERIFYING', psp_status = $2, check_attempts = 0,
              next_check_at = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
        WHERE id = $1 AND status IN ('PENDING', 'VERIFYING')`,
      [depositId, pspStatus, this.config.workers.depositPollCapMs],
    );
  }

  /** Sets the next poll time from the current state (see deposit-policy). */
  private async reschedule(
    depositId: string,
    extra: { pspStatus?: string; anomaly?: string; keepSchedule?: boolean } = {},
  ): Promise<void> {
    await this.withLockedDeposit(depositId, async (manager, deposit) => {
      if (isFinalDepositStatus(deposit.status)) return;
      const delay = extra.keepSchedule
        ? undefined
        : nextDepositCheckDelayMs(
            {
              verifying: deposit.status === DepositStatus.VERIFYING,
              attempts: deposit.checkAttempts,
              ageMs: Date.now() - deposit.createdAt.getTime(),
            },
            this.config.workers,
          );
      await queryRows(
        manager,
        `UPDATE deposits
            SET psp_status = COALESCE($2, psp_status),
                anomaly = COALESCE($3, anomaly),
                needs_review = needs_review OR $3::text IS NOT NULL,
                next_check_at = CASE WHEN $4::boolean THEN next_check_at
                                     WHEN $5::double precision IS NULL THEN NULL
                                     ELSE now() + make_interval(secs => $5::double precision / 1000) END,
                updated_at = now()
          WHERE id = $1`,
        [depositId, extra.pspStatus ?? null, extra.anomaly ?? null, delay === undefined, delay ?? null],
      );
    });
  }

  private async withLockedDeposit(
    depositId: string,
    fn: (manager: EntityManager, deposit: DepositEntity) => Promise<void>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const deposit = await manager
        .getRepository(DepositEntity)
        .findOne({ where: { id: depositId }, lock: { mode: 'pessimistic_write' } });
      if (deposit) await fn(manager, deposit);
    });
  }
}
