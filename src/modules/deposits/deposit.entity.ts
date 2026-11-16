import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintTransformer } from '../../database/bigint.transformer';

export enum DepositStatus {
  /** Payment link issued, payer has not (provably) paid yet. */
  PENDING = 'PENDING',
  /** PSP reports the payment as paid; server-side verification is in progress / being retried. */
  VERIFYING = 'VERIFYING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export const isFinalDepositStatus = (s: DepositStatus) =>
  s === DepositStatus.SUCCEEDED || s === DepositStatus.FAILED;

@Entity({ name: 'deposits' })
export class DepositEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  /** Requested amount in Toman. */
  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'text' })
  status: DepositStatus;

  @Column({ name: 'psp_token', type: 'text', nullable: true })
  pspToken: string | null;

  @Column({ name: 'payment_url', type: 'text', nullable: true })
  paymentUrl: string | null;

  @Column({ name: 'psp_status', type: 'text', nullable: true })
  pspStatus: string | null;

  @Column({ name: 'psp_ref_id', type: 'text', nullable: true })
  pspRefId: string | null;

  @Column({ name: 'verified_amount_rial', type: 'bigint', nullable: true, transformer: bigintTransformer })
  verifiedAmountRial: bigint | null;

  /** What actually reached the wallet, in Toman (normally == amount). */
  @Column({ name: 'credited_amount', type: 'bigint', nullable: true, transformer: bigintTransformer })
  creditedAmount: bigint | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string | null;

  @Column({ type: 'text', nullable: true })
  anomaly: string | null;

  @Column({ name: 'needs_review', type: 'boolean', default: false })
  needsReview: boolean;

  @Column({ name: 'journal_id', type: 'bigint', nullable: true })
  journalId: string | null;

  @Column({ name: 'check_attempts', type: 'int', default: 0 })
  checkAttempts: number;

  @Column({ name: 'next_check_at', type: 'timestamptz', nullable: true })
  nextCheckAt: Date | null;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'finalized_at', type: 'timestamptz', nullable: true })
  finalizedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
