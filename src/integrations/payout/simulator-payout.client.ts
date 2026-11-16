import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/app-config';
import { httpRequest, HttpTransportError } from '../http-client';
import { isProviderStatus, PayoutCallResult, PayoutGateway, PayoutRequest } from './payout-gateway';

type Json = Record<string, unknown>;

@Injectable()
export class SimulatorPayoutClient extends PayoutGateway {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async submit(request: PayoutRequest): Promise<PayoutCallResult> {
    return this.call('POST', '/payout/transfers', request);
  }

  async getTransfer(requestId: string): Promise<PayoutCallResult> {
    return this.call('GET', `/payout/transfers/${encodeURIComponent(requestId)}`);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<PayoutCallResult> {
    let res;
    try {
      res = await httpRequest(method, `${this.config.payout.baseUrl}${path}`, {
        body,
        timeoutMs: this.config.payout.timeoutMs,
      });
    } catch (error) {
      if (error instanceof HttpTransportError) return { kind: 'UNKNOWN', reason: error.message };
      throw error;
    }
    const json = (typeof res.body === 'object' && res.body !== null ? res.body : {}) as Json;
    if (res.status === 200 || res.status === 201 || res.status === 202) {
      if (!isProviderStatus(json.status)) {
        return { kind: 'UNKNOWN', reason: `unexpected provider status ${String(json.status)}` };
      }
      return {
        kind: 'OK',
        transfer: {
          requestId: String(json.requestId),
          trackingId: json.trackingId == null ? null : String(json.trackingId),
          status: json.status,
          reason: json.reason == null ? null : String(json.reason),
          occurredAt: json.updatedAt == null ? null : String(json.updatedAt),
        },
      };
    }
    if (res.status === 404 && method === 'GET') return { kind: 'NOT_FOUND' };
    // Only validation errors are definitive "not created". 408/409/429/5xx and anything else stay UNKNOWN.
    if ((res.status === 400 || res.status === 422) && method === 'POST') {
      return {
        kind: 'REJECTED',
        httpStatus: res.status,
        error: String(json.error ?? res.text.slice(0, 100)),
      };
    }
    return { kind: 'UNKNOWN', reason: `HTTP ${res.status}: ${res.text.slice(0, 100)}` };
  }
}
