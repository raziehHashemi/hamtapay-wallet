import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Errors } from '../../common/errors/domain-error';
import { InternalApiKeyGuard } from '../../common/http/internal-api-key.guard';
import { markReplay } from '../../common/http/replay-header';
import { isUuid } from '../../common/util/ids';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator';
import { PayoutWebhookService } from './payout-webhook.service';
import { CancelWithdrawalDto, CreateWithdrawalDto, WithdrawalResponseDto } from './withdrawals.dto';
import { WithdrawalsService } from './withdrawals.service';

@ApiTags('Withdrawals')
@Controller()
export class WithdrawalsController {
  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly webhook: PayoutWebhookService,
  ) {}

  @Post('withdrawals')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Request a withdrawal (IRT → IBAN, USDT → TRC20)',
    description:
      'Funds are held immediately; the payout happens asynchronously. Errors: 400 INVALID_DESTINATION, ' +
      '422 BELOW_MINIMUM / INSUFFICIENT_FUNDS / DAILY_LIMIT_EXCEEDED / IDEMPOTENCY_KEY_REUSED.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: WithdrawalResponseDto })
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateWithdrawalDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WithdrawalResponseDto> {
    const result = await this.withdrawals.create(dto, key);
    markReplay(res, result.replayed);
    return result.body;
  }

  @Get('withdrawals/:id')
  @ApiOperation({ summary: 'Withdrawal status' })
  @ApiOkResponse({ type: WithdrawalResponseDto })
  get(@Param('id') id: string): Promise<WithdrawalResponseDto> {
    if (!isUuid(id)) throw Errors.notFound('withdrawal');
    return this.withdrawals.get(id);
  }

  @Post('withdrawals/:id/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel a withdrawal that has not been sent to the payout provider yet (status PENDING)',
    description: '409 WITHDRAWAL_NOT_CANCELLABLE once it is PROCESSING or final. See docs/ambiguities.md #3.',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: WithdrawalResponseDto })
  async cancel(
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() dto: CancelWithdrawalDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WithdrawalResponseDto> {
    if (!isUuid(id)) throw Errors.notFound('withdrawal');
    const result = await this.withdrawals.cancel(id, key, dto?.userId);
    markReplay(res, result.replayed);
    return result.body;
  }

  @Post('webhooks/payout')
  @HttpCode(200)
  @ApiTags('Webhooks')
  @ApiOperation({ summary: 'Payout provider webhook (HMAC-SHA256 in X-Signature, no Idempotency-Key)' })
  @ApiHeader({ name: 'X-Signature', required: true })
  payoutWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    return this.webhook.handle(req.rawBody, signature, body ?? {});
  }

  @Get('internal/withdrawals/review')
  @UseGuards(InternalApiKeyGuard)
  @ApiTags('Operations (internal)')
  @ApiSecurity('internal-api-key')
  @ApiOperation({ summary: 'Withdrawals flagged for a human (no final answer for too long, late success, ...)' })
  reviewQueue() {
    return this.withdrawals.reviewQueue();
  }
}
