// SSL del pool según DATABASE_SSL (T10): Render exige SSL en producción,
// la VM self-hosted (Hetzner) no lo tiene y arranca con DATABASE_SSL=disable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const DB_URL = new URL('../src/db.js', import.meta.url).href;
let seq = 0;

async function loadDb(env) {
  const prev = {};
  for (const [k, v] of Object.entries(env)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import(`${DB_URL}?dbssl=${++seq}`);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('DATABASE_SSL=disable fuerza ssl=false incluso en production', async () => {
  const mod = await loadDb({
    NODE_ENV: 'production',
    DATABASE_SSL: 'disable',
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/lecmap',
  });
  assert.equal(mod.pool.options.ssl, false);
});

test('production sin DATABASE_SSL conserva SSL con rejectUnauthorized:false (Render)', async () => {
  const mod = await loadDb({
    NODE_ENV: 'production',
    DATABASE_SSL: undefined,
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/lecmap',
  });
  assert.deepEqual(mod.pool.options.ssl, { rejectUnauthorized: false });
});

test('sin NODE_ENV (dev) mantiene ssl=false', async () => {
  const mod = await loadDb({
    NODE_ENV: undefined,
    DATABASE_SSL: undefined,
    DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/lecmap',
  });
  assert.equal(mod.pool.options.ssl, false);
});
