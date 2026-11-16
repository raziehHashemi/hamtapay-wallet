import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Errors } from '../../common/errors/domain-error';
import { InternalApiKeyGuard } from '../../common/http/internal-api-key.guard';
import { markReplay } from '../../common/http/replay-header';
import { isUuid } from '../../common/util/ids';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator';
import { IntegrityReport, LedgerIntegrityService } from '../ledger/ledger-integrity.service';
import { AdjustmentResponseDto, CreateAdjustmentDto, ReverseAdjustmentDto } from './adjustments.dto';
import { AdjustmentsService } from './adjustments.service';

@ApiTags('Operations (internal)')
@ApiSecurity('internal-api-key')
@UseGuards(InternalApiKeyGuard)
@Controller('internal')
export class OperationsController {
  constructor(
    private readonly adjustments: AdjustmentsService,
    private readonly integrity: LedgerIntegrityService,
  ) {}

  @Post('adjustments')
  @HttpCode(201)
  @ApiOperation({ summary: 'Manually increase a user balance (with a mandatory reason); double-entry' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: AdjustmentResponseDto })
  async createAdjustment(
    @IdempotencyKey() key: string,
    @Body() dto: CreateAdjustmentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdjustmentResponseDto> {
    const result = await this.adjustments.create(dto, key);
    markReplay(res, result.replayed);
    return result.body;
  }

  @Post('adjustments/:id/reverse')
  @HttpCode(201)
  @ApiOperation({ summary: 'Correct a mistaken adjustment with a reversal journal (never edits the ledger)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: AdjustmentResponseDto })
  async reverseAdjustment(
    @IdempotencyKey() key: string,
    @Param('id') id: string,
    @Body() dto: ReverseAdjustmentDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdjustmentResponseDto> {
    if (!isUuid(id)) throw Errors.notFound('adjustment');
    const result = await this.adjustments.reverse(id, dto, key);
    markReplay(res, result.replayed);
    return result.body;
  }

  @Get('ledger/integrity')
  @ApiOperation({
    summary: 'Re-derive ledger invariants from raw entries',
    description: 'Balanced journals, stored balance == Σ entries for every user account, no negative balance.',
  })
  @ApiOkResponse({ description: 'Integrity report' })
  checkIntegrity(): Promise<IntegrityReport> {
    return this.integrity.check();
  }
}
