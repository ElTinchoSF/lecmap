// Tests de la cola de trabajos en DB (S7 de odd/tasks/beta-infra-oracle.md).
// El runner del backend es `node --test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startPg } from './helpers/pg.js';

const USER = '11111111-1111-1111-1111-111111111111';

let pgTest;
let db;

before(async () => {
  pgTest = await startPg({ name: 'lecmap-test-jobs', port: 54392 });
  db = await import('../src/db.js');
  await db.createRecording({
    id: 'notajob1', userId: USER, title: 'Clase', createdAt: new Date().toISOString(),
  });
}, { timeout: 60_000 });

after(async () => {
  await db?.closePool();
  await pgTest?.stop();
}, { timeout: 30_000 });

test('encolar y reclamar: el trabajo pasa a running con lock', async () => {
  const job = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'transcribe' });
  assert.equal(job.status, 'queued');

  const claimed = await db.claimJob('transcribe', 'host-a:100');
  assert.ok(claimed, 'debe reclamar el trabajo encolado');
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.locked_by, 'host-a:100');

  // Nadie más lo reclama mientras esté tomado.
  const again = await db.claimJob('transcribe', 'host-b:200');
  assert.equal(again, null);

  await db.finishJob(job.id);
});

test('dedupe: un solo trabajo activo por nota+tipo', async () => {
  const job1 = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'summarize' });
  const job2 = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'summarize' });
  assert.equal(job1.id, job2.id, 'no debe duplicar el trabajo activo');
  await db.finishJob(job1.id);
});

test('failJob reintenta hasta JOB_MAX_ATTEMPTS y luego queda error', async () => {
  const job = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'transcribe' });
  await db.claimJob('transcribe', 'host-a:100');

  let result = await db.failJob(job.id, 'worker caído', 'host-a:100');
  assert.equal(result.status, 'queued', 'primer fallo → reintentable');
  assert.equal(result.attempts, 1);

  for (let i = 1; i < db.JOB_MAX_ATTEMPTS; i++) {
    // El backoff deja available_at en el futuro: lo vence el test.
    await db.pool.query('UPDATE jobs SET available_at = now() WHERE id = $1', [job.id]);
    const claimedRetry = await db.claimJob('transcribe', 'host-a:100');
    assert.ok(claimedRetry, `debe poder reclamar el reintento ${i}`);
    result = await db.failJob(job.id, 'worker caído', 'host-a:100');
  }
  assert.equal(result.status, 'error');
  assert.equal(result.attempts, db.JOB_MAX_ATTEMPTS);
});

test('trabajo de instancia muerta (stale) se reclama de nuevo', async () => {
  const job = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'transcribe' });
  await db.claimJob('transcribe', 'host-muerto:1');
  // Simula un lock viejo (instancia que no existe).
  await db.pool.query(
    'UPDATE jobs SET locked_at = now() - make_interval(mins => $1) WHERE id = $2',
    [db.JOB_STALE_MIN + 1, job.id],
  );

  const claimed = await db.claimJob('transcribe', 'host-vivo:2');
  assert.ok(claimed, 'el trabajo stale debe ser reclamable');
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.locked_by, 'host-vivo:2');
  await db.finishJob(job.id);
});

test('borrar la nota borra sus trabajos (cascade)', async () => {
  await db.createRecording({
    id: 'notajob2', userId: USER, title: 'Otra', createdAt: new Date().toISOString(),
  });
  const job = await db.enqueueJob({ recordingId: 'notajob2', userId: USER, kind: 'transcribe' });
  await db.deleteRecording('notajob2', USER);
  const row = await db.pool.query('SELECT id FROM jobs WHERE id = $1', [job.id]);
  assert.equal(row.rows.length, 0);
});

test('finishJob deja done y libera el lock', async () => {
  const job = await db.enqueueJob({ recordingId: 'notajob1', userId: USER, kind: 'summarize' });
  await db.claimJob('summarize', 'host-c:1');
  const done = await db.finishJob(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.locked_by, null);
});
