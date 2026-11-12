// Tests del adaptador LLM (S5 de odd/tasks/beta-infra-oracle.md).
// Red con fetch mockeado: verifica URL, auth, modelo y parámetros por
// proveedor, y que el pacer TPM solo aplique a Groq.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const llm = await import('../src/llm.js');

let calls;
let envBackup;

function mockFetchOk(content = 'respuesta-ok') {
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  };
}

beforeEach(() => {
  calls = [];
  envBackup = { ...process.env };
  // Limpio cualquier resto de entorno de otros tests.
  delete process.env.LLM_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  delete process.env.LLM_MODEL;
  delete process.env.LLM_BASE_URL;
});

afterEach(() => {
  process.env = { ...envBackup };
  globalThis.fetch = undefined;
});

test('gemini: endpoint, Bearer, max_tokens (no max_completion_tokens)', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gkey-123';
  mockFetchOk();

  const out = await llm.chat([{ role: 'user', content: 'hola' }], { maxTokens: 500 });

  assert.equal(out, 'respuesta-ok');
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.startsWith('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'),
    `endpoint gemini incorrecto: ${calls[0].url}`,
  );
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gkey-123');
  assert.equal(calls[0].body.model, 'gemini-2.5-flash');
  assert.equal(calls[0].body.max_tokens, 500);
  assert.equal(calls[0].body.max_completion_tokens, undefined);
  // Los tokens de pensamiento consumen max_tokens: sin reasoning_effort bajo,
  // el corte trunca la respuesta visible (bug: resumen de71 min en643 chars).
  assert.equal(calls[0].body.reasoning_effort, 'low');
});

test('gemini: flag json agrega response_format', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gkey-123';
  mockFetchOk('{"a":1}');

  await llm.chat([{ role: 'user', content: 'dame json' }], { json: true });

  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('gemini: sin pacer — mensajes enormes pasan sin esperar ni lanzar', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'gkey-123';
  mockFetchOk();

  // Mucho mayor que TPM_BUDGET de Groq (7000): con pacer lanzaría error.
  const huge = 'x'.repeat(100_000);
  const start = Date.now();
  await llm.chat([{ role: 'user', content: huge }], { maxTokens: 100 });
  assert.ok(Date.now() - start < 500, 'gemini no debe esperar por pacer');
  assert.equal(calls.length, 1);
});

test('gemini: sin clave lanza error claro', async () => {
  process.env.LLM_PROVIDER = 'gemini';
  delete process.env.GEMINI_API_KEY;
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'x' }]),
    /GEMINI_API_KEY/,
  );
});

test('groq: endpoint por defecto, max_completion_tokens, modelo actual', async () => {
  process.env.LLM_PROVIDER = 'groq';
  process.env.OPENAI_API_KEY = 'gsk-test';
  mockFetchOk();

  await llm.chat([{ role: 'user', content: 'hola' }], { maxTokens: 700 });

  assert.ok(calls[0].url.startsWith('https://api.groq.com/openai/v1/chat/completions'));
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gsk-test');
  assert.equal(calls[0].body.model, 'openai/gpt-oss-120b');
  assert.equal(calls[0].body.max_completion_tokens, 700);
  assert.equal(calls[0].body.reasoning_effort, undefined);
});

test('groq: mensaje sobre el presupuesto TPM lanza sin llamar al API', async () => {
  process.env.LLM_PROVIDER = 'groq';
  process.env.OPENAI_API_KEY = 'gsk-test';
  mockFetchOk();

  // ~80k chars / 3.5 ≈ 23k tokens > TPM_BUDGET (7000).
  const huge = 'x'.repeat(80_000);
  await assert.rejects(
    () => llm.chat([{ role: 'user', content: huge }], { maxTokens: 3000 }),
    /demasiado grande/,
  );
  assert.equal(calls.length, 0, 'no debe llamar al API si excede el presupuesto');
});

test('groq: error HTTP se propaga con status', async () => {
  process.env.LLM_PROVIDER = 'groq';
  process.env.OPENAI_API_KEY = 'gsk-test';
  globalThis.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited',
  });

  await assert.rejects(
    () => llm.chat([{ role: 'user', content: 'hola' }]),
    /429/,
  );
});

test('auto-detección: con GEMINI_API_KEY y sin LLM_PROVIDER elige gemini', async () => {
  delete process.env.LLM_PROVIDER;
  process.env.GEMINI_API_KEY = 'gkey-auto';
  mockFetchOk();

  await llm.chat([{ role: 'user', content: 'hola' }]);

  assert.ok(calls[0].url.includes('generativelanguage.googleapis.com'));
});

test('auto-detección: sin gemini y con OPENAI_API_KEY elige groq', async () => {
  delete process.env.LLM_PROVIDER;
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = 'gsk-auto';
  mockFetchOk();

  await llm.chat([{ role: 'user', content: 'hola' }]);

  assert.ok(calls[0].url.includes('api.groq.com'));
});
