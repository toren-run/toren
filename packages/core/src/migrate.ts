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
  enabled boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz NOT NULL,
  last_fired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON toren_control.schedules (next_fire_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS toren_control.schedule_fires (
  schedule_id uuid NOT NULL,
  scheduled_for timestamptz NOT NULL,
  run_id uuid NOT NULL,
  agent text NOT NULL,
  input text NOT NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  settled boolean NOT NULL DEFAULT false,
  PRIMARY KEY (schedule_id, scheduled_for)
);
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
`;

const AGENT_TABLES_SQL = (s: string) => `
CREATE SCHEMA IF NOT EXISTS ${s};
CREATE TABLE IF NOT EXISTS ${s}.runs (
  run_id uuid PRIMARY KEY,
  agent text NOT NULL,
  status text NOT NULL DEFAULT 'created',
  input jsonb, output jsonb, error jsonb,
  code_hash text, trace_context jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
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
