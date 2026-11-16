import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { Errors } from '../../common/errors/domain-error';
import { InternalApiKeyGuard } from '../../common/http/internal-api-key.guard';
import { ReconciliationReport, ReconciliationService } from './reconciliation.service';

export class RunReconciliationDto {
  @ApiProperty({ example: '2026-11-16', description: 'Settlement day (Asia/Tehran calendar day)' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;
}

@ApiTags('Reconciliation')
@ApiSecurity('internal-api-key')
@UseGuards(InternalApiKeyGuard)
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Compare the PSP settlement report of a day with our transactions (report only, fixes nothing)',
    description: 'No Idempotency-Key: the run has no side effect on balances (each run is stored as a report).',
  })
  @ApiOkResponse({ description: '{ date, summary, mismatches: [{ type, reference, ... }], warnings }' })
  run(@Body() dto: RunReconciliationDto): Promise<ReconciliationReport> {
    const parsed = new Date(`${dto.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dto.date) {
      throw Errors.validation('date is not a valid calendar date');
    }
    return this.reconciliation.run(dto.date);
  }
}
