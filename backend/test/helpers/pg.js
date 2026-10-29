// Postgres temporal en Docker para tests de integración de backend.
// Compuesto por cada suite: startPg() en before(), stopPg() en after().
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const DEFAULT_PORT = 54390;

export const BASE_SCHEMA = `
CREATE TABLE recordings (
  id text PRIMARY KEY,
  user_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  error text,
  audio_path text,
  youtube_url text,
  summary text,
  mindmap jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE segments (
  recording_id text NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  idx integer NOT NULL,
  start double precision NOT NULL,
  "end" double precision NOT NULL,
  speaker text NOT NULL,
  text text NOT NULL,
  PRIMARY KEY (recording_id, idx)
);
-- Espejo de supabase/migrations/002_jobs.sql
CREATE TABLE jobs (
  id text PRIMARY KEY,
  recording_id text NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL,
  params jsonb,
  status text NOT NULL DEFAULT 'queued',
  error text,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_jobs_active
  ON jobs (recording_id, kind)
  WHERE status IN ('queued', 'running');
CREATE INDEX idx_jobs_claim ON jobs (kind, status, available_at);
`;

async function waitForPg(dbUrl, retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const c = new pg.Client({ connectionString: dbUrl });
      await c.connect();
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Postgres de test no arrancó en ${retries / 2} s`);
}

/**
 * Levanta postgres:16-alpine efímero, crea el esquema base y setea
 * process.env.DATABASE_URL para que db.js (pool al importar) lo use.
 * Devuelve { dbUrl, pool, stop }.
 */
export async function startPg({ name = 'lecmap-test-pg', port = DEFAULT_PORT, schema = BASE_SCHEMA } = {}) {
  const dbUrl = `postgresql://postgres:test@127.0.0.1:${port}/lecmap_test`;
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '--rm', '-d',
      '--name', name,
      '-e', 'POSTGRES_PASSWORD=test',
      '-e', 'POSTGRES_DB=lecmap_test',
      '-p', `127.0.0.1:${port}:5432`,
      'postgres:16-alpine',
    ], { stdio: 'ignore' });
  } catch (e) {
    throw new Error(`Docker no disponible (requerido para tests de integración): ${e.message}`);
  }
  await waitForPg(dbUrl);

  const pool = new pg.Pool({ connectionString: dbUrl });
  if (schema) await pool.query(schema);

  process.env.DATABASE_URL = dbUrl;
  delete process.env.NODE_ENV; // ssl=false contra el Postgres local

  return {
    dbUrl,
    pool,
    async stop() {
      await pool.end();
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch { /* ya no existe */ }
    },
  };
}
