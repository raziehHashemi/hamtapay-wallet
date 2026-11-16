import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppConfig } from '../../config/app-config';
import { Errors } from '../../common/errors/domain-error';
import { parsePositiveAmount } from '../../common/http/money-input';
import { Currency } from '../../common/money/currency';
import { formatMinor, tomanToRial } from '../../common/money/money';
import { uuidv7 } from '../../common/util/ids';
import { queryRows } from '../../database/sql';
import {
  PaymentGateway,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
} from '../../integrations/psp/payment-gateway';
import { IdempotencyService, IdempotentResult } from '../idempotency/idempotency.service';
import { OutboxService } from '../outbox/outbox.service';
import { DepositEntity, DepositStatus } from './deposit.entity';
import { DepositReconciler } from './deposit-reconciler.service';
import { CreateDepositDto, DepositResponseDto } from './deposits.dto';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly gateway: PaymentGateway,
    private readonly idempotency: IdempotencyService,
    private readonly outbox: OutboxService,
    private readonly reconciler: DepositReconciler,
    private readonly config: AppConfig,
  ) {}

  /**
   * Registers the deposit and obtains a payment link, atomically: the deposit row, the link and the
   * idempotency record commit together. The PSP "create payment" call happens inside that transaction; it
   * has no financial side effect (an unpaid link that nobody ever sees is harmless) and a hard timeout.
   */
  async create(dto: CreateDepositDto, key: string): Promise<IdempotentResult<DepositResponseDto>> {
    const amount = parsePositiveAmount(Currency.IRT, dto.amount);
    if (amount.minor < this.config.rules.depositMinIrt) {
      throw Errors.belowMinimum(`minimum deposit is ${this.config.rules.depositMinIrt} IRT`);
    }

    return this.idempotency.execute({ scope: 'deposits.create', key, request: dto }, async (manager) => {
      const id = uuidv7();
      await queryRows(
        manager,
        `INSERT INTO deposits (id, user_id, amount, status, next_check_at)
         VALUES ($1, $2, $3, 'PENDING', now() + make_interval(secs => $4::double precision / 1000))`,
        [id, dto.userId, amount.minor.toString(), this.config.workers.depositFirstCheckMs],
      );

      let payment;
      try {
        payment = await this.gateway.createPayment({
          amountRial: tomanToRial(amount.minor),
          orderId: id,
          callbackUrl: this.config.pspCallbackUrl,
        });
      } catch (error) {
        if (error instanceof PaymentGatewayUnavailableError || error instanceof PaymentGatewayRejectedError) {
          this.logger.warn(`deposit ${id}: PSP create failed: ${error.message}`);
          throw Errors.gatewayUnavailable();
        }
        throw error;
      }

      await queryRows(manager, `UPDATE deposits SET psp_token = $2, payment_url = $3 WHERE id = $1`, [
        id,
        payment.token,
        payment.paymentUrl,
      ]);
      await this.outbox.enqueue(manager, {
        type: 'deposit.created',
        aggregateType: 'deposit',
        aggregateId: id,
        payload: { depositId: id, userId: dto.userId, amount: amount.toString() },
      });
      const deposit = await manager.getRepository(DepositEntity).findOneByOrFail({ id });
      return toDepositResponse(deposit);
    });
  }

  async get(id: string): Promise<DepositResponseDto> {
    const deposit = await this.dataSource.getRepository(DepositEntity).findOneBy({ id });
    if (!deposit) throw Errors.notFound('deposit');
    return toDepositResponse(deposit);
  }

  /** PSP callback: an unauthenticated *hint* that something changed. We look the truth up ourselves. */
  async handleCallback(
    payload: Record<string, unknown>,
  ): Promise<{ received: true; status?: DepositStatus }> {
    const token = typeof payload.token === 'string' ? payload.token : null;
    const deposit = token
      ? await this.dataSource.getRepository(DepositEntity).findOneBy({ pspToken: token })
      : null;
    const orderMismatch = deposit && payload.orderId !== undefined && payload.orderId !== deposit.id;
    await this.recordInbound(
      token,
      payload,
      deposit ? (orderMismatch ? 'order-id-mismatch' : 'accepted') : 'unknown-token',
    );
    if (!deposit) return { received: true };

    try {
      await this.reconciler.reconcile(deposit.id, 'callback');
    } catch (error) {
      // The poller will retry; the PSP does not re-send callbacks, so never fail this request for it.
      this.logger.error(`callback reconcile for deposit ${deposit.id} failed: ${(error as Error).message}`);
    }
    const fresh = await this.dataSource.getRepository(DepositEntity).findOneBy({ id: deposit.id });
    return { received: true, status: fresh?.status };
  }

  private async recordInbound(
    token: string | null,
    payload: Record<string, unknown>,
    outcome: string,
  ): Promise<void> {
    await queryRows(
      this.dataSource.manager,
      `INSERT INTO inbound_events (source, reference, payload, outcome) VALUES ('PSP_CALLBACK', $1, $2, $3)`,
      [token, JSON.stringify(payload ?? {}), outcome],
    );
  }
}

export function toDepositResponse(d: DepositEntity): DepositResponseDto {
  return {
    depositId: d.id,
    status: d.status,
    paymentUrl: d.paymentUrl,
    userId: d.userId,
    amount: formatMinor(Currency.IRT, d.amount),
    creditedAmount: d.creditedAmount === null ? null : formatMinor(Currency.IRT, d.creditedAmount),
    refId: d.pspRefId,
    failureReason: d.failureReason,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export { DepositStatus };
