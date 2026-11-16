import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiCreatedResponse, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { markReplay } from '../../common/http/replay-header';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator';
import { CreateTransferDto, TransferResponseDto } from './transfers.dto';
import { TransfersService } from './transfers.service';

@ApiTags('Transfers')
@Controller('transfers')
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  @Post()
  @HttpCode(201)
  @ApiOperation({ summary: 'Atomic transfer between two users (IRT or USDT)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: TransferResponseDto })
  async create(
    @IdempotencyKey() key: string,
    @Body() dto: CreateTransferDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TransferResponseDto> {
    const result = await this.transfers.create(dto, key);
    markReplay(res, result.replayed);
    return result.body;
  }
}
