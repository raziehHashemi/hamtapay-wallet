import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AmountField, CurrencyField, UserIdField } from '../../common/http/dto-decorators';
import { Currency } from '../../common/money/currency';

const trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export class CreateAdjustmentDto {
  @UserIdField()
  userId: string;

  @CurrencyField()
  currency: Currency;

  @AmountField('500000')
  amount: string;

  @ApiProperty({ example: 'Compensation for incident INC-2041 (duplicate fee)', maxLength: 500 })
  @trim()
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ example: 'ops.sara', description: 'Who performed the adjustment (audit trail)' })
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  operator?: string;
}

export class ReverseAdjustmentDto {
  @ApiProperty({ example: 'Credited to the wrong user', maxLength: 500 })
  @trim()
  @IsString()
  @IsNotEmpty({ message: 'reason is required' })
  @MaxLength(500)
  reason: string;
}

export class AdjustmentResponseDto {
  @ApiProperty() adjustmentId: string;
  @ApiProperty() journalId: string;
  @ApiProperty() userId: string;
  @ApiProperty({ enum: Currency }) currency: Currency;
  @ApiProperty({ example: '500000' }) amount: string;
  @ApiProperty() reason: string;
  @ApiProperty({ nullable: true, type: String }) operator: string | null;
  @ApiProperty({ nullable: true, type: String }) reversalJournalId: string | null;
  @ApiProperty() createdAt: string;
}
