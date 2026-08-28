import type pg from "pg";

const CONTROL_SQL = `
CREATE SCHEMA IF NOT EXISTS toren_control;
CREATE TABLE IF NOT EXISTS toren_control.agents (
  name text PRIMARY KEY,
  schema_name text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toren_control.queue_messages (
  id bigserial PRIMARY KEY,
  queue text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text,
  visible_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_visible_idx ON toren_control.queue_messages (queue, visible_at) WHERE locked_until IS NULL;
CREATE TABLE IF NOT EXISTS toren_control.dead_letters (
  id bigint PRIMARY KEY,
  queue text NOT NULL,
  payload jsonb NOT NULL,
  attempts int NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toren_control.schedules (
  id uuid PRIMARY KEY,
  agent text NOT NULL,
  name text NOT NULL,
  cron text NOT NULL,
  tz text NOT NULL DEFAULT 'UTC',
  input text NOT NULL,
  process text NOT NULL DEFAULT 'main',
  enabled boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz NOT NULL,
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE toren_control.schedules ADD COLUMN IF NOT EXISTS process text NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS schedules_due_idx ON toren_control.schedules (next_fire_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS toren_control.schedule_fires (
  schedule_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  run_id uuid NOT NULL,
  agent text NOT NULL,
  input text NOT NULL,
  process text NOT NULL DEFAULT 'main',
  fired_at timestamptz NOT NULL DEFAULT now(),
  settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (schedule_id, scheduled_for)
);
ALTER TABLE toren_control.schedule_fires ADD COLUMN IF NOT EXISTS process text NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS schedule_fires_open_idx ON toren_control.schedule_fires (agent) WHERE NOT settled;
CREATE TABLE IF NOT EXISTS toren_control.api_keys (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE TABLE IF NOT EXISTS toren_control.telegram_users (
  user_id bigint PRIMARY KEY,
  paired_at timestamptz NOT NULL DEFAULT now(),
  via_code text
);
CREATE TABLE IF NOT EXISTS toren_control.telegram_invites (
  code text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_by bigint
);
CREATE TABLE IF NOT EXISTS toren_control.telegram_bindings (
  chat_id bigint PRIMARY KEY,
  agent text NOT NULL,
  run_id uuid,
  last_delivered_seq int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toren_control.telegram_state (
  id int PRIMARY KEY DEFAULT 1,
  last_update_id bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS toren_control.telegram_poll_state (
  bot_key text PRIMARY KEY,
  last_update_id bigint NOT NULL DEFAULT 0
);
INSERT INTO toren_control.telegram_poll_state (bot_key, last_update_id)
  SELECT 'default', last_update_id FROM toren_control.telegram_state WHERE id = 1
  ON CONFLICT (bot_key) DO NOTHING;
ALTER TABLE toren_control.telegram_users ADD COLUMN IF NOT EXISTS bot_key text NOT NULL DEFAULT 'default';
ALTER TABLE toren_control.telegram_invites ADD COLUMN IF NOT EXISTS bot_key text NOT NULL DEFAULT 'default';
ALTER TABLE toren_control.telegram_bindings ADD COLUMN IF NOT EXISTS bot_key text NOT NULL DEFAULT 'default';
DO $$ BEGIN
  IF (SELECT count(*) FROM information_schema.key_column_usage
      WHERE table_schema = 'toren_control' AND table_name = 'telegram_users'
        AND constraint_name = 'telegram_users_pkey') = 1 THEN
    ALTER TABLE toren_control.telegram_users DROP CONSTRAINT telegram_users_pkey;
    ALTER TABLE toren_control.telegram_users ADD PRIMARY KEY (bot_key, user_id);
  END IF;
  IF (SELECT count(*) FROM information_schema.key_column_usage
      WHERE table_schema = 'toren_control' AND table_name = 'telegram_bindings'
        AND constraint_name = 'telegram_bindings_pkey') = 1 THEN
    ALTER TABLE toren_control.telegram_bindings DROP CONSTRAINT telegram_bindings_pkey;
    ALTER TABLE toren_control.telegram_bindings ADD PRIMARY KEY (bot_key, chat_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS toren_control.files (
  id text PRIMARY KEY,
  name text NOT NULL,
  media_type text NOT NULL,
  bytes int NOT NULL,
  pages jsonb NOT NULL,
  data bytea,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toren_control.channel_outbox (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL,
  kind text NOT NULL,
  file_id text NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS channel_outbox_pending_idx ON toren_control.channel_outbox (run_id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS toren_control.run_watchers (
  child_run_id uuid PRIMARY KEY,
  parent_run_id uuid NOT NULL,
  agent text NOT NULL,
  process text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS run_watchers_open_idx ON toren_control.run_watchers (agent) WHERE NOT settled;
CREATE TABLE IF NOT EXISTS toren_control.telegram_observations (
  id bigserial PRIMARY KEY,
  bot_key text NOT NULL,
  chat_id bigint NOT NULL,
  chat_type text,
  chat_title text,
  update_type text NOT NULL,
  sender_id bigint,
  sender_username text,
  message_id bigint,
  text text,
  media_type text,
  media_file_id text,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_observations_scan_idx ON toren_control.telegram_observations (bot_key, chat_id, id);
CREATE TABLE IF NOT EXISTS toren_control.workers (
  worker_id text PRIMARY KEY,
  version text NOT NULL,
  hostname text,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS toren_control.sandboxes (
  run_id uuid PRIMARY KEY,
  provider text NOT NULL,
  sandbox_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);
`;

const AGENT_TABLES_SQL = (s: string) => `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.runs (
  run_id uuid PRIMARY KEY,
  agent text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  input jsonb, output jsonb, error jsonb,
  code_hash text, trace_context jsonb,
  mode text NOT NULL DEFAULT 'task',
  process text NOT NULL DEFAULT 'main',
  channel text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${s}.runs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'task';
ALTER TABLE ${s}.runs ADD COLUMN IF NOT EXISTS process text NOT NULL DEFAULT 'main';
ALTER TABLE ${s}.runs ADD COLUMN IF NOT EXISTS channel text;
CREATE TABLE IF NOT EXISTS ${s}.streams (
  run_id uuid NOT NULL, stream_id text NOT NULL,
  head_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stream_id)
);
CREATE TABLE IF NOT EXISTS ${s}.events (
  run_id uuid NOT NULL, stream_id text NOT NULL, seq bigint NOT NULL,
  type text NOT NULL, payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, stream_id, seq)
);
CREATE TABLE IF NOT EXISTS ${s}.leases (
  run_id uuid NOT NULL, stream_id text NOT NULL,
  owner text NOT NULL, epoch bigint NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, stream_id)
);
CREATE TABLE IF NOT EXISTS ${s}.blobs (
  run_id uuid NOT NULL, key text NOT NULL, data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, key)
);
`;

const AGENT_NAME_RE = /^[a-z][a-z0-9_]{0,40}$/;

// Concurrent booters (parallel workers, parallel test files) race CREATE IF NOT EXISTS;
// a transaction-scoped advisory lock serializes DDL. 727001/727002 are arbitrary app-unique keys.
export async function migrateControl(c: pg.PoolClient): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(727001)`);
  await c.query(CONTROL_SQL);
}

export function agentSchemaName(agent: string): string {
  if (!AGENT_NAME_RE.test(agent)) throw new Error(`invalid agent name: ${agent}`);
  return `agent_${agent}`;
}

export async function provisionAgent(c: pg.PoolClient, agent: string): Promise<string> {
  const schema = agentSchemaName(agent);
  await c.query(`SELECT pg_advisory_xact_lock(727002)`);
  await c.query(AGENT_TABLES_SQL(schema));
  await c.query(
    `INSERT INTO toren_control.agents (name, schema_name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
    [agent, schema],
  );
  return schema;
}
