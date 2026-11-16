import { AppConfig } from './app-config';

describe('AppConfig', () => {
  it('has the business-rule defaults from the brief', () => {
    const config = new AppConfig({});
    expect(config.rules.withdrawalMin).toEqual({ IRT: 100_000n, USDT: 10_000_000n });
    expect(config.rules.withdrawalFee).toEqual({ IRT: 0n, USDT: 1_000_000n });
    expect(config.rules.dailyWithdrawalLimitIrt).toBe(200_000_000n);
    expect(config.rules.limitTimezone).toBe('Asia/Tehran');
  });

  it('derives the PSP callback URL', () => {
    expect(new AppConfig({ PUBLIC_BASE_URL: 'http://app:3000/' }).pspCallbackUrl).toBe(
      'http://app:3000/webhooks/psp/callback',
    );
  });

  it('parses money settings exactly', () => {
    const config = new AppConfig({ WITHDRAWAL_MIN_USDT: '10.5', USDT_IRT_RATE: '112345' });
    expect(config.rules.withdrawalMin.USDT).toBe(10_500_000n);
    expect(config.rules.usdtIrtRate).toBe(112_345n);
  });

  it('refuses to start with invalid values, listing all of them', () => {
    expect(
      () =>
        new AppConfig({
          PORT: 'abc',
          WORKERS_ENABLED: 'maybe',
          PSP_BASE_URL: 'ftp://x',
          WITHDRAWAL_MIN_IRT: '1.5',
        }),
    ).toThrow(/PORT[\s\S]*WORKERS_ENABLED[\s\S]*PSP_BASE_URL[\s\S]*WITHDRAWAL_MIN_IRT/);
  });

  it('treats empty optional values as unset', () => {
    const config = new AppConfig({ RABBITMQ_URL: '', INTERNAL_API_KEY: '  ' });
    expect(config.rabbitmqUrl).toBeNull();
    expect(config.internalApiKey).toBeNull();
  });
});
