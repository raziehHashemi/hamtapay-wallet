import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Errors } from '../../common/errors/domain-error';
import { markReplay } from '../../common/http/replay-header';
import { isUuid } from '../../common/util/ids';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator';
import { CreateDepositDto, DepositResponseDto } from './deposits.dto';
import { DepositsService } from './deposits.service';

@ApiTags('Deposits')
@Controller()
export class DepositsController {
  constructor(private readonly deposits: DepositsService) {}

  @Post('deposits')
  @HttpCode(201)
  @ApiOperation({ summary: 'Register an IRT deposit and get the payment-gateway link' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: DepositResponseDto })
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateDepositDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DepositResponseDto> {
    const result = await this.deposits.create(dto, key);
    markReplay(res, result.replayed);
    return result.body;
  }

  @Get('deposits/:id')
  @ApiOperation({ summary: 'Deposit status' })
  @ApiOkResponse({ type: DepositResponseDto })
  get(@Param('id') id: string): Promise<DepositResponseDto> {
    if (!isUuid(id)) throw Errors.notFound('deposit');
    return this.deposits.get(id);
  }

  @Post('webhooks/psp/callback')
  @HttpCode(200)
  @ApiTags('Webhooks')
  @ApiOperation({
    summary: 'Payment-gateway callback (no Idempotency-Key)',
    description: 'Treated as a hint only; the result is always confirmed with PSP inquiry + verify.',
  })
  callback(@Body() body: Record<string, unknown>) {
    return this.deposits.handleCallback(body ?? {});
  }
}
