import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { queryOne } from '../../database/sql';
import { EventPublisher } from '../outbox/event-publisher';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly publisher: EventPublisher,
    private readonly config: AppConfig,
  ) {}

  @Get('live')
  @ApiOperation({ summary: 'Liveness: the process is up' })
  live() {
    return { status: 'ok' };
  }

  @Get()
  @ApiOperation({
    summary: 'Readiness',
    description: 'Ready iff PostgreSQL answers. A broker outage only degrades (events wait in the outbox).',
  })
  @ApiOkResponse({ description: '{ status, database, broker, outboxBacklog }' })
  async ready(@Res({ passthrough: true }) res: Response) {
    let database = 'up';
    let outboxBacklog: number | null = null;
    try {
      const row = await queryOne<{ n: string }>(
        this.dataSource.manager,
        `SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL`,
      );
      outboxBacklog = Number(row?.n ?? 0);
    } catch {
      database = 'down';
    }
    const broker = this.config.rabbitmqUrl ? (this.publisher.isHealthy() ? 'up' : 'down') : 'disabled';
    const status = database === 'down' ? 'down' : broker === 'down' ? 'degraded' : 'ok';
    if (status === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status, database, broker, outboxBacklog, workers: this.config.workersEnabled };
  }
}
