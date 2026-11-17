// T8 (S3 de odd/tasks/beta-infra-oracle.md): segments.speaker real end-to-end.
// Stub del worker devuelve agrupaciones NO alternantes (S0,S0,S1,S1) para
// probar que llega la diarización real y no la paridad i%2 de antes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPg } from './helpers/pg.js';

const PG_PORT = 54394;
const USER = '44444444-4444-4444-8444-444444444444';

// Agrupación real de diarización (no alternancia): docente habla 2 turnos
// seguidos, luego el alumno. La paridad i%2 daría 1,2,1,2 — acá debe dar
// 1,1,2,2.
const WORKER_SEGMENTS = [
  { start: 0, end: 5, speaker: 'S0', text: 'Buenos días, arrancamos la clase.' },
  { start: 5, end: 10, speaker: 'S0', text: 'Hoy vemos la Revolución Industrial.' },
  { start: 10, end: 15, speaker: 'S1', text: 'Doctor, ¿entra en el parcial?' },
  { start: 15, end: 20, speaker: 'S1', text: 'Sí, todo lo de hoy entra.' },
];

let pgTest;
let db;
let runner;
let app;
let stub;
let uploadsDir;
let audioFile;

before(async () => {
  pgTest = await startPg({ name: 'lecmap-test-transcribe', port: PG_PORT });
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-transcribe-'));
  audioFile = path.join(uploadsDir, 'clase.webm');
  await writeFile(audioFile, 'audio-fake');

  stub = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ duration: 20, segments: WORKER_SEGMENTS }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));

  // Env ANTES de importar index.js (WORKER_URL es const a nivel de módulo).
  process.env.SUPABASE_URL = '';
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.WORKER_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.OPENAI_API_KEY = 'fake';

  const mod = await import('../src/index.js');
  runner = mod.runnerHandlers;
  app = mod.app;
  db = await import('../src/db.js');
}, { timeout: 60_000 });

after(async () => {
  await new Promise((r) => (stub ? stub.close(r) : r()));
  await db?.closePool();
  await pgTest?.stop();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
}, { timeout: 30_000 });

test('S3: la diarización del worker llega a la DB agrupada y legible (no paridad i%2)', async () => {
  await db.createRecording({
    id: 'notat8', userId: USER, title: 'Clase', audioPath: audioFile,
    createdAt: new Date().toISOString(),
  });

  await runner.transcribe({ recording_id: 'notat8', user_id: USER });

  const r = await db.getRecording('notat8', USER);
  assert.equal(r.transcript.length, 4, 'los 4 segmentos del worker se persisten');
  // Agrupación real: 1,1,2,2 (la paridad i%2 daría 1,2,1,2).
  assert.deepEqual(
    r.transcript.map((s) => s.speaker),
    ['Hablante 1', 'Hablante 1', 'Hablante 2', 'Hablante 2'],
    'speaker agrupado por diarización y mapeado a labels legibles',
  );
  // Ningún ID crudo del worker se filtra a la UI.
  for (const s of r.transcript) {
    assert.ok(!/^(S\d+|SPEAKER_)/.test(s.speaker), `label crudo filtrado: ${s.speaker}`);
  }
  // El alumno (S1 → Hablante 2) queda como hablante distinto del docente.
  assert.equal(r.transcript[2].speaker, 'Hablante 2', 'turno del alumno etiquetado como hablante distinto');
  assert.equal(r.transcript[0].speaker, r.transcript[1].speaker, 'turnos consecutivos del mismo hablante agrupan');
  assert.notEqual(r.transcript[0].speaker, r.transcript[2].speaker, 'alumno ≠ docente');
  // El audio ya no se necesita tras transcribir (comportamiento preexistente).
  assert.equal(r.audioPath, null);
  assert.equal(r.durationSeconds, 20, 'duración reconciliada con la del worker');
});

// ---------- T9: renombrar hablantes por nota (S3) ----------
const DEV = '00000000-0000-4000-8000-000000000000';

async function makeNoteWithSpeakers(id) {
  await db.createRecording({
    id, userId: DEV, title: 'Clase', createdAt: new Date().toISOString(),
  });
  await db.saveTranscript(id, DEV, [
    { start: 0, end: 5, speaker: 'Hablante 1', text: 'hola' },
    { start: 5, end: 9, speaker: 'Hablante 1', text: 'chau' },
    { start: 9, end: 12, speaker: 'Hablante 2', text: 'ok' },
  ]);
}

const patchSpeaker = (id, from, to) => app.inject({
  method: 'PATCH',
  url: `/recordings/${id}/speakers`,
  headers: { 'content-type': 'application/json' },
  payload: { from, to },
});
const getSpeakers = async (id) => (await app.inject({ method: 'GET', url: `/recordings/${id}` }))
  .json().transcript.map((s) => s.speaker);

test('T9: el renombre persiste por nota en la API sin tocar la diarización original', async () => {
  await makeNoteWithSpeakers('notarename');

  const res = await patchSpeaker('notarename', 'Hablante 1', 'Docente Pérez');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await getSpeakers('notarename'),
    ['Docente Pérez', 'Docente Pérez', 'Hablante 2'], 'el mapa se aplica al leer');

  // La diarización original queda intacta en segments (S3: sin alterarla).
  const { rows } = await db.pool.query(
    'SELECT speaker FROM segments WHERE recording_id = $1 ORDER BY idx', ['notarename']);
  assert.deepEqual(rows.map((r) => r.speaker),
    ['Hablante 1', 'Hablante 1', 'Hablante 2'], 'segments conserva los labels originales');
});

test('T9: renombrar desde el nombre visible, revivir, aislar por nota y rechazos', async () => {
  await makeNoteWithSpeakers('notaB');

  // Desde el nombre visible (ya renombrada en notarename).
  assert.equal((await patchSpeaker('notarename', 'Docente Pérez', 'Profe G.')).statusCode, 200);
  assert.deepEqual(await getSpeakers('notarename'), ['Profe G.', 'Profe G.', 'Hablante 2']);

  // Revivir con to vacío vuelve al label original.
  assert.equal((await patchSpeaker('notarename', 'Profe G.', '')).statusCode, 200);
  assert.deepEqual(await getSpeakers('notarename'), ['Hablante 1', 'Hablante 1', 'Hablante 2']);

  // El renombre vive en la nota: notaB no se afecta.
  assert.deepEqual(await getSpeakers('notaB'), ['Hablante 1', 'Hablante 1', 'Hablante 2']);

  assert.equal((await patchSpeaker('notaB', 'NoExiste', 'X')).statusCode, 400, 'label desconocido → 400');
  assert.equal((await patchSpeaker('notaB', 'Hablante 1', 'Hablante 2')).statusCode, 400,
    'nombre duplicado en la misma nota → 400');
});
