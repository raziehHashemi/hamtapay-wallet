import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyAndOutbox1794787260000 implements MigrationInterface {
  name = 'CreateIdempotencyAndOutbox1794787260000';

  async up(q: QueryRunner): Promise<void> {
    // Written in the same transaction as the business effect, so "effect happened" <=> "key completed".
    await q.query(`
      CREATE TABLE idempotency_keys (
        scope           TEXT NOT NULL,
        key             TEXT NOT NULL,
        request_hash    TEXT NOT NULL,
        response_status INT,
        response_body   JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at    TIMESTAMPTZ,
        PRIMARY KEY (scope, key)
      )`);

    // Transactional outbox: rows are inserted with the balance change and relayed to the broker afterwards.
    await q.query(`
      CREATE TABLE outbox_events (
        id             BIGSERIAL PRIMARY KEY,
        event_id       UUID NOT NULL UNIQUE,
        event_type     TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        aggregate_id   TEXT NOT NULL,
        payload        JSONB NOT NULL,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        published_at   TIMESTAMPTZ,
        attempts       INT NOT NULL DEFAULT 0,
        last_error     TEXT
      )`);
    await q.query(
      `CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL`,
    );

    // Consumer-side inbox: (consumer, event_id) makes re-delivered events a no-op.
    await q.query(`
      CREATE TABLE processed_events (
        consumer     TEXT NOT NULL,
        event_id     UUID NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (consumer, event_id)
      )`);
    await q.query(`
      CREATE TABLE user_notifications (
        id         BIGSERIAL PRIMARY KEY,
        event_id   UUID NOT NULL UNIQUE,
        user_id    TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload    JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX user_notifications_user_idx ON user_notifications (user_id, id DESC)`);

    // Audit trail of everything external systems sent us (callbacks, webhooks), including rejected ones.
    await q.query(`
      CREATE TABLE inbound_events (
        id           BIGSERIAL PRIMARY KEY,
        source       TEXT NOT NULL,
        external_id  TEXT,
        reference    TEXT,
        signature_ok BOOLEAN,
        payload      JSONB NOT NULL,
        outcome      TEXT,
        received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX inbound_events_reference_idx ON inbound_events (source, reference)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE inbound_events`);
    await q.query(`DROP TABLE user_notifications`);
    await q.query(`DROP TABLE processed_events`);
    await q.query(`DROP TABLE outbox_events`);
    await q.query(`DROP TABLE idempotency_keys`);
  }
}
