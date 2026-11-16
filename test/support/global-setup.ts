import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';
import { runMigrations } from '../../src/database/migrate';

declare global {
  var __PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Integration tests run against a REAL PostgreSQL:
 *  - default: a throwaway container started with Testcontainers (only Docker is required);
 *  - or an existing server via TEST_DATABASE_URL (its database name must contain "test"; it is wiped).
 */
export default async function globalSetup(): Promise<void> {
  let url = process.env.TEST_DATABASE_URL;
  if (url) {
    const dbName = new URL(url).pathname.slice(1);
    if (!dbName.includes('test'))
      throw new Error(`refusing to wipe "${dbName}": TEST_DATABASE_URL must point to a *test* database`);
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await client.end();
  } else {
    const container = await new PostgreSqlContainer('postgres:16.15-alpine')
      .withDatabase('wallet_test')
      .withUsername('test')
      .withPassword('test')
      .withCommand([
        'postgres',
        '-c',
        'max_connections=300',
        '-c',
        'fsync=off',
        '-c',
        'synchronous_commit=off',
      ])
      .start();
    globalThis.__PG_CONTAINER__ = container;
    url = container.getConnectionUri();
  }
  process.env.TEST_DATABASE_URL = url;
  await runMigrations(url, () => undefined);
  console.log(`\nintegration database ready (${url.replace(/:[^:@/]+@/, ':***@')})`);
}
