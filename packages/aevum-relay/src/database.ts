import pg from "pg";
import type { RelayConfig } from "./config.js";

const { Pool } = pg;

export type RelayDatabase = pg.Pool;

export function createDatabase(config: RelayConfig) {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  });
}

export async function migrateDatabase(database: RelayDatabase) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS relay_devices (
      device_public_id TEXT PRIMARY KEY,
      device_secret_hash TEXT NOT NULL,
      access_mode TEXT NOT NULL CHECK (access_mode IN ('read-only','proposals','full-access')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      redirect_uris JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth_sessions (
      session_id TEXT PRIMARY KEY,
      device_public_id TEXT NOT NULL REFERENCES relay_devices(device_public_id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      scopes JSONB NOT NULL,
      state TEXT,
      code_challenge TEXT NOT NULL,
      stage TEXT NOT NULL,
      redirect_url TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS authorization_codes (
      code_hash TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      device_public_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      scopes JSONB NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS oauth_grants (
      grant_id TEXT PRIMARY KEY,
      device_public_id TEXT NOT NULL REFERENCES relay_devices(device_public_id) ON DELETE CASCADE,
      client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      scopes JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      UNIQUE(device_public_id, client_id)
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      grant_id TEXT NOT NULL REFERENCES oauth_grants(grant_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);
    CREATE INDEX IF NOT EXISTS oauth_sessions_device_idx ON oauth_sessions(device_public_id);
    CREATE INDEX IF NOT EXISTS oauth_grants_device_idx ON oauth_grants(device_public_id);
  `);
}
