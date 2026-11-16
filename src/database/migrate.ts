import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './data-source';

/**
 * Applies pending migrations under a PostgreSQL advisory lock, so several instances (or the compose
 * `migrate` job racing an app start) can never run the same migration twice.
 */
export async function runMigrations(databaseUrl: string, log: (line: string) => void = console.log): Promise<void> {
  const dataSource = new DataSource(buildDataSourceOptions(databaseUrl, 2));
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.connect();
    await runner.query(`SELECT pg_advisory_lock(hashtext('hamtapay-wallet:migrations'))`);
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    log(applied.length ? `applied migrations: ${applied.map((m) => m.name).join(', ')}` : 'schema is up to date');
  } finally {
    await runner.query(`SELECT pg_advisory_unlock(hashtext('hamtapay-wallet:migrations'))`).catch(() => undefined);
    await runner.release();
    await dataSource.destroy();
  }
}

if (require.main === module) {
  runMigrations(process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet').catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
