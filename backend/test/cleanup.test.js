// Test de integración del limpiador de audios huérfanos.
// Usa un Postgres temporal en Docker (postgres:16-alpine): el bug real vive en
// la query de referenciados (listAudioPaths), así que probar contra un mock no
// probaría nada. Si Docker no está disponible, el test falla con mensaje claro.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

const CONTAINER = 'lecmap-test-pg';
const PORT = 54390;
const DB_URL = `postgresql://postgres:test@127.0.0.1:${PORT}/lecmap_test`;

const SCHEMA = `
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
`;

let adminPool;
let cleanupMod;
let dbMod;
let uploadsDir;

async function waitForPg(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const c = new pg.Client({ connectionString: DB_URL });
      await c.connect();
      await c.end();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('Postgres de test no arrancó en 15 s');
}

before(async () => {
  try {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    execFileSync('docker', [
      'run', '--rm', '-d',
      '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=test',
      '-e', 'POSTGRES_DB=lecmap_test',
      '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
    ], { stdio: 'ignore' });
  } catch (e) {
    throw new Error(`Docker no disponible (requerido para este test): ${e.message}`);
  }
  await waitForPg();

  adminPool = new pg.Pool({ connectionString: DB_URL });
  await adminPool.query(SCHEMA);

  // El pool de db.js se crea al importar: DATABASE_URL debe estar seteada antes.
  process.env.DATABASE_URL = DB_URL;
  delete process.env.NODE_ENV; // ssl=false contra el Postgres local
  dbMod = await import('../src/db.js');
  cleanupMod = await import('../src/cleanup.js');

  uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-uploads-'));
}, { timeout: 60_000 });

after(async () => {
  await dbMod?.closePool?.();
  await adminPool?.end();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
  try {
    execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  } catch { /* ya no existe */ }
}, { timeout: 30_000 });

test('cleanup conserva el audio referenciado por una nota', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const audioPath = path.join(uploadsDir, 'clase-2h.wav');
  await writeFile(audioPath, 'fake-audio');

  await dbMod.createRecording({
    id: 'notaref1', userId, title: 'Clase con audio', audioPath, createdAt: new Date().toISOString(),
  });

  const removed = await cleanupMod.cleanupOrphanAudio(null, uploadsDir);

  // El bug: listAudioPaths() sin userId filtra user_id=NULL → 0 filas →
  // referenced vacío → el limpiador borra el audio referenciado.
  await assert.doesNotReject(
    () => access(audioPath),
    'el audio de la nota referenciada NO debe borrarse por el cleanup',
  );
  assert.equal(removed, 0, 'no debe eliminar archivos referenciados');
});

test('cleanup elimina archivos huérfanos reales', async () => {
  const orphan = path.join(uploadsDir, 'orfano.wav');
  await writeFile(orphan, 'nadie-me-referencia');

  const removed = await cleanupMod.cleanupOrphanAudio(null, uploadsDir);

  assert.equal(removed, 1, 'debe eliminar exactamente el huérfano');
  await assert.rejects(() => access(orphan), 'el huérfano ya no existe');
}, { timeout: 30_000 });
