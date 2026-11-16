import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { Currency } from '../../common/money/currency';
import { bigintTransformer } from '../../database/bigint.transformer';

@Entity({ name: 'adjustments' })
export class AdjustmentEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'text' })
  userId: string;

  @Column({ type: 'text' })
  currency: Currency;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ type: 'text' })
  reason: string;

  @Column({ type: 'text', nullable: true })
  operator: string | null;

  @Column({ name: 'journal_id', type: 'bigint' })
  journalId: string;

  @Column({ name: 'reversal_journal_id', type: 'bigint', nullable: true })
  reversalJournalId: string | null;

  @Column({ name: 'reversal_reason', type: 'text', nullable: true })
  reversalReason: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'reversed_at', type: 'timestamptz', nullable: true })
  reversedAt: Date | null;
}
