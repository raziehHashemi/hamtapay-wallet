import { Currency } from '../common/money/currency';
import { Money } from '../common/money/money';

/**
 * Typed, validated configuration. Built once from the environment at boot; the process refuses to start on
 * an invalid value instead of discovering it on the first money movement.
 */
export class AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolSize: number;
  /** Base URL other systems use to reach this service (PSP callback URL is derived from it). */
  readonly publicBaseUrl: string;
  readonly workersEnabled: boolean;
  readonly internalApiKey: string | null;
  readonly rabbitmqUrl: string | null;

  readonly psp: { baseUrl: string; timeoutMs: number };
  readonly payout: { baseUrl: string; timeoutMs: number; webhookSecret: string };

  readonly rules: {
    depositMinIrt: bigint;
    withdrawalMin: Record<Currency, bigint>;
    withdrawalFee: Record<Currency, bigint>;
    dailyWithdrawalLimitIrt: bigint;
    /** Toman per 1 USDT, used to count USDT withdrawals against the Toman daily cap. */
    usdtIrtRate: bigint;
    limitTimezone: string;
  };

  readonly workers: {
    pollIntervalMs: number;
    withdrawalDispatchDelayMs: number;
    withdrawalLeaseMs: number;
    withdrawalPollCapMs: number;
    withdrawalReviewAfterMs: number;
    returnWatchMs: number;
    depositFirstCheckMs: number;
    depositPollCapMs: number;
    depositStopPollingAfterMs: number;
    outboxIntervalMs: number;
  };

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const r = new EnvReader(env);
    this.port = r.int('PORT', 3000);
    this.databaseUrl = r.string('DATABASE_URL', 'postgres://wallet:wallet@localhost:5432/wallet');
    this.dbPoolSize = r.int('DB_POOL_SIZE', 20);
    this.publicBaseUrl = r.url('PUBLIC_BASE_URL', `http://localhost:${this.port}`);
    this.workersEnabled = r.bool('WORKERS_ENABLED', true);
    this.internalApiKey = r.optional('INTERNAL_API_KEY');
    this.rabbitmqUrl = r.optional('RABBITMQ_URL');

    this.psp = {
      baseUrl: r.url('PSP_BASE_URL', 'http://localhost:8080'),
      timeoutMs: r.int('PSP_TIMEOUT_MS', 5000),
    };
    this.payout = {
      baseUrl: r.url('PAYOUT_BASE_URL', 'http://localhost:8080'),
      timeoutMs: r.int('PAYOUT_TIMEOUT_MS', 10000),
      webhookSecret: r.string('PAYOUT_WEBHOOK_SECRET', 'hamtapay-sim-secret'),
    };

    this.rules = {
      depositMinIrt: r.money(Currency.IRT, 'DEPOSIT_MIN_IRT', '1000'),
      withdrawalMin: {
        [Currency.IRT]: r.money(Currency.IRT, 'WITHDRAWAL_MIN_IRT', '100000'),
        [Currency.USDT]: r.money(Currency.USDT, 'WITHDRAWAL_MIN_USDT', '10'),
      },
      withdrawalFee: {
        [Currency.IRT]: r.money(Currency.IRT, 'WITHDRAWAL_FEE_IRT', '0'),
        [Currency.USDT]: r.money(Currency.USDT, 'WITHDRAWAL_FEE_USDT', '1'),
      },
      dailyWithdrawalLimitIrt: r.money(Currency.IRT, 'DAILY_WITHDRAWAL_LIMIT_IRT', '200000000'),
      usdtIrtRate: r.money(Currency.IRT, 'USDT_IRT_RATE', '100000'),
      limitTimezone: r.string('LIMIT_TIMEZONE', 'Asia/Tehran'),
    };

    this.workers = {
      pollIntervalMs: r.int('WORKER_POLL_INTERVAL_MS', 1000),
      withdrawalDispatchDelayMs: r.int('WITHDRAWAL_DISPATCH_DELAY_MS', 0),
      withdrawalLeaseMs: r.int('WITHDRAWAL_LEASE_MS', 30000),
      withdrawalPollCapMs: r.int('WITHDRAWAL_POLL_CAP_MS', 60000),
      withdrawalReviewAfterMs: r.int('WITHDRAWAL_REVIEW_AFTER_MS', 30 * 60000),
      returnWatchMs: r.int('PAYOUT_RETURN_WATCH_MS', 60 * 60000),
      depositFirstCheckMs: r.int('DEPOSIT_FIRST_CHECK_MS', 5000),
      depositPollCapMs: r.int('DEPOSIT_POLL_CAP_MS', 30000),
      depositStopPollingAfterMs: r.int('DEPOSIT_STOP_POLLING_AFTER_MS', 24 * 3600000),
      outboxIntervalMs: r.int('OUTBOX_INTERVAL_MS', 500),
    };

    r.throwIfInvalid();
  }

  get pspCallbackUrl(): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/webhooks/psp/callback`;
  }
}

class EnvReader {
  private readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  optional(name: string): string | null {
    const value = this.env[name]?.trim();
    return value ? value : null;
  }

  string(name: string, fallback: string): string {
    return this.optional(name) ?? fallback;
  }

  int(name: string, fallback: number): number {
    const raw = this.optional(name);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw)) {
      this.problems.push(`${name} must be a non-negative integer`);
      return fallback;
    }
    return Number(raw);
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.optional(name);
    if (raw === null) return fallback;
    if (!['true', 'false', '1', '0'].includes(raw)) {
      this.problems.push(`${name} must be true/false`);
      return fallback;
    }
    return raw === 'true' || raw === '1';
  }

  url(name: string, fallback: string): string {
    const value = this.string(name, fallback);
    if (!/^https?:\/\/\S+$/.test(value)) this.problems.push(`${name} must be an http(s) URL`);
    return value.replace(/\/$/, '');
  }

  money(currency: Currency, name: string, fallback: string): bigint {
    const raw = this.string(name, fallback);
    try {
      return Money.parse(currency, raw).minor;
    } catch (error) {
      this.problems.push(`${name}: ${(error as Error).message}`);
      return 0n;
    }
  }

  throwIfInvalid(): void {
    if (this.problems.length) {
      throw new Error(`Invalid configuration:\n - ${this.problems.join('\n - ')}`);
    }
  }
}
