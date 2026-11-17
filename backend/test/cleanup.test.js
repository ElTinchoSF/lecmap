// Test de integración del limpiador de audios huérfanos.
// El bug real vive en la query de referenciados (listAudioPaths), así que
// probar contra un mock no probaría nada: usa Postgres temporal en Docker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPg } from './helpers/pg.js';

let pgTest;
let cleanupMod;
let dbMod;
let uploadsDir;

before(async () => {
  pgTest = await startPg({ name: 'lecmap-test-cleanup', port: 54390 });
  dbMod = await import('../src/db.js');
  cleanupMod = await import('../src/cleanup.js');
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-uploads-'));
}, { timeout: 60_000 });

after(async () => {
  await dbMod?.closePool?.();
  await pgTest?.stop();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
}, { timeout: 30_000 });

test('cleanup conserva el audio referenciado por una nota', async () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const audioPath = path.join(uploadsDir, 'clase-2h.wav');
  await writeFile(audioPath, 'fake-audio');

  await dbMod.createRecording({
    id: 'notaref1', userId, title: 'Clase con audio', audioPath, createdAt: new Date().toISOString(),
  });

  const removed = await cleanupMod.cleanupOrphanAudio(null, uploadsDir);

  // El bug: listAudioPaths() sin userId filtraba user_id=NULL → 0 filas →
  // referenced vacío → el limpiador borraba el audio referenciado.
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
