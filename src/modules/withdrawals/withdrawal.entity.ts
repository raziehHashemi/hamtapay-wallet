import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { Currency } from '../../common/money/currency';
import { bigintTransformer } from '../../database/bigint.transformer';

export enum WithdrawalStatus {
  /** Funds held, cap consumed, not handed to the payout provider yet. The only cancellable state. */
  PENDING = 'PENDING',
  /** Persisted BEFORE the first provider call. Outcome may be unknown; resolved only by the provider. */
  PROCESSING = 'PROCESSING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

@Entity({ name: 'withdrawals' })
export class WithdrawalEntity {
  /** Also the payout `requestId`: every retry for this withdrawal is the same provider transfer. */
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ type: 'text' })
  currency: Currency;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  fee: bigint;

  @Column({ type: 'text' })
  destination: string;

  @Column({ type: 'text' })
  status: WithdrawalStatus;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ name: 'provider_status', type: 'text', nullable: true })
  providerStatus: string | null;

  @Column({ name: 'provider_tracking_id', type: 'text', nullable: true })
  providerTrackingId: string | null;

  @Column({ name: 'provider_acknowledged_at', type: 'timestamptz', nullable: true })
  providerAcknowledgedAt: Date | null;

  @Column({ name: 'provider_succeeded_at', type: 'timestamptz', nullable: true })
  providerSucceededAt: Date | null;

  @Column({ name: 'provider_returned_at', type: 'timestamptz', nullable: true })
  providerReturnedAt: Date | null;

  @Column({ name: 'limit_day', type: 'date' })
  limitDay: string;

  @Column({ name: 'limit_amount_irt', type: 'bigint', transformer: bigintTransformer })
  limitAmountIrt: bigint;

  @Column({ name: 'usdt_irt_rate', type: 'bigint', nullable: true, transformer: bigintTransformer })
  usdtIrtRate: bigint | null;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'next_attempt_at', type: 'timestamptz', nullable: true })
  nextAttemptAt: Date | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @Column({ name: 'needs_review', type: 'boolean', default: false })
  needsReview: boolean;

  @Column({ type: 'text', nullable: true })
  anomaly: string | null;

  @Column({ name: 'hold_journal_id', type: 'bigint' })
  holdJournalId: string;

  @Column({ name: 'settle_journal_id', type: 'bigint', nullable: true })
  settleJournalId: string | null;

  @Column({ name: 'release_journal_id', type: 'bigint', nullable: true })
  releaseJournalId: string | null;

  @Column({ name: 'return_journal_id', type: 'bigint', nullable: true })
  returnJournalId: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
