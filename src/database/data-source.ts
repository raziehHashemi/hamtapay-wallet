import { DataSource, DataSourceOptions } from 'typeorm';
import { CreateLedger1794787200000 } from './migrations/1794787200000-CreateLedger';
import { CreateIdempotencyAndOutbox1794787260000 } from './migrations/1794787260000-CreateIdempotencyAndOutbox';
import { CreateDepositsAndWithdrawals1794787320000 } from './migrations/1794787320000-CreateDepositsAndWithdrawals';
import { CreateTransfersAndAdjustments1794787380000 } from './migrations/1794787380000-CreateTransfersAndAdjustments';
import { AddWithdrawalReturnTracking1794830400000 } from './migrations/1794830400000-AddWithdrawalReturnTracking';
import { CreateReconciliationReports1794830460000 } from './migrations/1794830460000-CreateReconciliationReports';

/** Ordered list of versioned migrations. New schema changes are appended, never edited in place. */
export const MIGRATIONS = [
  CreateLedger1794787200000,
  CreateIdempotencyAndOutbox1794787260000,
  CreateDepositsAndWithdrawals1794787320000,
  CreateTransfersAndAdjustments1794787380000,
  AddWithdrawalReturnTracking1794830400000,
  CreateReconciliationReports1794830460000,
];

export function buildDataSourceOptions(databaseUrl: string, poolSize = 10): DataSourceOptions {
  return {
    type: 'postgres',
    url: databaseUrl,
    synchronize: false,
    migrationsRun: false,
    migrations: MIGRATIONS,
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    extra: { max: poolSize, application_name: 'hamtapay-wallet' },
  };
}

/** Used by the TypeORM CLI (`typeorm migration:show -d dist/database/data-source.js`). */
export default new DataSource(
  buildDataSourceOptions(process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet'),
);
