// Tests de integración del gestor de usuarios admin (S1–S5, S9).
// Auth real simulada (JWKS local) + stub HTTP del Admin API de Supabase +
// Postgres efímero. Cada test corre secuencialmente para compartir el servidor
// stub sin condiciones de carrera.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPg } from './helpers/pg.js';

const ADMIN_UID = '29135fb8-c1a2-4ef6-950b-ad0019b35051';
const NON_ADMIN_UID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TARGET_UID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CREATE_UID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LIST_USER_1 = '11111111-1111-1111-1111-111111111111';
const LIST_USER_2 = '22222222-2222-2222-2222-222222222222';

const STUB_PORT = 54396;
const PG_PORT = 54398;
const SUPABASE_URL = `http://127.0.0.1:${STUB_PORT}`;
const SERVICE_KEY = 'test-service-role-key';

let pgTest;
let app;
let db;
let stubServer;
let privateKey;
let jwk;
let uploadsDir;
const stubBaseUrl = SUPABASE_URL;
const stubHandlers = [];
const stubRequests = [];

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

function setStub(method, pathMatch, fn) {
  stubHandlers.push({ method, path: pathMatch, fn });
}

function setStubJson(method, pathMatch, status, payload) {
  setStub(method, pathMatch, (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
}

function clearStubs() {
  stubHandlers.length = 0;
  stubRequests.length = 0;
}

async function insertProfile(id, { isAdmin = false, quotaSeconds = null } = {}) {
  await db.pool.query(
    'INSERT INTO profiles (id, is_admin, quota_seconds_per_day) VALUES ($1, $2, $3)',
    [id, isAdmin, quotaSeconds],
  );
}

async function insertRecording(userId, title = 'Nota de prueba') {
  const id = Math.random().toString(36).slice(2, 10);
  await db.pool.query(
    `INSERT INTO recordings (id, user_id, title, status, created_at)
     VALUES ($1, $2, $3, 'ready', now())`,
    [id, userId, title],
  );
  await db.pool.query(
    'INSERT INTO segments (recording_id, idx, start, "end", speaker, text) VALUES ($1, 0, 0, 1, \'S0\', \'hola\')',
    [id],
  );
  return id;
}

function adminReq(method, url, { token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) {
    headers['content-type'] = 'application/json';
  }
  return app.inject({
    method,
    url,
    headers,
    payload: body ? JSON.stringify(body) : undefined,
  });
}

describe('admin users manager', { concurrency: false }, () => {
  before(async () => {
    pgTest = await startPg({ name: 'lecmap-test-admin', port: PG_PORT });

    const keypair = await generateKeyPair('ES256', { extractable: true });
    privateKey = keypair.privateKey;
    jwk = { ...(await exportJWK(keypair.publicKey)), kid: 'test-key', alg: 'ES256', use: 'sig' };

    stubServer = http.createServer((req, res) => {
      const url = new URL(req.url, stubBaseUrl);
      if (url.pathname === '/auth/v1/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [jwk] }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        stubRequests.push({
          method: req.method,
          pathname: url.pathname,
          search: url.search,
          body: parsed,
          headers: {
            authorization: req.headers.authorization,
            apikey: req.headers.apikey,
          },
        });
        const handler = stubHandlers.find((h) =>
          h.method === req.method
          && (typeof h.path === 'string' ? h.path === url.pathname : h.path.test(url.pathname)),
        );
        if (handler) {
          try {
            handler.fn(req, res, parsed, url);
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
          }
        } else {
          res.writeHead(404).end();
        }
      });
    });
    await new Promise((r) => stubServer.listen(STUB_PORT, '127.0.0.1', r));

    uploadsDir = await mkdtemp(path.join(tmpdir(), 'lecmap-admin-uploads-'));
    process.env.SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    process.env.UPLOADS_DIR = uploadsDir;

    const indexMod = await import('../src/index.js');
    app = indexMod.app;
    const dbMod = await import('../src/db.js');
    db = { pool: dbMod.pool };
  }, { timeout: 60_000 });

  after(async () => {
    await app?.close();
    await db?.pool?.end();
    await new Promise((r) => stubServer.close(r));
    await pgTest?.stop();
    if (uploadsDir) await rm(uploadsDir, { recursive: true, force: true });
  }, { timeout: 30_000 });

  beforeEach(async () => {
    clearStubs();
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
    await db.pool.query('TRUNCATE recordings, profiles CASCADE');
    await insertProfile(ADMIN_UID, { isAdmin: true });
  });

  test('S1: sin token responde 401 (middleware existente)', async () => {
    const res = await adminReq('GET', '/admin/users');
    assert.equal(res.statusCode, 401);
  });

  test('S1: perfil con is_admin=false responde 403 en GET', async () => {
    await insertProfile(NON_ADMIN_UID, { isAdmin: false });
    const token = await mintToken(NON_ADMIN_UID);
    const res = await adminReq('GET', '/admin/users', { token });
    assert.equal(res.statusCode, 403);
    assert.ok(res.json().error, 'debe devolver error en español');
  });

  test('S1: sin fila de perfil responde 403 en GET', async () => {
    const token = await mintToken(NON_ADMIN_UID);
    const res = await adminReq('GET', '/admin/users', { token });
    assert.equal(res.statusCode, 403);
    assert.ok(res.json().error);
  });

  test('S1: falta SUPABASE_SERVICE_ROLE_KEY responde 503', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('GET', '/admin/users', { token });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'Servicio no configurado: falta SUPABASE_SERVICE_ROLE_KEY');
  });

  test('S2: lista usuarios fusionando Supabase + DB local, ordenado createdAt desc', async () => {
    setStubJson('GET', '/auth/v1/admin/users', 200, {
      users: [
        { id: LIST_USER_1, email: 'beta1@example.com', created_at: '2026-11-15T10:00:00Z' },
        { id: LIST_USER_2, email: 'beta2@example.com', created_at: '2026-11-16T10:00:00Z' },
      ],
    });
    await insertProfile(LIST_USER_2, { isAdmin: true, quotaSeconds: 3600 });

    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('GET', '/admin/users', { token });
    assert.equal(res.statusCode, 200, res.body);
    const { users } = res.json();
    assert.equal(users.length, 2);
    assert.equal(users[0].id, LIST_USER_2);
    assert.equal(users[0].createdAt, '2026-11-16T10:00:00Z');
    assert.equal(users[0].isAdmin, true);
    assert.equal(users[0].quotaSeconds, 3600);
    assert.equal(users[1].id, LIST_USER_1);
    assert.equal(users[1].isAdmin, false);
    assert.equal(users[1].quotaSeconds, null);

    const listReq = stubRequests.find((r) => r.method === 'GET' && r.pathname === '/auth/v1/admin/users');
    assert.ok(listReq, 'debe llamar al Admin API de Supabase');
    assert.equal(listReq.search, '?per_page=100&page=1');
    assert.equal(listReq.headers.apikey, SERVICE_KEY);
    assert.equal(listReq.headers.authorization, `Bearer ${SERVICE_KEY}`);
  });

  test('S2: error remoto al listar responde 502', async () => {
    setStubJson('GET', '/auth/v1/admin/users', 500, { message: 'boom' });
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('GET', '/admin/users', { token });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'No se pudo listar usuarios');
  });

  test('S3: crear usuario con quotaSeconds responde 201 y persiste perfil local', async () => {
    const createdAt = '2026-11-17T12:00:00Z';
    setStubJson('POST', '/auth/v1/admin/users', 200, {
      user: { id: CREATE_UID, email: 'nuevo@example.com', created_at: createdAt },
    });

    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'nuevo@example.com', password: 'secreto123', quotaSeconds: 1800 },
    });
    assert.equal(res.statusCode, 201, res.body);
    const user = res.json().user;
    assert.equal(user.id, CREATE_UID);
    assert.equal(user.email, 'nuevo@example.com');
    assert.equal(user.createdAt, createdAt);
    assert.equal(user.isAdmin, false);
    assert.equal(user.quotaSeconds, 1800);

    const { rows } = await db.pool.query('SELECT * FROM profiles WHERE id = $1', [CREATE_UID]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quota_seconds_per_day, 1800);
    assert.equal(rows[0].is_admin, false);

    const createReq = stubRequests.find((r) => r.method === 'POST' && r.pathname === '/auth/v1/admin/users');
    assert.deepEqual(createReq.body, { email: 'nuevo@example.com', password: 'secreto123', email_confirm: true });
    assert.equal(createReq.headers.apikey, SERVICE_KEY);
    assert.equal(createReq.headers.authorization, `Bearer ${SERVICE_KEY}`);
  });

  test('S3: crear usuario sin quotaSeconds guarda NULL en DB', async () => {
    setStubJson('POST', '/auth/v1/admin/users', 200, {
      user: { id: CREATE_UID, email: 'nuevo2@example.com', created_at: '2026-11-17T12:00:00Z' },
    });
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'nuevo2@example.com', password: 'secreto123' },
    });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().user.quotaSeconds, null);
    const { rows } = await db.pool.query('SELECT quota_seconds_per_day FROM profiles WHERE id = $1', [CREATE_UID]);
    assert.equal(rows[0].quota_seconds_per_day, null);
  });

  test('S3: email inválido responde 400', async () => {
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'no-es-email', password: 'secreto123' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });

  test('S3: password vacío responde 400', async () => {
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'nuevo@example.com', password: '   ' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });

  test('S3: Supabase 422/409 devuelve 409 con el mensaje remoto', async () => {
    setStubJson('POST', '/auth/v1/admin/users', 422, { msg: 'User already registered' });
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'dup@example.com', password: 'secreto123' },
    });
    assert.equal(res.statusCode, 409);
    assert.match(res.json().error, /User already registered/);
  });

  test('S3: error remoto no-409/422 al crear responde 502', async () => {
    setStubJson('POST', '/auth/v1/admin/users', 500, { msg: 'fail' });
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'fail@example.com', password: 'secreto123' },
    });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'No se pudo crear el usuario');
  });

  test('S1: no-admin en POST responde 403', async () => {
    const token = await mintToken(NON_ADMIN_UID);
    const res = await adminReq('POST', '/admin/users', {
      token,
      body: { email: 'x@x.com', password: '123' },
    });
    assert.equal(res.statusCode, 403);
  });

  test('S4: PATCH cambia quotaSeconds a número y a null', async () => {
    const token = await mintToken(ADMIN_UID);
    const res1 = await adminReq('PATCH', `/admin/users/${TARGET_UID}`, {
      token,
      body: { quotaSeconds: 900 },
    });
    assert.equal(res1.statusCode, 200, res1.body);
    assert.equal(res1.json().user.quotaSeconds, 900);

    const res2 = await adminReq('PATCH', `/admin/users/${TARGET_UID}`, {
      token,
      body: { quotaSeconds: null },
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json().user.quotaSeconds, null);

    const { rows } = await db.pool.query('SELECT quota_seconds_per_day FROM profiles WHERE id = $1', [TARGET_UID]);
    assert.equal(rows[0].quota_seconds_per_day, null);
  });

  test('S4: PATCH con body inválido responde 400', async () => {
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('PATCH', `/admin/users/${TARGET_UID}`, {
      token,
      body: { quotaSeconds: 'mucho' },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });

  test('S4: PATCH con id no-uuid responde 400', async () => {
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('PATCH', '/admin/users/no-uuid', {
      token,
      body: { quotaSeconds: 100 },
    });
    assert.equal(res.statusCode, 400);
    assert.ok(res.json().error);
  });

  test('S1: no-admin en PATCH responde 403', async () => {
    await insertProfile(NON_ADMIN_UID, { isAdmin: false });
    const token = await mintToken(NON_ADMIN_UID);
    const res = await adminReq('PATCH', `/admin/users/${TARGET_UID}`, {
      token,
      body: { quotaSeconds: 100 },
    });
    assert.equal(res.statusCode, 403);
  });

  test('S5: DELETE borra recordings locales y responde ok', async () => {
    await insertProfile(TARGET_UID);
    await insertRecording(TARGET_UID);
    setStub('DELETE', /^\/auth\/v1\/admin\/users\/[^/]+$/, (req, res) => {
      res.writeHead(200).end();
    });

    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('DELETE', `/admin/users/${TARGET_UID}`, { token });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const { rows: recs } = await db.pool.query('SELECT * FROM recordings WHERE user_id = $1', [TARGET_UID]);
    assert.equal(recs.length, 0);
    const { rows: profs } = await db.pool.query('SELECT * FROM profiles WHERE id = $1', [TARGET_UID]);
    assert.equal(profs.length, 0);
  });

  test('S5: auto-borrado responde 400 sin llamar a Supabase', async () => {
    setStub('DELETE', /^\/auth\/v1\/admin\/users\/[^/]+$/, (req, res) => {
      res.writeHead(200).end();
    });
    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('DELETE', `/admin/users/${ADMIN_UID}`, { token });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().error, /No pod.s borrar tu propia cuenta/);
    const remote = stubRequests.find((r) => r.method === 'DELETE' && r.pathname.startsWith('/auth/v1/admin/users/'));
    assert.equal(remote, undefined, 'no debe llamar a Supabase en auto-borrado');
  });

  test('S5: error remoto no-404 devuelve 502 sin borrar local', async () => {
    await insertProfile(TARGET_UID);
    const recId = await insertRecording(TARGET_UID);
    setStubJson('DELETE', /^\/auth\/v1\/admin\/users\/[^/]+$/, 500, { msg: 'fail' });

    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('DELETE', `/admin/users/${TARGET_UID}`, { token });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().error, 'No se pudo borrar el usuario');

    const { rows: recs } = await db.pool.query('SELECT * FROM recordings WHERE user_id = $1', [TARGET_UID]);
    assert.equal(recs.length, 1);
    const { rows: profs } = await db.pool.query('SELECT * FROM profiles WHERE id = $1', [TARGET_UID]);
    assert.equal(profs.length, 1);
  });

  test('S5: 404 remoto es tolerado y limpia local', async () => {
    await insertProfile(TARGET_UID);
    await insertRecording(TARGET_UID);
    setStubJson('DELETE', /^\/auth\/v1\/admin\/users\/[^/]+$/, 404, { msg: 'not found' });

    const token = await mintToken(ADMIN_UID);
    const res = await adminReq('DELETE', `/admin/users/${TARGET_UID}`, { token });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);

    const { rows: recs } = await db.pool.query('SELECT * FROM recordings WHERE user_id = $1', [TARGET_UID]);
    assert.equal(recs.length, 0);
    const { rows: profs } = await db.pool.query('SELECT * FROM profiles WHERE id = $1', [TARGET_UID]);
    assert.equal(profs.length, 0);
  });

  test('S1: no-admin en DELETE responde 403', async () => {
    await insertProfile(NON_ADMIN_UID, { isAdmin: false });
    const token = await mintToken(NON_ADMIN_UID);
    const res = await adminReq('DELETE', `/admin/users/${TARGET_UID}`, { token });
    assert.equal(res.statusCode, 403);
  });
});
