import { ApiProperty } from '@nestjs/swagger';
import { AmountField, CurrencyField, UserIdField } from '../../common/http/dto-decorators';
import { Currency } from '../../common/money/currency';

export class CreateTransferDto {
  @UserIdField('Sender')
  fromUserId: string;

  @UserIdField('Receiver (wallet is created on first use)')
  toUserId: string;

  @CurrencyField()
  currency: Currency;

  @AmountField('150000')
  amount: string;
}

export class TransferResponseDto {
  @ApiProperty() transferId: string;
  @ApiProperty({
    example: 'SUCCEEDED',
    description: 'Transfers are atomic: they either fully happen or not at all',
  })
  status: string;
  @ApiProperty() fromUserId: string;
  @ApiProperty() toUserId: string;
  @ApiProperty({ enum: Currency }) currency: Currency;
  @ApiProperty({ example: '150000' }) amount: string;
  @ApiProperty() journalId: string;
  @ApiProperty() createdAt: string;
}
