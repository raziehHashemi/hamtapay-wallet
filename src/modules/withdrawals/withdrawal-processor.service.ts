import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { Currency } from '../../common/money/currency';
import { formatMinor } from '../../common/money/money';
import { exponentialBackoffMs } from '../../common/util/backoff';
import {
  PayoutCallResult,
  PayoutGateway,
  ProviderTransfer,
  ProviderTransferStatus,
} from '../../integrations/payout/payout-gateway';
import { LedgerService } from '../ledger/ledger.service';
import { AccountKind, JournalType, PostingLine, systemAccount, userAccount } from '../ledger/ledger.types';
import { OutboxService } from '../outbox/outbox.service';
import { DailyLimitService } from './daily-limit.service';
import { WithdrawalEntity, WithdrawalStatus } from './withdrawal.entity';
import { decideTransition, FAILURE_PREFIX, isNewerProviderStatus, Transition } from './withdrawal-state-machine';
import { toPayoutRequest } from './withdrawal-rules';

export interface ProviderObservation {
  status: ProviderTransferStatus;
  reason: string | null;
  trackingId: string | null;
  occurredAt: string | null;
}

export type ObservationSource = 'submit' | 'poll' | 'webhook';

type Patch = Partial<WithdrawalEntity>;

const POLL_BASE_MS = 2000;
const RETURN_WATCH_BASE_MS = 30000;
const RETURN_WATCH_CAP_MS = 600000;

/**
 * Talks to the payout provider for one withdrawal and applies what it learns, using the pure transition
 * table in withdrawal-state-machine.ts. Every application runs in one transaction holding the withdrawal row
 * lock, so webhooks, pollers and retries on any instance serialise per withdrawal; the ledger's unique
 * idempotency refs make each money movement (settle/release/return) impossible to apply twice.
 */
@Injectable()
export class WithdrawalProcessor {
  private readonly logger = new Logger(WithdrawalProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly payout: PayoutGateway,
    private readonly ledger: LedgerService,
    private readonly limits: DailyLimitService,
    private readonly outbox: OutboxService,
    private readonly config: AppConfig,
  ) {}

  /** One dispatcher step for a withdrawal the dispatcher has claimed. */
  async process(id: string): Promise<void> {
    const w = await this.dataSource.getRepository(WithdrawalEntity).findOneBy({ id });
    if (!w) return;

    if (w.status === WithdrawalStatus.SUCCEEDED) {
      await this.watchForReturn(w);
      return;
    }
    if (w.status !== WithdrawalStatus.PROCESSING) {
      await this.dataSource.getRepository(WithdrawalEntity).update({ id }, { nextAttemptAt: null });
      return;
    }

    // Before the provider has acknowledged the requestId we (re-)submit — the provider de-duplicates by
    // requestId, so this is also how we resolve a 503/timeout whose outcome is unknown. After an
    // acknowledgement we only ever *ask*: a GET can answer 404 for ~90s after a 503/timeout (provider-notes
    // §P3), and re-creating a transfer the provider already knows is exactly how double payouts happen.
    const result: PayoutCallResult = w.providerAcknowledgedAt
      ? await this.payout.getTransfer(w.id)
      : await this.payout.submit(toPayoutRequest(w));

    switch (result.kind) {
      case 'OK':
        await this.apply(w.id, toObservation(result.transfer), w.providerAcknowledgedAt ? 'poll' : 'submit');
        return;
      case 'REJECTED':
        await this.applyRejection(w.id, `${result.httpStatus} ${result.error}`);
        return;
      case 'NOT_FOUND':
        await this.retryLater(w.id, 'provider answered 404 for an acknowledged transfer; waiting');
        return;
      case 'UNKNOWN':
        this.logger.warn(`withdrawal ${w.id}: outcome unknown (${result.reason}); will retry with the same requestId`);
        await this.retryLater(w.id, result.reason);
        return;
    }
  }

  /** Applies a provider observation (webhook, poll or submit response). Returns the transition taken. */
  async apply(id: string, observation: ProviderObservation, source: ObservationSource): Promise<Transition['kind']> {
    return this.dataSource.transaction(async (manager) => {
      const w = await this.lock(manager, id);
      if (!w) return 'NOOP';
      const transition = decideTransition(w, observation.status, observation.reason);
      const patch: Patch = { lastError: null };
      if (!w.providerAcknowledgedAt) patch.providerAcknowledgedAt = new Date();
      if (observation.trackingId && !w.providerTrackingId) patch.providerTrackingId = observation.trackingId;
      if (isNewerProviderStatus(w.providerStatus, observation.status)) patch.providerStatus = observation.status;

      switch (transition.kind) {
        case 'NOOP':
        case 'TRACK':
          break;
        case 'SUCCEED':
          await this.settle(manager, w, patch, observation);
          break;
        case 'FAIL':
          await this.release(manager, w, patch, transition.reason);
          break;
        case 'RETURN':
          if (transition.settleFirst) await this.settle(manager, w, patch, observation);
          await this.refundReturn(manager, w, patch, transition.reason, observation);
          break;
        case 'LATE_SUCCESS':
          await this.lateSuccess(manager, w, patch, observation);
          break;
        case 'ANOMALY':
          await this.flag(manager, w, patch, transition.note);
          break;
      }
      await this.scheduleNext(manager, w, patch);
      await manager.update(WithdrawalEntity, { id }, patch);
      if (transition.kind !== 'NOOP' && transition.kind !== 'TRACK') {
        this.logger.log(`withdrawal ${id}: ${transition.kind} via ${source} (provider ${observation.status})`);
      }
      return transition.kind;
    });
  }

  /**
   * Ambiguity #3: a user may cancel only while the withdrawal is PENDING, i.e. before we have *ever* tried to
   * hand it to the provider. From PROCESSING on, the money may already be moving and only the provider's
   * answer can release it. Runs inside the caller's (idempotent) transaction.
   */
  async cancelInTransaction(manager: EntityManager, id: string, userId?: string): Promise<WithdrawalEntity> {
    const w = await this.lock(manager, id);
    if (!w || (userId && userId !== w.userId)) throw Errors.notFound('withdrawal');
    if (w.status !== WithdrawalStatus.PENDING) throw Errors.notCancellable(w.status);
    const patch: Patch = { nextAttemptAt: null };
    await this.release(manager, w, patch, FAILURE_PREFIX.CANCELLED);
    await manager.update(WithdrawalEntity, { id }, patch);
    return manager.getRepository(WithdrawalEntity).findOneByOrFail({ id });
  }

  // ---------------------------------------------------------------------------------------------------------

  private async applyRejection(id: string, error: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const w = await this.lock(manager, id);
      if (!w || w.status !== WithdrawalStatus.PROCESSING) return;
      const patch: Patch = { lastError: error };
      if (w.providerAcknowledgedAt) {
        await this.flag(manager, w, patch, `provider rejected an acknowledged transfer: ${error}`);
      } else {
        // A validation error means the transfer was not created: releasing the funds is safe.
        await this.release(manager, w, patch, `${FAILURE_PREFIX.REJECTED}:${error}`);
      }
      await this.scheduleNext(manager, w, patch);
      await manager.update(WithdrawalEntity, { id }, patch);
    });
  }

  private async retryLater(id: string, reason: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const w = await this.lock(manager, id);
      if (!w) return;
      const patch: Patch = { lastError: reason.slice(0, 500) };
      await this.scheduleNext(manager, w, patch);
      await manager.update(WithdrawalEntity, { id }, patch);
    });
  }

  private async watchForReturn(w: WithdrawalEntity): Promise<void> {
    const result = await this.payout.getTransfer(w.id);
    if (result.kind === 'OK') {
      await this.apply(w.id, toObservation(result.transfer), 'poll');
    } else {
      await this.retryLater(w.id, result.kind === 'UNKNOWN' ? result.reason : result.kind);
    }
  }

  private async settle(manager: EntityManager, w: WithdrawalEntity, patch: Patch, obs: ProviderObservation) {
    const lines: PostingLine[] = [
      { account: userAccount(w.userId, w.currency, AccountKind.USER_HELD), direction: 'DEBIT', amount: w.amount + w.fee },
      { account: systemAccount(w.currency, AccountKind.PAYOUT_CLEARING), direction: 'CREDIT', amount: w.amount },
    ];
    if (w.fee > 0n) {
      lines.push({ account: systemAccount(w.currency, AccountKind.FEE_REVENUE), direction: 'CREDIT', amount: w.fee });
    }
    const posted = await this.ledger.post(manager, {
      type: JournalType.WITHDRAWAL_SETTLE,
      idempotencyRef: `withdrawal:${w.id}:settle`,
      referenceType: 'withdrawal',
      referenceId: w.id,
      description: `paid out to ${w.destination}`,
      lines,
    });
    Object.assign(patch, {
      status: WithdrawalStatus.SUCCEEDED,
      settleJournalId: posted.journalId,
      providerSucceededAt: instant(obs.occurredAt),
      finalizedAt: new Date(),
      attempts: 0,
    });
    await this.event(manager, 'withdrawal.succeeded', w, { trackingId: patch.providerTrackingId ?? w.providerTrackingId });
  }

  private async release(manager: EntityManager, w: WithdrawalEntity, patch: Patch, reason: string) {
    const posted = await this.ledger.reverse(manager, w.holdJournalId, {
      type: JournalType.WITHDRAWAL_RELEASE,
      idempotencyRef: `withdrawal:${w.id}:release`,
      referenceType: 'withdrawal',
      referenceId: w.id,
      description: reason,
    });
    await this.limits.release(manager, w.userId, w.limitDay, w.limitAmountIrt);
    Object.assign(patch, {
      status: WithdrawalStatus.FAILED,
      failureReason: reason,
      releaseJournalId: posted.journalId,
      finalizedAt: new Date(),
    });
    await this.event(manager, 'withdrawal.failed', w, { reason });
  }

  private async refundReturn(
    manager: EntityManager,
    w: WithdrawalEntity,
    patch: Patch,
    reason: string,
    obs: ProviderObservation,
  ) {
    const lines: PostingLine[] = [
      { account: systemAccount(w.currency, AccountKind.PAYOUT_CLEARING), direction: 'DEBIT', amount: w.amount },
      {
        account: userAccount(w.userId, w.currency, AccountKind.USER_AVAILABLE),
        direction: 'CREDIT',
        amount: w.amount + w.fee,
      },
    ];
    if (w.fee > 0n) {
      lines.push({ account: systemAccount(w.currency, AccountKind.FEE_REVENUE), direction: 'DEBIT', amount: w.fee });
    }
    const posted = await this.ledger.post(manager, {
      type: JournalType.WITHDRAWAL_RETURN,
      idempotencyRef: `withdrawal:${w.id}:return`,
      referenceType: 'withdrawal',
      referenceId: w.id,
      description: reason,
      lines,
    });
    await this.limits.release(manager, w.userId, w.limitDay, w.limitAmountIrt);
    Object.assign(patch, {
      status: WithdrawalStatus.FAILED,
      failureReason: reason,
      returnJournalId: posted.journalId,
      providerReturnedAt: instant(obs.occurredAt),
      finalizedAt: new Date(),
    });
    await this.event(manager, 'withdrawal.returned', w, { reason });
  }

  /**
   * Ambiguity #1: we had released the funds (provider said FAILED / request rejected / user cancelled) and the
   * provider now reports the transfer as SUCCEEDED. The ledger must tell the truth: the money left. We take it
   * from the user's available balance as far as possible and book the rest as a receivable (the balance never
   * goes negative), then block further withdrawals/transfers and hand the case to operations.
   */
  private async lateSuccess(manager: EntityManager, w: WithdrawalEntity, patch: Patch, obs: ProviderObservation) {
    const total = w.amount + w.fee;
    const balance = await this.ledger.lockUserBalance(manager, w.userId, w.currency);
    const fromAvailable = balance.available < total ? balance.available : total;
    const debt = total - fromAvailable;
    const lines: PostingLine[] = [
      { account: systemAccount(w.currency, AccountKind.PAYOUT_CLEARING), direction: 'CREDIT', amount: w.amount },
    ];
    if (w.fee > 0n) {
      lines.push({ account: systemAccount(w.currency, AccountKind.FEE_REVENUE), direction: 'CREDIT', amount: w.fee });
    }
    if (fromAvailable > 0n) {
      lines.push({
        account: userAccount(w.userId, w.currency, AccountKind.USER_AVAILABLE),
        direction: 'DEBIT',
        amount: fromAvailable,
      });
    }
    if (debt > 0n) {
      lines.push({
        account: userAccount(w.userId, w.currency, AccountKind.USER_RECEIVABLE),
        direction: 'DEBIT',
        amount: debt,
      });
    }
    const posted = await this.ledger.post(manager, {
      type: JournalType.WITHDRAWAL_LATE_SUCCESS,
      idempotencyRef: `withdrawal:${w.id}:late-success`,
      referenceType: 'withdrawal',
      referenceId: w.id,
      description: `provider reported success after the withdrawal had failed (${w.failureReason})`,
      lines,
    });
    await this.limits.consume(manager, w.userId, w.limitAmountIrt, { day: w.limitDay, force: true });
    const note =
      `LATE_SUCCESS_AFTER_FAILURE: was ${w.failureReason}; recovered ${formatMinor(w.currency, fromAvailable)} ` +
      `from available, ${formatMinor(w.currency, debt)} booked as debt`;
    Object.assign(patch, {
      status: WithdrawalStatus.SUCCEEDED,
      settleJournalId: posted.journalId,
      providerSucceededAt: instant(obs.occurredAt),
      finalizedAt: new Date(),
      needsReview: true,
      anomaly: note,
    });
    this.logger.error(`withdrawal ${w.id}: ${note}`);
    await this.event(manager, 'withdrawal.late_success', w, {
      recoveredFromAvailable: formatMinor(w.currency, fromAvailable),
      debt: formatMinor(w.currency, debt),
    });
  }

  private async flag(manager: EntityManager, w: WithdrawalEntity, patch: Patch, note: string) {
    patch.needsReview = true;
    patch.anomaly = note;
    if (!w.needsReview) await this.event(manager, 'withdrawal.needs_review', w, { note });
    this.logger.warn(`withdrawal ${w.id} flagged for review: ${note}`);
  }

  /** Next dispatcher visit, derived from the resulting state. Also raises the "no answer for too long" flag. */
  private async scheduleNext(manager: EntityManager, w: WithdrawalEntity, patch: Patch): Promise<void> {
    const status = patch.status ?? w.status;
    const attempts = patch.attempts ?? w.attempts;
    const now = Date.now();
    if (status === WithdrawalStatus.PROCESSING || status === WithdrawalStatus.PENDING) {
      patch.nextAttemptAt = new Date(
        now + exponentialBackoffMs(attempts - 1, POLL_BASE_MS, this.config.workers.withdrawalPollCapMs),
      );
      const overdue = w.submittedAt && now - w.submittedAt.getTime() > this.config.workers.withdrawalReviewAfterMs;
      if (overdue && !w.needsReview && !patch.needsReview) {
        await this.flag(manager, w, patch, 'NO_FINAL_ANSWER_FROM_PROVIDER (funds stay held; never auto-failed)');
      }
      return;
    }
    const succeededAt = patch.providerSucceededAt ?? w.providerSucceededAt;
    const watchReturns =
      status === WithdrawalStatus.SUCCEEDED &&
      w.currency === Currency.IRT &&
      succeededAt !== null &&
      now - succeededAt.getTime() < this.config.workers.returnWatchMs;
    patch.nextAttemptAt = watchReturns
      ? new Date(now + exponentialBackoffMs(attempts, RETURN_WATCH_BASE_MS, RETURN_WATCH_CAP_MS))
      : null;
  }

  private async event(manager: EntityManager, type: string, w: WithdrawalEntity, extra: Record<string, unknown>) {
    await this.outbox.enqueue(manager, {
      type,
      aggregateType: 'withdrawal',
      aggregateId: w.id,
      payload: {
        withdrawalId: w.id,
        userId: w.userId,
        currency: w.currency,
        amount: formatMinor(w.currency, w.amount),
        fee: formatMinor(w.currency, w.fee),
        ...extra,
      },
    });
  }

  private lock(manager: EntityManager, id: string): Promise<WithdrawalEntity | null> {
    return manager.getRepository(WithdrawalEntity).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
  }
}

export function toObservation(t: ProviderTransfer): ProviderObservation {
  return { status: t.status, reason: t.reason, trackingId: t.trackingId, occurredAt: t.occurredAt };
}

/** Provider timestamps are informational; never let a malformed one break a money transition. */
function instant(value: string | null): Date {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
}
