import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Currency } from '../../common/money/currency';

export class BalanceDto {
  @ApiProperty({ enum: Currency, example: 'IRT' })
  currency: Currency;
  @ApiProperty({ example: '1500000', description: 'Amount the user can withdraw or transfer right now' })
  available: string;
  @ApiProperty({ example: '200000', description: 'Reserved by withdrawals that are not final yet' })
  held: string;
  @ApiProperty({ example: '1700000', description: 'available + held' })
  total: string;
  @ApiProperty({
    example: '0',
    description: 'Amount owed to the exchange after a reconciled double payout (normally 0)',
  })
  debt: string;
}

export class WalletResponseDto {
  @ApiProperty({ example: 'user-42' })
  userId: string;
  @ApiProperty({ type: [BalanceDto] })
  balances: BalanceDto[];
}

export class LedgerQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer between 1 and 200' })
  @Min(1, { message: 'limit must be an integer between 1 and 200' })
  @Max(200, { message: 'limit must be an integer between 1 and 200' })
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned as `nextCursor` by the previous page' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @ApiPropertyOptional({ enum: Currency })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(Object.values(Currency), { message: 'currency must be IRT or USDT' })
  currency?: Currency;
}

export class LedgerItemDto {
  @ApiProperty({ example: '1042' })
  id: string;
  @ApiProperty({ example: '517' })
  journalId: string;
  @ApiProperty({ example: 'WITHDRAWAL_HOLD' })
  type: string;
  @ApiProperty({ enum: Currency })
  currency: Currency;
  @ApiProperty({ enum: ['AVAILABLE', 'HELD', 'RECEIVABLE'] })
  account: string;
  @ApiProperty({
    enum: ['DEBIT', 'CREDIT'],
    description: 'CREDIT increases a user balance, DEBIT decreases it',
  })
  direction: string;
  @ApiProperty({ example: '250000' })
  amount: string;
  @ApiProperty({ example: '1250000', nullable: true })
  balanceAfter: string | null;
  @ApiProperty({ example: 'withdrawal' })
  referenceType: string;
  @ApiProperty({ example: '0196a3c2-7a4e-7c1d-9f00-3f1a2b3c4d5e' })
  referenceId: string;
  @ApiProperty({ nullable: true })
  description: string | null;
  @ApiProperty()
  createdAt: string;
}

export class LedgerPageDto {
  @ApiProperty({ type: [LedgerItemDto] })
  items: LedgerItemDto[];
  @ApiProperty({ nullable: true, type: String })
  nextCursor: string | null;
}
