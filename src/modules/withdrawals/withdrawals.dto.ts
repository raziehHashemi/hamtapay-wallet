import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { AmountField, CurrencyField, UserIdField } from '../../common/http/dto-decorators';
import { Currency } from '../../common/money/currency';
import { NormalizeUserId } from '../../common/validation/user-id';
import { WithdrawalStatus } from './withdrawal.entity';

export class CreateWithdrawalDto {
  @UserIdField()
  userId: string;

  @CurrencyField()
  currency: Currency;

  @AmountField('250000')
  amount: string;

  @ApiProperty({
    example: 'IR820540102680020817909002',
    description: 'IRT: Iranian IBAN (Sheba). USDT: TRC20 address.',
  })
  @IsString({ message: 'destination must be a string' })
  destination: string;
}

export class CancelWithdrawalDto {
  @ApiPropertyOptional({ description: 'If given, must match the withdrawal owner' })
  @IsOptional()
  @NormalizeUserId()
  @IsString()
  userId?: string;
}

export class WithdrawalResponseDto {
  @ApiProperty() withdrawalId: string;
  @ApiProperty({ enum: WithdrawalStatus, description: 'Final states: SUCCEEDED, FAILED' })
  status: WithdrawalStatus;
  @ApiProperty() userId: string;
  @ApiProperty({ enum: Currency }) currency: Currency;
  @ApiProperty({ example: '250000' }) amount: string;
  @ApiProperty({ example: '0', description: 'Fee deducted on top of the amount (USDT: 1)' }) fee: string;
  @ApiProperty() destination: string;
  @ApiProperty({ nullable: true, type: String, example: null }) failureReason: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Payout provider tracking id' })
  trackingId: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
