// T7 (S1 + S7) de odd/tasks/beta-infra-oracle.md: cuota de audio diaria por
// usuario + rate limiting por usuario en los endpoints de IA.
// Modo dev (sin SUPABASE_URL): identidad única DEV_USER_ID en uuid.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPg } from './helpers/pg.js';

const PG_PORT = 54393;
const DEV_USER_ID = '00000000-0000-4000-8000-000000000000';
const QUOTA = 3600; // QUOTA_AUDIO_SECONDS_PER_DAY del before()

let pgTest;
let app;
let dbMod;
let quota;
let rl;
let uploadsDir;
// Notas creadas por tests previos, reutilizadas por los de re-upload.
let primeraId;
let primeraAudioPath;
let chicaId;
let chicaAudioPath;

/**
 * multipart con title + audio + duration. El campo duration va DESPUÉS del
 * archivo a propósito: el server debe acumular el form completo antes de
 * decidir, sin depender del orden de las partes.
 */
function multipart({ title, filename, content, duration = null }) {
  const boundary = '----lecmapquota';
  const head = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
  ].join(''));
  const durationPart = duration === null ? ''
    : `\r\n--${boundary}\r\nContent-Disposition: form-data; name="duration"\r\n\r\n${duration}`;
  const tail = Buffer.from(`\r\n${durationPart}\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(content), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload({ title, filename, content, duration = null }) {
  const mp = multipart({ title, filename, content, duration });
  return app.inject({ method: 'POST', url: '/recordings', headers: mp.headers, payload: mp.payload });
}

const countRecordings = async () =>
  (await pgTest.pool.query('SELECT count(*)::int AS n FROM recordings')).rows[0].n;

async function insertNota(id, userId, durationSeconds, createdAt) {
  await pgTest.pool.query(
    `INSERT INTO recordings (id, user_id, title, status, created_at, duration_seconds)
     VALUES ($1, $2, 'nota de prueba', 'ready', $3, $4)`,
    [id, userId, createdAt, durationSeconds],
  );
}

before(async () => {
  pgTest = await startPg({ name: 'lecmap-test-quota', port: PG_PORT });
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-quota-uploads-'));

  // Env ANTES de importar index.js. SUPABASE_URL='' fuerza modo dev aunque
  // .env traiga una URL (dotenv no pisa claves ya presentes).
  process.env.SUPABASE_URL = '';
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.QUOTA_AUDIO_SECONDS_PER_DAY = String(QUOTA);
  process.env.OPENAI_API_KEY = 'fake'; // pasa el chequeo de config del transcribe
  process.env.RL_TRANSCRIBE_MAX = '2';

  const mod = await import('../src/index.js');
  app = mod.app;
  dbMod = await import('../src/db.js');
  quota = await import('../src/quota.js');
  rl = await import('../src/ratelimit.js');
}, { timeout: 60_000 });

after(async () => {
  await app?.close();
  await dbMod?.closePool();
  await pgTest?.stop();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
}, { timeout: 30_000 });

// ---------- identidad dev (bug latente: 'dev-user' no es uuid) ----------

test('modo dev: upload corto → 200, el listado lo ve y el user_id es uuid válido', async () => {
  const res = await upload({ title: 'Nota dev', filename: 'dev.webm', content: 'bytes-dev', duration: 60 });
  assert.equal(res.statusCode, 200, res.body);
  const rec = res.json();
  assert.equal(rec.durationSeconds, 60);

  const list = await app.inject({ method: 'GET', url: '/recordings' });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(
    list.json().items.some((i) => i.id === rec.id),
    'la nota subida debe aparecer en GET /recordings',
  );

  // Si la identidad dev no fuera uuid, este SELECT (y el INSERT previo) revientan.
  const { rows } = await pgTest.pool.query('SELECT user_id FROM recordings WHERE id = $1', [rec.id]);
  assert.equal(rows[0].user_id, DEV_USER_ID);
});

// ---------- S1: cuota de audio diaria en el upload ----------

test('upload con duration=4000 supera la cuota → 429 quota_exceeded sin crear fila', async () => {
  const rowsBefore = await countRecordings();
  const filesBefore = await readdir(uploadsDir);

  const res = await upload({ title: 'Clase larga', filename: 'larga.webm', content: 'audio-largo', duration: 4000 });
  assert.equal(res.statusCode, 429, res.body);
  const body = res.json();
  assert.equal(body.code, 'quota_exceeded');
  assert.equal(body.used_seconds, 60);
  assert.equal(body.quota_seconds, QUOTA);
  assert.equal(body.remaining_seconds, QUOTA - 60);
  assert.match(body.error, /Límite diario de audio alcanzado/);

  // Entrada rechazada: no crea nota y no deja archivo huérfano.
  assert.equal(await countRecordings(), rowsBefore, 'no debe crear la nota al rechazar por cuota');
  assert.deepEqual(await readdir(uploadsDir), filesBefore, 'no debe dejar el audio en uploads/');
});

test('upload 2000 s guarda duration_seconds; el segundo 2000 s acumula → 429', async () => {
  const ok = await upload({ title: 'Primera mitad', filename: 'una.webm', content: 'bytes-a', duration: 2000 });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().durationSeconds, 2000);
  primeraId = ok.json().id;
  primeraAudioPath = ok.json().audioPath;

  const over = await upload({ title: 'Segunda mitad', filename: 'dos.webm', content: 'bytes-b', duration: 2000 });
  assert.equal(over.statusCode, 429, over.body);
  const body = over.json();
  assert.equal(body.code, 'quota_exceeded');
  assert.equal(body.used_seconds, 2060); // 60 (nota dev) + 2000
  assert.equal(body.quota_seconds, QUOTA);
  assert.equal(body.remaining_seconds, QUOTA - 2060);
  assert.equal(await countRecordings(), 2, 'solo la nota dev + la primera; la rechazada no crea fila');
});

// ---------- S7: rate limiting por usuario ----------

test('transcribe: 3er POST en el mismo minuto → 429 rate_limited + Retry-After', async () => {
  const up = await upload({ title: 'Chiquita', filename: 'chica.webm', content: 'bytes-c', duration: 10 });
  assert.equal(up.statusCode, 200, up.body);
  const recId = up.json().id;
  chicaId = recId;
  chicaAudioPath = up.json().audioPath;

  for (const attempt of [1, 2]) {
    const r = await app.inject({ method: 'POST', url: `/recordings/${recId}/transcribe` });
    assert.equal(r.statusCode, 202, `intento ${attempt}: ${r.body}`);
  }

  const third = await app.inject({ method: 'POST', url: `/recordings/${recId}/transcribe` });
  assert.equal(third.statusCode, 429, third.body);
  const body = third.json();
  assert.equal(body.code, 'rate_limited');
  assert.equal(typeof body.retry_after_seconds, 'number');
  assert.ok(body.retry_after_seconds > 0);
  assert.ok(third.headers['retry-after'], 'debe llevar header Retry-After');
  assert.match(body.error, /Demasiadas solicitudes de transcripción/);
});

// ---------- re-upload: POST /recordings/:id/audio ----------

test('re-upload reemplaza el audio y NO cuenta dos veces la misma nota', async () => {
  const filesBefore = await readdir(uploadsDir);
  const mp = multipart({ title: 'Primera mitad', filename: 're.webm', content: 'bytes-re', duration: 1600 });
  const res = await app.inject({
    method: 'POST', url: `/recordings/${primeraId}/audio`, headers: mp.headers, payload: mp.payload,
  });
  // Sin excludeRecordingId sería 2070 + 1600 > 3600 → 429: el re-upload
  // reemplaza la nota, no suma presupuesto nuevo.
  assert.equal(res.statusCode, 200, res.body);
  const rec = res.json();
  assert.equal(rec.durationSeconds, 1600, 'la nota queda con la duración del audio nuevo');
  assert.notEqual(rec.audioPath, primeraAudioPath, 'audioPath apunta al archivo nuevo');
  assert.equal(await countRecordings(), 3, 'el re-upload no crea notas');

  const files = await readdir(uploadsDir);
  assert.ok(!files.includes(path.basename(primeraAudioPath)), 'el archivo viejo se borró');
  assert.equal(files.length, filesBefore.length, 'no quedan archivos huérfanos');
});

test('re-upload sobre la cuota → 429 y la nota conserva su audio anterior', async () => {
  const filesBefore = (await readdir(uploadsDir)).sort();
  const mp = multipart({ title: 'Chiquita', filename: 'nuevo.webm', content: 'bytes-nuevo', duration: 4000 });
  const res = await app.inject({
    method: 'POST', url: `/recordings/${chicaId}/audio`, headers: mp.headers, payload: mp.payload,
  });
  assert.equal(res.statusCode, 429, res.body);
  assert.equal(res.json().code, 'quota_exceeded');

  const after = await app.inject({ method: 'GET', url: `/recordings/${chicaId}` });
  assert.equal(after.json().audioPath, chicaAudioPath, 'el audio viejo sigue intacto');
  assert.equal(after.json().durationSeconds, 10, 'la duración vieja no cambia');
  assert.deepEqual((await readdir(uploadsDir)).sort(), filesBefore, 'el audio recién escrito se borró');
});

// ---------- módulo quota ----------

test('getQuotaSeconds: override por usuario vs default; usage con exclude y QUOTA_TZ', async () => {
  const prevQuota = process.env.QUOTA_AUDIO_SECONDS_PER_DAY;
  const prevTz = process.env.QUOTA_TZ;
  process.env.QUOTA_AUDIO_SECONDS_PER_DAY = '100';
  process.env.QUOTA_TZ = 'America/Argentina/Buenos_Aires';
  try {
    const conOverride = '11111111-1111-1111-1111-111111111111';
    const sinFila = '22222222-2222-2222-2222-222222222222';
    const filaNull = '33333333-3333-3333-3333-333333333333';
    await pgTest.pool.query(
      'INSERT INTO profiles (id, quota_seconds_per_day) VALUES ($1, 7200), ($2, NULL)',
      [conOverride, filaNull],
    );

    assert.equal(await quota.getQuotaSeconds(conOverride), 7200, 'override del usuario');
    assert.equal(await quota.getQuotaSeconds(sinFila), 100, 'sin fila → default global');
    assert.equal(await quota.getQuotaSeconds(filaNull), 100, 'fila con NULL → default global');

    // Uso del día (QUOTA_TZ) + exclude de la propia nota.
    await insertNota('notahoy1', sinFila, 50, new Date().toISOString());
    await insertNota('notahoy2', sinFila, 30, new Date().toISOString());
    await insertNota('notaayer', sinFila, 999, new Date(Date.now() - 2 * 86400_000).toISOString());

    assert.equal(await quota.getUsageSeconds(sinFila), 80, 'solo las de hoy; la de hace 2 días no suma');
    assert.equal(
      await quota.getUsageSeconds(sinFila, { excludeRecordingId: 'notahoy2' }),
      50,
      'excludeRecordingId no cuenta la propia nota',
    );

    await assert.rejects(() => quota.assertQuota(sinFila, 30, {}), (e) => {
      assert.equal(e.code, 'quota_exceeded');
      assert.equal(e.used, 80);
      assert.equal(e.quota, 100);
      assert.equal(e.remaining, 20);
      return true;
    });
    assert.deepEqual(await quota.assertQuota(sinFila, 20, {}), { used: 80, quota: 100, remaining: 20 });
  } finally {
    if (prevQuota === undefined) delete process.env.QUOTA_AUDIO_SECONDS_PER_DAY;
    else process.env.QUOTA_AUDIO_SECONDS_PER_DAY = prevQuota;
    if (prevTz === undefined) delete process.env.QUOTA_TZ;
    else process.env.QUOTA_TZ = prevTz;
  }
});

test('resolveDurationSeconds: clientSeconds > bytes > 1, nunca null', async () => {
  const fake = path.join(uploadsDir, 'no-existe.webm');
  assert.equal(await quota.resolveDurationSeconds(fake, 123, 99_999), 123, 'cliente manda');
  assert.equal(await quota.resolveDurationSeconds(fake, null, 8000), 2, 'bytes / 4000 (32 kbps)');
  assert.equal(await quota.resolveDurationSeconds(fake, 0, 1500), 1, 'piso de 1 s');
  assert.notEqual(await quota.resolveDurationSeconds(fake, null, 0), null, 'nunca null');
});

test('ratelimit: con max 2 la tercera llamada lanza rate_limited', () => {
  const user = 'ratelimit-unit-user';
  rl.checkRateLimit(user, 'transcribe');
  rl.checkRateLimit(user, 'transcribe');
  assert.throws(() => rl.checkRateLimit(user, 'transcribe'), (e) => {
    assert.equal(e.code, 'rate_limited');
    assert.ok(e.retryAfterSec > 0);
    assert.match(e.message, /transcripción/);
    return true;
  });
  // Ventanas y acciones independientes.
  rl.checkRateLimit(user, 'ask');
  rl.checkRateLimit('otro-usuario', 'transcribe');
  rl.checkRateLimit(user, 'summarize'); // acción distinta: no lanza
});

// ---------- corrección de review: R1-001 / R4-2 / R4-1 ----------
test('R1-001: duration declarada 1 s con archivo de 8 MB se cobra por bytes', async () => {
  const fake = path.join(uploadsDir, 'spoof.webm');
  const secs = await quota.resolveDurationSeconds(fake, 1, 8_000_000);
  assert.equal(secs, 2000, 'el 1 s mentiroso cae en la estimación por bytes (32 kbps)');
});

test('R1-001: upload con duration=1 y archivo real guarda la duración por bytes', async () => {
  const content = 'x'.repeat(4_000_000); // 4 MB ≈ 1000 s a 32 kbps
  const res = await upload({ title: 'Spoof', filename: 'spoof.webm', content, duration: 1 });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().durationSeconds, 1000, 'el server ignora el 1 s mentiroso');
});

test('R4-2: withQuotaLock serializa check+insert concurrentes del usuario', async () => {
  const uid = '77777777-7777-4777-8777-777777777777';
  const d = 3000; // QUOTA=3600: cada uno entra solo; juntos exceden
  const results = await Promise.all([1, 2].map(() => quota
    .withQuotaLock(uid, async () => {
      await quota.assertQuota(uid, d, {});
      await insertNota(`lock-${Date.now()}-${Math.random().toString(36).slice(2)}`, uid, d, new Date().toISOString());
      return 'ok';
    })
    .catch((e) => e.code)));
  assert.deepEqual(results.sort(), ['ok', 'quota_exceeded'],
    'la segunda sección crítica debe ver el insert de la primera');
});

test('R4-1: ffprobe corre sin bloquear el event loop', async () => {
  const binDir = await mkdtemp(path.join(tmpdir(), 'lecmap-ffprobe-'));
  await writeFile(path.join(binDir, 'ffprobe'),
    '#!/bin/sh\nif [ "$1" = "-version" ]; then echo fake; exit 0; fi\nsleep 1\necho 42.5\n',
    { mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = binDir + path.delimiter + prevPath;
  quota.resetFfprobeCache();
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 50);
  try {
    const secs = await quota.resolveDurationSeconds(path.join(uploadsDir, 'x.webm'), null, 0);
    assert.equal(secs, 43, 'ffprobe async devuelve la duración medida (42.5 → 43)');
    assert.ok(ticks >= 5, `event loop bloqueado durante el spawn: solo ${ticks} ticks`);
  } finally {
    clearInterval(iv);
    process.env.PATH = prevPath;
    quota.resetFfprobeCache();
    await rm(binDir, { recursive: true, force: true });
  }
});
