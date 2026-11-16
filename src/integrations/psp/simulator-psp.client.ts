import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { httpRequest, HttpTransportError } from '../http-client';
import {
  CreatedPayment,
  CreatePaymentCommand,
  PaymentGateway,
  PaymentGatewayRejectedError,
  PaymentGatewayUnavailableError,
  PaymentInquiry,
  VerifyOutcome,
} from './payment-gateway';

/** PSP response codes observed on the simulator (see docs/provider-notes.md). */
const CODE_OK = 100;
const CODE_ALREADY_VERIFIED = 101;
const CODE_NOT_PAID = -51;
const CODE_EXPIRED = -54;

type Json = Record<string, unknown>;

@Injectable()
export class SimulatorPspClient extends PaymentGateway {
  private readonly logger = new Logger(SimulatorPspClient.name);

  constructor(private readonly config: AppConfig) {
    super();
  }

  async createPayment(command: CreatePaymentCommand): Promise<CreatedPayment> {
    const res = await this.call('POST', '/psp/payments', {
      amount: command.amountRial.toString(),
      callbackUrl: command.callbackUrl,
      orderId: command.orderId,
    });
    const body = res.body as Json;
    if (res.status >= 500) throw new PaymentGatewayUnavailableError(`PSP create returned ${res.status}`);
    if (res.status >= 400 || typeof body?.token !== 'string' || typeof body?.paymentUrl !== 'string') {
      throw new PaymentGatewayRejectedError(`PSP rejected payment: ${res.text.slice(0, 200)}`, body?.code);
    }
    return { token: body.token, paymentUrl: body.paymentUrl };
  }

  async inquire(token: string): Promise<PaymentInquiry | null> {
    const res = await this.call('GET', `/psp/payments/${encodeURIComponent(token)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new PaymentGatewayUnavailableError(`PSP inquiry returned ${res.status}`);
    const body = res.body as Json;
    return {
      token: String(body.token),
      orderId: body.orderId == null ? null : String(body.orderId),
      status: String(body.status),
      amountRial: BigInt(String(body.amount)),
      refId: body.refId == null ? null : String(body.refId),
    };
  }

  async verify(token: string): Promise<VerifyOutcome> {
    let res;
    try {
      res = await this.call('POST', '/psp/verify', { token });
    } catch (error) {
      return { kind: 'UNAVAILABLE', reason: (error as Error).message };
    }
    if (res.status === 404) return { kind: 'UNKNOWN_TOKEN' };
    if (res.status !== 200) return { kind: 'UNAVAILABLE', reason: `verify returned HTTP ${res.status}` };
    // Business result is in `code`, not in the HTTP status (failures come back as HTTP 200).
    const body = res.body as Json;
    const code = Number(body.code);
    if (code === CODE_OK || code === CODE_ALREADY_VERIFIED) {
      return {
        kind: 'VERIFIED',
        amountRial: BigInt(String(body.amount)),
        refId: String(body.refId),
        alreadyVerified: code === CODE_ALREADY_VERIFIED,
      };
    }
    if (code === CODE_EXPIRED) return { kind: 'EXPIRED', code, message: String(body.message ?? body.status) };
    if (code === CODE_NOT_PAID)
      return { kind: 'NOT_PAID', code, message: String(body.message ?? body.status) };
    this.logger.warn(`unexpected verify response: ${res.text.slice(0, 200)}`);
    return { kind: 'UNAVAILABLE', reason: `unexpected verify code ${code}` };
  }

  async fetchSettlementCsv(date: string): Promise<string> {
    const res = await this.call('GET', `/psp/settlement?date=${encodeURIComponent(date)}`);
    if (res.status !== 200) throw new PaymentGatewayUnavailableError(`settlement returned ${res.status}`);
    return res.text;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    try {
      return await httpRequest(method, `${this.config.psp.baseUrl}${path}`, {
        body,
        timeoutMs: this.config.psp.timeoutMs,
      });
    } catch (error) {
      if (error instanceof HttpTransportError) throw new PaymentGatewayUnavailableError(error.message);
      throw error;
    }
  }
}
