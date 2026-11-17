// Tests de integración de la API (S6b–S6e de odd/tasks/beta-infra-oracle.md).
// Autenticación real simulada: JWKS local servido por un http server + JWT
// firmado con jose — así se prueba el flujo completo sin tocar Supabase.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { startPg } from './helpers/pg.js';

const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const JWKS_PORT = 54395;

let pgTest;
let app;
let dbMod;
let uploadsDir;
let jwksServer;
let privateKey;
const SUPABASE_URL = `http://127.0.0.1:${JWKS_PORT}`;

async function mintToken(sub) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

/** Multipart manual: título + audio. */
function multipart(title, filename, content) {
  const boundary = '----lecmaptest';
  const parts = [
    `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  ];
  const head = Buffer.from(parts.join(''));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, Buffer.from(content), tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

before(async () => {
  pgTest = await startPg({ name: 'lecmap-test-api', port: 54391 });
  uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-api-uploads-'));

  // JWKS falso (Supabase local): jose lo consume vía createRemoteJWKSet.
  const { publicKey, privateKey: priv } = await generateKeyPair('ES256', { extractable: true });
  privateKey = priv;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };
  jwksServer = http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => jwksServer.listen(JWKS_PORT, '127.0.0.1', r));

  // Env ANTES de importar index.js (SUPABASE_URL, uploads, tamaño).
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.MAX_UPLOAD_MB = '1';
  const mod = await import('../src/index.js');
  app = mod.app;
  dbMod = await import('../src/db.js');
}, { timeout: 60_000 });

after(async () => {
  await app?.close();
  await dbMod?.closePool();
  await new Promise((r) => jwksServer.close(r));
  await pgTest?.stop();
  if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
}, { timeout: 30_000 });

test('preflight CORS acepta PATCH (renombrar notas)', async () => {
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/recordings/abc',
    headers: {
      origin: 'https://lecmap.app',
      'access-control-request-method': 'PATCH',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.equal(res.statusCode, 204);
  assert.ok(
    String(res.headers['access-control-allow-methods']).includes('PATCH'),
    `allow-methods debe incluir PATCH, got: ${res.headers['access-control-allow-methods']}`,
  );
});

test('auth: sin token responde 401 con WWW-Authenticate', async () => {
  const res = await app.inject({ method: 'GET', url: '/recordings' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['www-authenticate'], 'Bearer');
});

test('upload válido crea nota; /files con token del dueño sirve el audio', async () => {
  const tokenA = await mintToken(USER_A);
  const mp = multipart('Clase de prueba', 'clase.webm', 'fake-audio-bytes');
  const res = await app.inject({
    method: 'POST',
    url: '/recordings',
    headers: { ...mp.headers, authorization: `Bearer ${tokenA}` },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 200, res.body);
  const rec = res.json();
  assert.ok(rec.audioPath, 'la nota debe tener audioPath');
  assert.equal(rec.transcript.length, 0);

  const name = path.basename(rec.audioPath);
  const owner = await app.inject({ method: 'GET', url: `/files/${name}?token=${encodeURIComponent(tokenA)}` });
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.body, 'fake-audio-bytes');
});

test('/files: token de otro usuario → 404 (no revela existencia)', async () => {
  const tokenA = await mintToken(USER_A);
  const tokenB = await mintToken(USER_B);
  const mp = multipart('Nota ajena', 'ajena.webm', 'contenido-ajeno');
  const res = await app.inject({
    method: 'POST',
    url: '/recordings',
    headers: { ...mp.headers, authorization: `Bearer ${tokenA}` },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 200);
  const name = path.basename(res.json().audioPath);

  const other = await app.inject({ method: 'GET', url: `/files/${name}?token=${encodeURIComponent(tokenB)}` });
  assert.equal(other.statusCode, 404);
});

test('/files: sin token → 401; con header Authorization también sirve', async () => {
  const tokenA = await mintToken(USER_A);
  const mp = multipart('Nota con header', 'header.webm', 'bytes-header');
  const res = await app.inject({
    method: 'POST',
    url: '/recordings',
    headers: { ...mp.headers, authorization: `Bearer ${tokenA}` },
    payload: mp.payload,
  });
  const name = path.basename(res.json().audioPath);

  const noToken = await app.inject({ method: 'GET', url: `/files/${name}` });
  assert.equal(noToken.statusCode, 401);

  const withHeader = await app.inject({
    method: 'GET',
    url: `/files/${name}`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(withHeader.statusCode, 200);
  assert.equal(withHeader.body, 'bytes-header');
});

test('upload con extensión no soportada → 400 con catálogo de formatos', async () => {
  const tokenA = await mintToken(USER_A);
  const mp = multipart('Archivo raro', 'malware.txt', 'no-es-audio');
  const res = await app.inject({
    method: 'POST',
    url: '/recordings',
    headers: { ...mp.headers, authorization: `Bearer ${tokenA}` },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /Formato de audio no soportado/);
});

test('upload sobre el límite (MAX_UPLOAD_MB=1) → 413', async () => {
  const tokenA = await mintToken(USER_A);
  const big = 'x'.repeat(1.5 * 1024 * 1024); // 1,5 MB > 1 MB
  const mp = multipart('Audio largo', 'largo.webm', big);
  const res = await app.inject({
    method: 'POST',
    url: '/recordings',
    headers: { ...mp.headers, authorization: `Bearer ${tokenA}` },
    payload: mp.payload,
  });
  assert.equal(res.statusCode, 413, `esperaba 413, got ${res.statusCode}: ${res.body}`);
  assert.match(res.json().error, /supera el máximo/);
});

test('producción sin SUPABASE_URL no arranca (fail-closed)', () => {
  let stdout = '';
  let stderr = '';
  let status = null;
  try {
    execFileSync(process.execPath, ['src/index.js'], {
      cwd: process.cwd(),
      timeout: 8000,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SUPABASE_URL: '',
        // Base inalcanzable: si el guard fallara, el error sería de conexión
        // (no nuestro mensaje) y el assert lo detectaría.
        DATABASE_URL: 'postgresql://127.0.0.1:59999/none',
        PORT: '59998',
        UPLOADS_DIR: uploadsDir,
      },
      input: '',
    });
  } catch (e) {
    status = e.status;
    stdout = e.stdout || '';
    stderr = e.stderr || '';
  }
  assert.equal(status, 1, `debe salir con código 1 (got ${status})\nstdout:${stdout}\nstderr:${stderr}`);
  assert.match(stderr, /SUPABASE_URL/, `mensaje de error claro esperado en stderr:\n${stderr}`);
});
