import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { mkdirSync } from 'fs';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import path from 'path';
import 'dotenv/config';
import {
  createRecording,
  getRecording,
  listRecordings,
  setStatus,
  saveTranscript,
  saveSummary,
  setAudioPath,
  updateTitle,
  listAudioPaths,
  resetInterrupted,
  deleteRecording,
} from './db.js';
import { targetSummarySentences, transcriptDurationSeconds, condenseToFit, summarySystemPrompt, extractSummaryText } from './summary.js';
import { normalizeMindmap, mindmapSystemPrompt } from './mindmap.js';

const app = Fastify({ logger: true });
const defaultOrigins = [
  'https://lecmap.app',
  'https://www.lecmap.app',
  'https://eltinchosf.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || defaultOrigins.join(',')).split(',').map((o) => o.trim()).filter(Boolean),
);
await app.register(cors, {
  origin(origin, cb) {
    // Android y otros clientes nativos no envían Origin.
    if (!origin || allowedOrigins.has(origin)) return cb(null, true);
    cb(null, false);
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

// Auth con Supabase: verificamos el JWT firmado con ES256 vía JWKS.
// SUPABASE_URL = https://<project>.supabase.co (para buscar las claves públicas)
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
let jwks = null;
if (SUPABASE_URL) {
  jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
}

app.addHook('onRequest', async (req, reply) => {
  const pathname = (req.url || '').split('?')[0];
  // /health y /files quedan públicos.
  if (pathname === '/health' || pathname.startsWith('/files/')) return;
  if (req.method === 'OPTIONS') return;

  // Sin configurado → modo dev abierto (sin auth).
  if (!jwks) {
    req.userId = 'dev-user';
    return;
  }

  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) {
    reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(401).send({ error: 'Token de autenticación ausente' });
  }

  try {
    const { payload } = await jwtVerify(bearer, jwks, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
    req.userId = payload.sub; // UUID del usuario en Supabase
  } catch {
    reply.header('WWW-Authenticate', 'Bearer');
    return reply.code(401).send({ error: 'Token de autenticación inválido o expirado' });
  }
});

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';
const CHAT_MODEL = process.env.CHAT_MODEL || 'openai/gpt-oss-120b';
// Timeouts de Groq: sin signal, un request colgado deja la llamada HTTP abierta
// para siempre (y al usuario esperando). Debajo del read timeout de Android
// (180 s). Ver .env.example.
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 150_000);
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 150_000);

const now = () => new Date().toISOString();
const id = () => Math.random().toString(36).slice(2, 10);

const uploadsDir = path.resolve('uploads');
mkdirSync(uploadsDir, { recursive: true });

const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

function mimeFor(filePath) {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

/**
 * Borra el audio de una grabación. Solo acepta rutas dentro de uploads/ y
 * reintenta por si Windows lo tiene bloqueado un instante (streaming).
 */
async function removeAudioFile(audioPath, log) {
  if (!audioPath) return;
  const resolved = path.resolve(audioPath);
  if (resolved !== uploadsDir && !resolved.startsWith(uploadsDir + path.sep)) {
    log?.warn({ file: resolved }, 'audio fuera de uploads; no se borra');
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await unlink(resolved);
      return;
    } catch (e) {
      if (e.code === 'ENOENT') return;
      if (attempt === 3) {
        log?.warn({ err: e, file: resolved }, 'no se pudo borrar el audio');
        return;
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

/**
 * Borra archivos de uploads/ que ninguna fila de SQLite referencia. Esto cubre
 * audios que quedaron huérfanos porque Windows bloqueó el borrado, o porque una
 * subida se cortó antes de crear la nota.
 */
async function cleanupOrphanAudio(log) {
  let files;
  try {
    files = await readdir(uploadsDir);
  } catch {
    return;
  }
  const referenced = new Set((await listAudioPaths()).map((p) => path.resolve(p)));
  let removed = 0;
  for (const name of files) {
    const fp = path.join(uploadsDir, name);
    if (referenced.has(path.resolve(fp))) continue;
    try {
      const info = await stat(fp);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    await removeAudioFile(fp, log);
    removed += 1;
  }
  if (removed > 0) log?.info({ removed }, 'audios huérfanos eliminados');
  return removed;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// El plan gratuito de Groq limita gpt-oss-120b a 8000 tokens por minuto (TPM).
// Llevamos una ventana de 60 s y esperamos antes de mandar otro pedido grande.
const chatWindow = [];
const TPM_BUDGET = 7000;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 3.5);
}

function estimateMessagesTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
}

async function paceChat(messages, maxTokens) {
  const estimated = estimateMessagesTokens(messages) + maxTokens;
  if (estimated > TPM_BUDGET) {
    throw new Error(`Pedido demasiado grande (${estimated} tokens); hay que dividir la transcripción`);
  }
  for (;;) {
    const now = Date.now();
    while (chatWindow.length && now - chatWindow[0].at > 60_000) chatWindow.shift();
    const used = chatWindow.reduce((n, u) => n + u.tokens, 0);
    if (used + estimated <= TPM_BUDGET) {
      chatWindow.push({ at: now, tokens: estimated });
      return;
    }
    const wait = 60_000 - (now - chatWindow[0].at) + 500;
    await sleep(Math.max(wait, 1000));
  }
}

/**
 * fetch a Groq con timeout. Errores de red o de timeout se marcan con
 * upstream=true para que el handler responda 5xx (proveedor caído/colgado)
 * en vez de un 500 local genérico.
 */
async function groqFetch(what, url, options, timeoutMs) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const err = new Error(
      timedOut ? `${what}: timeout tras ${timeoutMs} ms` : `${what}: ${e.message}`,
    );
    err.upstream = true;
    throw err;
  }
  return res;
}

async function openaiChat(messages, { json = false, maxTokens = 3000 } = {}) {
  await paceChat(messages, maxTokens);
  const res = await groqFetch(
    'AI chat',
    `${OPENAI_BASE}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        max_completion_tokens: maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
    },
    LLM_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`AI chat error: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.choices[0].message.content;
}

async function openaiTranscribe(filePath) {
  const fileBuffer = await readFile(filePath);
  const mime = mimeFor(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mime }), path.basename(filePath));
  form.append('model', STT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  const res = await groqFetch(
    'Whisper',
    `${OPENAI_BASE}/audio/transcriptions`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    },
    STT_TIMEOUT_MS,
  );
  if (!res.ok) {
    // upstream=true: el fallo vino de Groq (502 para el cliente, no 500 local).
    const err = new Error(`Whisper error: ${res.status} ${await res.text()}`);
    err.upstream = true;
    throw err;
  }
  return await res.json();
}

// Extrae JSON aunque el modelo lo envuelva en ```json ... ```
function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('La IA no devolvió JSON válido');
  }
}

// Como parseJsonLoose, pero atribuye el fallo al call que lo produjo y
// conserva el inicio del raw para diagnosticar en logs y en el estado error.
function parseJsonLooseCtx(text, ctx) {
  try {
    return parseJsonLoose(text);
  } catch (e) {
    const head = String(text || '').slice(0, 160).replace(/\s+/g, ' ');
    throw new Error(`${ctx}: ${e.message} — raw: "${head}"`);
  }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

app.get('/health', async () => ({
  ok: true,
  openai: !!OPENAI_KEY,
  stt: STT_MODEL,
  chat: CHAT_MODEL,
  auth: jwks ? 'supabase' : 'none',
}));

app.post('/recordings', async (req) => {
  const ct = req.headers['content-type'] || '';
  let title = 'Grabación ' + new Date().toLocaleString('es-AR');
  let youtubeUrl = null;
  let audioPath = null;

  if (ct.includes('multipart')) {
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'title') title = String(part.value);
      if (part.type === 'file' && part.fieldname === 'audio') {
        const buf = await part.toBuffer();
        const safeName = path.basename(part.filename || 'audio.webm').replace(/[^\w.\-]/g, '_');
        const fp = path.join(uploadsDir, `${id()}_${safeName}`);
        await writeFile(fp, buf);
        audioPath = fp;
      }
    }
  } else {
    const b = req.body || {};
    if (b.title) title = String(b.title);
    if (b.youtubeUrl) youtubeUrl = String(b.youtubeUrl);
  }

  return createRecording({ id: id(), userId: req.userId, title, audioPath, youtubeUrl, createdAt: now() });
});

// Vuelve a subir el audio de una nota existente (por ejemplo, para reanalizarla
// después de que el servidor borró su copia tras transcribir).
app.post('/recordings/:id/audio', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!req.isMultipart()) return reply.code(400).send({ error: 'se esperaba multipart/form-data' });

  let part;
  try {
    part = await req.file();
  } catch (e) {
    return reply.code(400).send({ error: e.message });
  }
  if (!part) return reply.code(400).send({ error: 'falta el archivo de audio' });

  const buf = await part.toBuffer();
  if (buf.length === 0) return reply.code(400).send({ error: 'audio vacío' });
  const safeName = path.basename(part.filename || 'audio.webm').replace(/[^\w.\-]/g, '_');
  const fp = path.join(uploadsDir, `${id()}_${safeName}`);
  await writeFile(fp, buf);
  if (r.audioPath) await removeAudioFile(r.audioPath, req.log);
  await setAudioPath(r.id, req.userId, fp);
  return getRecording(r.id, req.userId);
});

app.get('/recordings', async (req) => {
  const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
  return listRecordings(req.userId, req.query?.q || '', { limit, offset });
});

app.get('/recordings/:id', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  return r;
});

// S4: renombrar la nota. El backend no tenía ninguna ruta de escritura de
// título (solo GET/POST/DELETE); el hook de auth ya cubre req.userId.
app.patch('/recordings/:id', async (req, reply) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  if (!title) return reply.code(400).send({ error: 'title requerido' });
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  return updateTitle(r.id, req.userId, title);
});

app.delete('/recordings/:id', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  // Primero la fila (la nota desaparece ya) y después el archivo. Si el
  // archivo está bloqueado, el cleanup lo borra más tarde.
  await deleteRecording(req.params.id, req.userId);
  await removeAudioFile(r.audioPath, req.log);
  return { ok: true };
});

// Sirve el audio subido para el reproductor del cliente
app.get('/files/:name', async (req, reply) => {
  const name = path.basename(req.params.name);
  const fp = path.join(uploadsDir, name);
  if (!fp.startsWith(uploadsDir)) return reply.code(400).send({ error: 'invalid path' });
  try {
    const info = await stat(fp);
    reply.header('Content-Length', info.size);
    reply.header('Accept-Ranges', 'bytes');
    reply.type(mimeFor(name));
    return reply.send(createReadStream(fp));
  } catch {
    return reply.code(404).send({ error: 'file not found' });
  }
});

app.post('/recordings/:id/transcribe', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });
  if (!r.audioPath) return reply.code(400).send({ error: 'sin audio subido' });

  await setStatus(r.id, req.userId, 'transcribing');
  try {
    const result = await openaiTranscribe(r.audioPath);
    const segments = (result.segments || []).map((s, i) => ({
      start: s.start,
      end: s.end,
      speaker: `SPEAKER_${String(i % 2).padStart(2, '0')}`,
      text: s.text.trim(),
    }));
    const saved = await saveTranscript(r.id, req.userId, segments);
    // La transcripción ya está en la base: el servidor no necesita conservar el
    // audio. El cliente mantiene su copia local para reproducir la clase.
    await removeAudioFile(r.audioPath, req.log);
    await setAudioPath(r.id, req.userId, null);
    return { ...saved, audioPath: null };
  } catch (e) {
    console.error('[transcribe] error:', e.message);
    await setStatus(r.id, req.userId, 'error', e.message);
    // Error real = status 5xx (nunca 200): los clientes chequean r.ok y hoy el
    // fallo pasaba silencioso. El estado de la nota ya quedó en 'error'.
    return reply
      .code(e.upstream ? 502 : 500)
      .send({ id: r.id, status: 'error', error: e.message });
  }
});

// ---------- Resumen de clases largas ----------
// Groq (plan gratis) limita gpt-oss-120b a 8000 tokens por minuto. Una clase
// de 35 min no entra en un solo pedido: partimos la transcripción, resumimos
// cada bloque y hacemos una síntesis final con el mapa de ideas.

const summaryJobs = new Set();
const MAX_CHUNK_CHARS = 10_000;
// Presupuesto del material que llega a los calls finales. paceChat rechaza
// pedidos estimados en > 7000 tokens (TPM_BUDGET). El resumen y el mindmap se
// generan en DOS calls separados para que el resumen no compita con el JSON
// del mapa multi-sección por los tokens de salida. El call del resumen va en
// TEXTO PLANO (sin response_format): el modo JSON de Groq con gpt-oss-120b
// devolvía 400 "Failed to generate JSON" y el retry quedaba truncado:
//   resumen: material (~2000) + prompt (~90) + SUMMARY_MAX_TOKENS (3000) ≈ 5100
//   mindmap: material (~2000) + prompt (~900) + maxTokens (4000) ≈ 6900
// Si el material lo supera, se condensa jerárquicamente en vez de truncarse.
const FINAL_MATERIAL_MAX_CHARS = 7_000;
// Salida dedicada del resumen: alcanza para ~70 frases (~1000 palabras) del
// techo de targetSummarySentences con holgura para verborragia del modelo.
const SUMMARY_MAX_TOKENS = 3_000;

function transcriptChunks(
  segments,
  maxChars = MAX_CHUNK_CHARS,
  format = (s) => `[${s.speaker}] ${s.text}`,
) {
  const chunks = [];
  let current = [];
  let length = 0;
  for (const s of segments) {
    const line = format(s);
    if (length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current.join('\n'));
      current = [];
      length = 0;
    }
    current.push(line);
    length += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

const CHUNK_SYSTEM_PROMPT =
  'Sos un asistente que resume clases en español. Devolvé SOLO JSON con esta forma: ' +
  '{"summary": string, "points": [string]}. ' +
  'El summary debe tener 2 o 3 frases. En points poné hasta 6 ideas concretas del fragmento ' +
  '(datos, definiciones, ejemplos, conclusiones). No inventes contenido que no esté en el texto.';

async function summarizeChunk(chunk, index, total) {
  const messages = [
    { role: 'system', content: CHUNK_SYSTEM_PROMPT },
    { role: 'user', content: `Fragmento ${index + 1} de ${total}:\n\n${chunk}` },
  ];
  let raw;
  try {
    raw = await openaiChat(messages, { json: true, maxTokens: 700 });
  } catch (e) {
    if (/413|429|demasiado grande/i.test(e.message)) throw e;
    console.warn(`[summarize] bloque ${index + 1} JSON falló, reintento simple:`, e.message.slice(0, 140));
    raw = await openaiChat(messages, { json: false, maxTokens: 700 });
  }
  const parsed = parseJsonLoose(raw);
  return { summary: str(parsed.summary), points: strList(parsed.points) };
}

/** Si un bloque igual es demasiado grande, lo parte al medio y reintenta. */
async function summarizeChunkSafe(chunk, index, total, depth = 0) {
  try {
    return [await summarizeChunk(chunk, index, total)];
  } catch (e) {
    if (depth < 3 && /413|429|demasiado grande/i.test(e.message) && chunk.length > 4000) {
      const mid = chunk.lastIndexOf('\n', Math.floor(chunk.length / 2));
      const cut = mid > 1500 ? mid : Math.floor(chunk.length / 2);
      console.warn(`[summarize] bloque ${index + 1} demasiado grande; lo divido (nivel ${depth + 1})`);
      await sleep(2000);
      return [
        ...(await summarizeChunkSafe(chunk.slice(0, cut), index, total, depth + 1)),
        ...(await summarizeChunkSafe(chunk.slice(cut), index, total, depth + 1)),
      ];
    }
    throw e;
  }
}

const MERGE_SYSTEM_PROMPT =
  'Sos un asistente que condensa resúmenes de fragmentos de una clase. Reescribí un texto compacto en español que conserve TODOS los hechos, definiciones, fórmulas, ejemplos, nombres y conclusiones de los fragmentos, sin inventar nada y sin repetirte. Sin encabezados ni preámbulo: sólo el contenido condensado.';

async function condensePartsChunk(text, index, total) {
  const raw = await openaiChat([
    { role: 'system', content: MERGE_SYSTEM_PROMPT },
    { role: 'user', content: `Parte ${index + 1} de ${total}:\n\n${text}` },
  ], { maxTokens: 900 });
  return String(raw || '').trim() || text;
}

async function runSummaryJob(id, userId, template) {
  try {
    const r = await getRecording(id, userId);
    if (!r) return;
    const chunks = transcriptChunks(r.transcript);
    if (chunks.length === 0) throw new Error('La grabación no tiene transcripción');

    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const results = await summarizeChunkSafe(chunks[i], i, chunks.length);
      for (const part of results) {
        parts.push(
          `Fragmento ${i + 1}:\nResumen: ${part.summary}\nPuntos:\n${part.points.map((p) => `- ${p}`).join('\n')}`,
        );
      }
    }
    // Condensación jerárquica: ninguna parte se descarta. Si el material
    // supera el presupuesto del call final, condensamos lotes y volvemos a
    // intentar — el final de la clase siempre llega al modelo.
    const { material, rounds } = await condenseToFit(
      parts,
      condensePartsChunk,
      FINAL_MATERIAL_MAX_CHARS,
    );
    if (rounds > 0) console.log(`[summarize] ${id}: material condensado en ${rounds} ronda(s)`);

    const minutes = transcriptDurationSeconds(r.transcript) / 60;
    const targetSentences = targetSummarySentences(minutes);
    console.log(`[summarize] ${id}: ${minutes.toFixed(1)} min → objetivo ${targetSentences} frases`);

    // Call A: resumen solo, en TEXTO PLANO — su propio maxTokens para que el
    // mapa multi-sección no le robe salida (en el call único el resumen
    // quedaba en ~3 frases) y sin modo JSON, que con Groq devolvía 400
    // "Failed to generate JSON" y el retry salía truncado.
    const summaryMessages = [
      { role: 'system', content: summarySystemPrompt(targetSentences) },
      { role: 'user', content: material },
    ];
    let rawSummary;
    try {
      rawSummary = await openaiChat(summaryMessages, { json: false, maxTokens: SUMMARY_MAX_TOKENS });
    } catch (e) {
      if (/413|429|demasiado grande|timeout/i.test(e.message)) throw e;
      console.warn('[summarize] call del resumen falló, reintento:', e.message.slice(0, 140));
      await sleep(2000);
      rawSummary = await openaiChat(summaryMessages, { json: false, maxTokens: SUMMARY_MAX_TOKENS });
    }
    const summaryText = extractSummaryText(rawSummary);
    if (!summaryText) throw new Error('La IA no devolvió un resumen válido');

    // Call B: mindmap solo.
    const messages = [
      { role: 'system', content: mindmapSystemPrompt(template) },
      { role: 'user', content: material },
    ];

    let raw;
    try {
      raw = await openaiChat(messages, { json: true, maxTokens: 4000 });
    } catch (e) {
      // 413/429: reintentar con menos texto ayuda. Timeout: el reintento solo
      // duplica la espera, así que se propaga al catch del job.
      if (/413|429|demasiado grande|timeout/i.test(e.message)) throw e;
      console.warn('[summarize] JSON del mindmap falló, reintento simple:', e.message.slice(0, 140));
      raw = await openaiChat(messages, { json: false, maxTokens: 4000 });
    }

    const parsed = parseJsonLooseCtx(raw, 'JSON del mindmap inválido');
    const mindmap = normalizeMindmap(parsed.mindmap);
    if (!mindmap) throw new Error('La IA no devolvió un mapa de ideas válido');
    await saveSummary(id, userId, summaryText, mindmap);
    console.log(`[summarize] ${id} listo (${chunks.length} bloque/s)`);
  } catch (e) {
    console.error(`[summarize] ${id} error:`, e.message);
    await setStatus(id, userId, 'error', `No se pudo resumir: ${e.message}`);
  } finally {
    summaryJobs.delete(id);
  }
}

app.post('/recordings/:id/summarize', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });
  if (!r.transcript.length) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });

  const template = req.body?.template || 'general';
  if (!summaryJobs.has(r.id)) {
    summaryJobs.add(r.id);
    await setStatus(r.id, req.userId, 'summarizing', null);
    // No se espera: una clase larga puede tardar varios minutos y Cloudflare
    // corta respuestas de más de ~100 s. El cliente consulta el estado.
    runSummaryJob(r.id, req.userId, template);
  }
  return reply.code(202).send({ id: r.id, status: 'summarizing' });
});

function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

/**
 * Para preguntas, no mandamos toda la clase: elegimos los fragmentos con más
 * palabras en común con la pregunta. Así entra en el límite de tokens.
 */
function relevantTranscript(segments, question, maxChars = 12_000) {
  const chunks = transcriptChunks(
    segments,
    9000,
    (s) => `[${s.start}-${s.end}] ${s.speaker}: ${s.text}`,
  );
  if (chunks.length <= 1) return chunks[0] || '';

  const terms = [...new Set(
    normalizeText(question).split(/[^a-z0-9]+/).filter((t) => t.length > 3),
  )].slice(0, 12);

  const scored = chunks.map((text, index) => ({
    text,
    index,
    score: terms.reduce((n, t) => n + countOccurrences(normalizeText(text), t), 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const picked = [];
  let total = 0;
  for (const c of scored) {
    if (total + c.text.length > maxChars && picked.length > 0) continue;
    picked.push(c);
    total += c.text.length;
    if (total >= maxChars) break;
  }

  if (picked.every((c) => c.score === 0)) {
    return [chunks[0], chunks[chunks.length - 1]].join('\n\n');
  }
  return picked.sort((a, b) => a.index - b.index).map((c) => c.text).join('\n\n');
}

app.post('/recordings/:id/ask', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });

  const question = req.body?.question || '';
  if (!question.trim()) return reply.code(400).send({ error: 'Pregunta vacía' });
  if (summaryJobs.has(r.id)) {
    return reply.code(409).send({ error: 'La nota se está resumiendo. Esperá unos minutos y volvé a preguntar.' });
  }

  const transcriptText = relevantTranscript(r.transcript, question);
  if (!transcriptText) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });
  const summaryContext = r.summary ? `Resumen de la clase:\n${r.summary}\n\n` : '';

  try {
    const answer = await openaiChat([
      { role: 'system', content: 'Respondé preguntas sobre la transcripción. Sé preciso y breve. Si la respuesta no está en la transcripción, decilo.' },
      { role: 'user', content: `${summaryContext}Transcripción (fragmentos relevantes):\n${transcriptText}\n\nPregunta: ${question}` },
    ], { maxTokens: 1200 });
    return {
      answer,
      citations: r.transcript.map((s) => ({ start: s.start, end: s.end })),
    };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
});

const port = Number(process.env.PORT || 3001);
await resetInterrupted();
await cleanupOrphanAudio(app.log);
setInterval(() => {
  cleanupOrphanAudio(app.log).catch((e) => app.log.warn({ err: e }, 'cleanup de audios falló'));
}, 6 * 60 * 60 * 1000).unref();
await app.listen({ port, host: '0.0.0.0' });
