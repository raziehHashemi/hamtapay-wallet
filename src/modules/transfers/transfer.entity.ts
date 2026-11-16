import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { Currency } from '../../common/money/currency';
import { bigintTransformer } from '../../database/bigint.transformer';

@Entity({ name: 'transfers' })
export class TransferEntity {
  @PrimaryColumn('uuid')
  id: string;

  @Column({ name: 'from_user_id', type: 'text' })
  fromUserId: string;

  @Column({ name: 'to_user_id', type: 'text' })
  toUserId: string;

  @Column({ type: 'text' })
  currency: Currency;

  @Column({ type: 'bigint', transformer: bigintTransformer })
  amount: bigint;

  @Column({ name: 'journal_id', type: 'bigint' })
  journalId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
