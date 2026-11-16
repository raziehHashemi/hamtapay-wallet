import { ApiProperty } from '@nestjs/swagger';
import { AmountField, UserIdField } from '../../common/http/dto-decorators';
import { DepositStatus } from './deposit.entity';

export class CreateDepositDto {
  @UserIdField()
  userId: string;

  @AmountField('500000')
  amount: string;
}

export class DepositResponseDto {
  @ApiProperty({ example: '0196a3c2-7a4e-7c1d-9f00-3f1a2b3c4d5e' })
  depositId: string;
  @ApiProperty({ enum: DepositStatus, description: 'Final states: SUCCEEDED, FAILED' })
  status: DepositStatus;
  @ApiProperty({ nullable: true, type: String, example: 'http://simulator:8080/psp/pay/A0d1c8...' })
  paymentUrl: string | null;
  @ApiProperty() userId: string;
  @ApiProperty({ example: '500000', description: 'Requested amount (IRT, Toman)' })
  amount: string;
  @ApiProperty({ nullable: true, type: String, description: 'Amount actually credited (IRT)' })
  creditedAmount: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Bank/PSP tracking number (refId)' })
  refId: string | null;
  @ApiProperty({ nullable: true, type: String }) failureReason: string | null;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}
