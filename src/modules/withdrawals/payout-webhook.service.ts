import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { isUuid } from '../../common/util/ids';
import { queryRows } from '../../database/sql';
import { isProviderStatus } from '../../integrations/payout/payout-gateway';
import { WithdrawalEntity } from './withdrawal.entity';
import { WithdrawalProcessor } from './withdrawal-processor.service';
import { verifyWebhookSignature } from './webhook-signature';

/**
 * Payout webhook. Verified with HMAC over the raw body (forged FAILED webhooks exist, provider-notes §P5),
 * then applied through the same state machine as polling. Duplicates and stale PROCESSING events after a final
 * state are harmless (monotonic transitions). Every delivery — accepted or not — is kept in `inbound_events`.
 */
@Injectable()
export class PayoutWebhookService {
  private readonly logger = new Logger(PayoutWebhookService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly processor: WithdrawalProcessor,
    private readonly config: AppConfig,
  ) {}

  async handle(rawBody: Buffer | undefined, signature: unknown, body: Record<string, unknown>) {
    const signatureOk = verifyWebhookSignature(rawBody, signature, this.config.payout.webhookSecret);
    const requestId = typeof body.requestId === 'string' ? body.requestId : null;
    const eventId = typeof body.eventId === 'string' ? body.eventId : null;

    if (!signatureOk) {
      await this.audit(eventId, requestId, false, body, 'rejected: bad signature');
      this.logger.warn(`rejected payout webhook with invalid signature (requestId=${requestId}, status=${String(body.status)})`);
      throw Errors.invalidSignature();
    }
    if (!requestId || !isProviderStatus(body.status)) {
      await this.audit(eventId, requestId, true, body, 'ignored: malformed');
      throw Errors.validation('webhook must carry requestId and a known status');
    }
    const exists =
      isUuid(requestId) && (await this.dataSource.getRepository(WithdrawalEntity).existsBy({ id: requestId }));
    if (!exists) {
      await this.audit(eventId, requestId, true, body, 'ignored: unknown requestId');
      return { received: true, applied: 'UNKNOWN_REQUEST' };
    }

    const transition = await this.processor.apply(
      requestId,
      {
        status: body.status,
        reason: typeof body.reason === 'string' ? body.reason : null,
        trackingId: typeof body.trackingId === 'string' ? body.trackingId : null,
        occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : null,
      },
      'webhook',
    );
    await this.audit(eventId, requestId, true, body, `applied: ${transition}`);
    return { received: true, applied: transition };
  }

  private async audit(
    eventId: string | null,
    requestId: string | null,
    signatureOk: boolean,
    payload: Record<string, unknown>,
    outcome: string,
  ): Promise<void> {
    await queryRows(
      this.dataSource.manager,
      `INSERT INTO inbound_events (source, external_id, reference, signature_ok, payload, outcome)
       VALUES ('PAYOUT_WEBHOOK', $1, $2, $3, $4, $5)`,
      [eventId, requestId, signatureOk, JSON.stringify(payload ?? {}), outcome],
    );
  }
}
