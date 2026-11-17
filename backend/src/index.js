import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { readFile, writeFile, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { mkdirSync } from 'fs';
import jwt from 'jsonwebtoken';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import path from 'path';
import { pathToFileURL } from 'url';
import 'dotenv/config';
import {
  createRecording,
  getRecording,
  listRecordings,
  setStatus,
  saveTranscript,
  saveSummary,
  setAudioPath,
  setDurationSeconds,
  updateTitle,
  renameSpeaker,
  resetInterrupted,
  deleteRecording,
  recordingOwnsAudio,
  enqueueJob,
  activeJob,
} from './db.js';
import { startRunner, HOSTNAME } from './jobs.js';
import { chat, llmAvailable, llmInfo } from './llm.js';
import { assertQuota, resolveDurationSeconds, withQuotaLock } from './quota.js';
import { checkRateLimit } from './ratelimit.js';
import { removeAudioFile, cleanupOrphanAudio, defaultUploadsDir } from './cleanup.js';
import { targetSummarySentences, transcriptDurationSeconds, condenseToFit, summarySystemPrompt, extractSummaryText, parseChunkText, CHUNK_SYSTEM_PROMPT, MERGE_SYSTEM_PROMPT } from './summary.js';
import { normalizeMindmap, mindmapSystemPrompt } from './mindmap.js';
import { upstreamAgent, upstreamFetch, FormData } from './net.js';
import { registerAdminRoutes } from './admin.js';

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
  // PATCH es el renombrado de notas: sin él el preflight de la web falla.
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});
// MAX_UPLOAD_MB: 2h de clase a 32 kbps ≈ 28 MB; default holgado. Configurable
// por entorno (Oracle puede subirlo, Render no debería pasar de 512 MB RAM).
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

// Auth con Supabase: verificamos el JWT firmado con ES256 vía JWKS.
// SUPABASE_URL = https://<project>.supabase.co (para buscar las claves públicas)
const SUPABASE_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
// Identidad fija en uuid para el modo dev (sin SUPABASE_URL): las columnas
// user_id son uuid en recordings/jobs/profiles, y el viejo string 'dev-user'
// hacía fallar todo INSERT/SELECT en dev contra Postgres (invalid input
// syntax for type uuid). En dev no hay usuarios reales: una identidad
// constante alcanza y mantiene el esquema estricto de producción.
const DEV_USER_ID = '00000000-0000-4000-8000-000000000000';

// Fail-closed en producción: sin SUPABASE_URL la API quedaría abierta con
// DEV_USER_ID para todos (antes pasaba silencioso). En dev sigue abierta.
if (process.env.NODE_ENV === 'production' && !SUPABASE_URL) {
  console.error(
    '[config] NODE_ENV=production pero SUPABASE_URL está vacía. '
    + 'El backend no arranca en producción sin autenticación: '
    + 'configurá SUPABASE_URL o corré en modo dev (sin NODE_ENV=production).',
  );
  process.exit(1);
}
let jwks = null;
if (SUPABASE_URL) {
  jwks = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
}

await registerAdminRoutes(app, { supabaseUrl: SUPABASE_URL });

app.addHook('onRequest', async (req, reply) => {
  const pathname = (req.url || '').split('?')[0];
  // /health y /files quedan públicos.
  if (pathname === '/health' || pathname.startsWith('/files/')) return;
  if (req.method === 'OPTIONS') return;

  // Sin configurado → modo dev abierto (sin auth).
  if (!jwks) {
    req.userId = DEV_USER_ID;
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
// Timeout de STT (Groq/worker): sin signal, un request colgado deja la llamada
// HTTP abierta para siempre. Debajo del read timeout de Android (180 s).
// El timeout del LLM vive en llm.js (LLM_TIMEOUT_MS).
const STT_TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 150_000);
// Worker de transcripción propio (Oracle): STT + diarización de speakers.
// Si WORKER_URL no está, se cae a Groq (dev local sin worker).
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/$/, '');
const WORKER_TOKEN = process.env.WORKER_TOKEN || '';
// 2 h de audio en la VM (2 OCPU) puede tardar hasta ~90 min con cola.
const WORKER_TIMEOUT_MS = Number(process.env.WORKER_TIMEOUT_MS || 10_800_000);

const now = () => new Date().toISOString();
const id = () => Math.random().toString(36).slice(2, 10);

const uploadsDir = defaultUploadsDir();
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * fetch con timeout. Errores de red o de timeout se marcan con
 * upstream=true para que el handler responda 5xx (proveedor caído/colgado)
 * en vez de un 500 local genérico. Usado por STT (Groq/worker) — el LLM va
 * por llm.js (adaptador gemini/groq con pacer propio).
 */
async function groqFetch(what, url, options, timeoutMs) {
  let res;
  try {
    res = await upstreamFetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      // sin esto undici aborta a los 300 s (headersTimeout default) — ver net.js
      dispatcher: upstreamAgent,
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const cause = e?.cause?.message || e?.cause?.code || '';
    const err = new Error(
      timedOut
        ? `${what}: timeout tras ${timeoutMs} ms`
        : `${what}: ${e.message}${cause ? ` (${cause})` : ''}`,
    );
    err.upstream = true;
    throw err;
  }
  return res;
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

app.get('/health', async () => ({
  ok: true,
  openai: !!OPENAI_KEY,
  stt: WORKER_URL ? 'worker' : STT_MODEL,
  llm: llmInfo(),
  auth: jwks ? 'supabase' : 'none',
}));

// Devuelve un mensaje de error si el audio subido no es válido, o null.
// Extensión contra el catálogo de formatos soportados + tamaño máximo:
// antes cualquier archivo entraba y el fallo recién aparecía en Groq.
function audioUploadError(safeName, buf) {
  const ext = path.extname(safeName).toLowerCase();
  if (!MIME_BY_EXT[ext]) {
    return `Formato de audio no soportado: ${ext || '(sin extensión)'}. `
      + `Usá ${Object.keys(MIME_BY_EXT).join(', ')}.`;
  }
  if (buf.length === 0) return 'audio vacío';
  if (buf.length > MAX_UPLOAD_MB * 1024 * 1024) {
    return `El audio supera el máximo de ${MAX_UPLOAD_MB} MB. Grabá o comprimí menos audio por subida.`;
  }
  return null;
}

// Cuerpo del 429 por cuota diaria (S1): mensaje claro en minutos + el
// desglose en segundos para que el cliente pueda mostrar "te quedan X min".
function quotaBody(e) {
  const min = (s) => Math.round(Number(s) / 60);
  return {
    error: `Límite diario de audio alcanzado: usaste ${min(e.used)} de ${min(e.quota)} min `
      + '(el límite se renueva mañana).',
    code: 'quota_exceeded',
    used_seconds: e.used,
    quota_seconds: e.quota,
    remaining_seconds: e.remaining,
  };
}

// Cuerpo del 429 por rate limiting (S7): Retry-After para que los clientes
// puedan reintentar sin preguntar.
function sendRateLimited(reply, e) {
  reply.header('Retry-After', String(e.retryAfterSec));
  return reply.code(429).send({
    error: e.message,
    code: 'rate_limited',
    retry_after_seconds: e.retryAfterSec,
  });
}

app.post('/recordings', async (req, reply) => {
  const ct = req.headers['content-type'] || '';
  let title = 'Grabación ' + new Date().toLocaleString('es-AR');
  let youtubeUrl = null;
  // El form completo se acumula ANTES de tocar el disco: el campo duration
  // puede venir antes o después del archivo (S1: cuota por duración).
  let audioBuf = null;
  let audioName = null;
  let clientDuration = null;

  if (ct.includes('multipart')) {
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'title') title = String(part.value);
      if (part.type === 'field' && part.fieldname === 'duration') {
        const secs = Number(part.value);
        if (Number.isFinite(secs)) clientDuration = secs;
      }
      if (part.type === 'file' && part.fieldname === 'audio') {
        let buf;
        try {
          buf = await part.toBuffer();
        } catch (e) {
          // @fastify/multipart lanza al superar limits.fileSize (413).
          if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(413).send({
              error: `El audio supera el máximo de ${MAX_UPLOAD_MB} MB.`,
            });
          }
          throw e;
        }
        const safeName = path.basename(part.filename || 'audio.webm').replace(/[^\w.\-]/g, '_');
        const invalid = audioUploadError(safeName, buf);
        if (invalid) return reply.code(400).send({ error: invalid });
        audioBuf = buf;
        audioName = safeName;
      }
    }
  } else {
    const b = req.body || {};
    if (b.title) title = String(b.title);
    if (b.youtubeUrl) youtubeUrl = String(b.youtubeUrl);
  }

  // Nota sin audio (JSON / YouTube): no consume cuota.
  if (!audioBuf) {
    return createRecording({ id: id(), userId: req.userId, title, audioPath: null, youtubeUrl, createdAt: now() });
  }

  // Orden seguro: escribir → medir duración (ffprobe sobre el archivo final)
  // → chequear cuota → crear la nota. Si la cuota corta, se borra el audio
  // recién escrito (429 sin dejar huérfanos ni filas a medias).
  const fp = path.join(uploadsDir, `${id()}_${audioName}`);
  await writeFile(fp, audioBuf);
  const duration = await resolveDurationSeconds(fp, clientDuration, audioBuf.length);
  // R4-2: check+insert serializados por usuario (withQuotaLock).
  try {
    return await withQuotaLock(req.userId, async () => {
      await assertQuota(req.userId, duration, {});
      return createRecording({
        id: id(),
        userId: req.userId,
        title,
        audioPath: fp,
        youtubeUrl,
        createdAt: now(),
        durationSeconds: duration,
      });
    });
  } catch (e) {
    if (e.code === 'quota_exceeded') {
      await removeAudioFile(fp, req.log);
      return reply.code(429).send(quotaBody(e));
    }
    throw e;
  }
});

// Vuelve a subir el audio de una nota existente (por ejemplo, para reanalizarla
// después de que el servidor borró su copia tras transcribir).
app.post('/recordings/:id/audio', async (req, reply) => {
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!req.isMultipart()) return reply.code(400).send({ error: 'se esperaba multipart/form-data' });

  // Se recorre el form completo (no req.file()): el campo duration puede
  // venir después del archivo y el server debe verlo sin importar el orden.
  let buf = null;
  let safeName = null;
  let clientDuration = null;
  try {
    for await (const part of req.parts()) {
      if (part.type === 'field' && part.fieldname === 'duration') {
        const secs = Number(part.value);
        if (Number.isFinite(secs)) clientDuration = secs;
      }
      if (part.type === 'file' && part.fieldname === 'audio') {
        try {
          buf = await part.toBuffer();
        } catch (e) {
          if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
            return reply.code(413).send({ error: `El audio supera el máximo de ${MAX_UPLOAD_MB} MB.` });
          }
          throw e;
        }
        safeName = path.basename(part.filename || 'audio.webm').replace(/[^\w.\-]/g, '_');
      }
    }
  } catch (e) {
    if (e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: `El audio supera el máximo de ${MAX_UPLOAD_MB} MB.` });
    }
    return reply.code(400).send({ error: e.message });
  }
  if (!buf) return reply.code(400).send({ error: 'falta el archivo de audio' });

  const invalid = audioUploadError(safeName, buf);
  if (invalid) return reply.code(400).send({ error: invalid });

  const fp = path.join(uploadsDir, `${id()}_${safeName}`);
  await writeFile(fp, buf);
  const duration = await resolveDurationSeconds(fp, clientDuration, buf.length);
  try {
    // R4-2 + excludeRecordingId: check y escritura serializados por usuario;
    // este re-upload REEMPLAZA al actual y no debe contar dos veces.
    await withQuotaLock(req.userId, async () => {
      await assertQuota(req.userId, duration, { excludeRecordingId: r.id });
      await setAudioPath(r.id, req.userId, fp);
      await setDurationSeconds(r.id, req.userId, duration);
    });
  } catch (e) {
    if (e.code === 'quota_exceeded') {
      // Se borra solo el audio NUEVO: el de la nota sigue intacto.
      await removeAudioFile(fp, req.log);
      return reply.code(429).send(quotaBody(e));
    }
    throw e;
  }

  // El puntero ya cambió al archivo nuevo: recién ahora se borra el viejo.
  if (r.audioPath) await removeAudioFile(r.audioPath, req.log);
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

// T9 (S3): renombra un hablante de la nota. { from, to } — to vacío revierte.
// El renombre vive en speaker_labels; la diarización original no se toca.
app.patch('/recordings/:id/speakers', async (req, reply) => {
  const from = typeof req.body?.from === 'string' ? req.body.from.trim() : '';
  const to = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
  if (!from) return reply.code(400).send({ error: 'from requerido' });
  const out = await renameSpeaker(req.params.id, req.userId, from, to);
  if (out?.error) return reply.code(out.status || 400).send({ error: out.error });
  return out;
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

// Sirve el audio subido para el reproductor del cliente.
// El elemento <audio> del navegador no puede mandar Authorization: acepta el
// token por header o por ?token=. Sin jwks (modo dev) queda abierto como antes.
async function resolveRequester(req, reply) {
  if (!jwks) return DEV_USER_ID;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const queryToken = typeof req.query?.token === 'string' ? req.query.token.trim() : '';
  const token = bearer || queryToken;
  if (!token) {
    reply.header('WWW-Authenticate', 'Bearer');
    reply.code(401).send({ error: 'Token de autenticación ausente' });
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `${SUPABASE_URL}/auth/v1`,
      audience: 'authenticated',
    });
    return payload.sub;
  } catch {
    reply.header('WWW-Authenticate', 'Bearer');
    reply.code(401).send({ error: 'Token de autenticación inválido o expirado' });
    return null;
  }
}

app.get('/files/:name', async (req, reply) => {
  const requester = await resolveRequester(req, reply);
  if (!requester) return reply; // ya respondió 401

  const name = path.basename(req.params.name);
  const fp = path.join(uploadsDir, name);
  if (!fp.startsWith(uploadsDir)) return reply.code(400).send({ error: 'invalid path' });

  // Ownership: el archivo debe pertenecer a una nota del usuario que pide.
  // 404 (no 403) para no revelar la existencia de archivos ajenos.
  const owns = await recordingOwnsAudio(requester, fp);
  if (!owns) return reply.code(404).send({ error: 'file not found' });

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
  // S7: rate limit PRIMERO, antes de tocar la base o el proveedor.
  try {
    checkRateLimit(req.userId, 'transcribe');
  } catch (e) {
    if (e.code === 'rate_limited') return sendRateLimited(reply, e);
    throw e;
  }

  const r = await getRecording(req.params.id, req.userId);

  // S1: la transcripción consume la cuota del día de esa nota. Si la nota
  // no tiene duración conocida entra 0 y pasa; al transcribir se reconcilia
  // con la duración real (setDurationSeconds en transcribeHandler).
  if (r) {
    try {
      await assertQuota(req.userId, Number(r.durationSeconds) || 0, { excludeRecordingId: r.id });
    } catch (e) {
      if (e.code === 'quota_exceeded') return reply.code(429).send(quotaBody(e));
      throw e;
    }
  }

  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!WORKER_URL && !OPENAI_KEY) {
    return reply.code(500).send({ error: 'WORKER_URL u OPENAI_API_KEY no configuradas' });
  }
  if (!r.audioPath) return reply.code(400).send({ error: 'sin audio subido' });

  await setStatus(r.id, req.userId, 'transcribing');
  // Encolado: la transcripción corre en background (cola en DB con reintentos).
  // El cliente consulta GET /recordings/:id hasta ready/error.
  await enqueueJob({ recordingId: r.id, userId: req.userId, kind: 'transcribe' });
  return reply.code(202).send({ id: r.id, status: 'transcribing' });
});

// ---------- Resumen de clases largas ----------
// Groq (plan gratis) limita gpt-oss-120b a 8000 tokens por minuto. Una clase
// de 35 min no entra en un solo pedido: partimos la transcripción, resumimos
// cada bloque y hacemos una síntesis final con el mapa de ideas.

const MAX_CHUNK_CHARS = 10_000;
// Presupuesto del material que llega a los calls finales. paceChat rechaza
// pedidos estimados en > 7000 tokens (TPM_BUDGET) — solo aplica a groq; el
// pacer de gemini está desactivado. El resumen y el mindmap se generan en
// DOS calls separados para que el resumen no compita con el JSON del mapa
// multi-sección por los tokens de salida. El call del resumen va en
// TEXTO PLANO (sin response_format): el modo JSON de Groq con gpt-oss-120b
// devolvía 400 "Failed to generate JSON" y el retry quedaba truncado.
// IMPORTANTE (gemini): max_tokens incluye los tokens de pensamiento — los
// techos de abajo son techos de CORTE, no de gasto: con poco presupuesto el
// modelo corta la respuesta visible a mitad de frase (bug del resumen de
// 71 min en 643 chars). reasoning_effort=low + techos altos evitan el corte.
const FINAL_MATERIAL_MAX_CHARS = 7_000;
// Salida del resumen: con reasoning_effort=low el texto visible ronda ~1000
// tokens; el techo alto solo evita que el pensamiento lo recorte.
const SUMMARY_MAX_TOKENS = 16_000;

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

async function summarizeChunk(chunk, index, total) {
  const messages = [
    { role: 'system', content: CHUNK_SYSTEM_PROMPT },
    { role: 'user', content: `Fragmento ${index + 1} de ${total}:\n\n${chunk}` },
  ];
  // Texto plano siempre: el modo JSON de Groq fallaba con 400 "Failed to
  // generate JSON" y los retries no alcanzaban para clases largas.
  let raw;
  try {
    raw = await chat(messages, { json: false, maxTokens: 2_000 });
  } catch (e) {
    if (/413|429|demasiado grande|timeout/i.test(e.message)) throw e;
    console.warn(`[summarize] bloque ${index + 1} falló, reintento:`, e.message.slice(0, 140));
    await sleep(2000);
    raw = await chat(messages, { json: false, maxTokens: 2_000 });
  }
  return parseChunkText(raw);
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

async function condensePartsChunk(text, index, total) {
  const raw = await chat([
    { role: 'system', content: MERGE_SYSTEM_PROMPT },
    { role: 'user', content: `Parte ${index + 1} de ${total}:\n\n${text}` },
  ], { maxTokens: 2_400 });
  return String(raw || '').trim() || text;
}

/**
 * Resumen de fondo. Errores → se lanzan al runner de jobs (reintentos con
 * backoff; al agotar, onFailed deja la nota en error).
 */
async function runSummaryJob(id, userId, template) {
  const r = await getRecording(id, userId);
  if (!r) return; // la nota se borró en el medio
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
  // "Failed to generate JSON" y el retry quedaba truncado.
  // tier 'main': este es el único call que va al modelo de calidad. La cuota
  // free de Gemini es por modelo (20 req/día en 3.6-flash vs 500 en
  // flash-lite), así que chunks/condensado/mindmap van al barato y acá
  // gastamos 1 de esas 20 llamadas diarias — la longitud del resumen
  // depende de este modelo.
  const summaryMessages = [
    { role: 'system', content: summarySystemPrompt(targetSentences) },
    { role: 'user', content: material },
  ];
  let rawSummary;
  try {
    rawSummary = await chat(summaryMessages, {
      json: false, maxTokens: SUMMARY_MAX_TOKENS, tier: 'main',
    });
  } catch (e) {
    if (/413|429|demasiado grande|timeout/i.test(e.message)) throw e;
    console.warn('[summarize] call del resumen falló, reintento:', e.message.slice(0, 140));
    await sleep(2000);
    rawSummary = await chat(summaryMessages, {
      json: false, maxTokens: SUMMARY_MAX_TOKENS, tier: 'main',
    });
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
    raw = await chat(messages, { json: true, maxTokens: 16_000 });
  } catch (e) {
    // 413/429: reintentar con menos texto ayuda. Timeout: el reintento solo
    // duplica la espera, así que se propaga al runner (reintentos con backoff).
    if (/413|429|demasiado grande|timeout/i.test(e.message)) throw e;
    console.warn('[summarize] JSON del mindmap falló, reintento simple:', e.message.slice(0, 140));
    raw = await chat(messages, { json: false, maxTokens: 16_000 });
  }

  const parsed = parseJsonLooseCtx(raw, 'JSON del mindmap inválido');
  const mindmap = normalizeMindmap(parsed.mindmap);
  if (!mindmap) throw new Error('La IA no devolvió un mapa de ideas válido');
  await saveSummary(id, userId, summaryText, mindmap);
  console.log(`[summarize] ${id} listo (${chunks.length} bloque/s)`);
}

app.post('/recordings/:id/summarize', async (req, reply) => {
  // S7: rate limit por usuario antes de cualquier trabajo.
  try {
    checkRateLimit(req.userId, 'summarize');
  } catch (e) {
    if (e.code === 'rate_limited') return sendRateLimited(reply, e);
    throw e;
  }
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!llmAvailable()) {
    return reply.code(500).send({ error: 'Sin proveedor LLM: configure GEMINI_API_KEY o OPENAI_API_KEY' });
  }
  if (!r.transcript.length) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });

  const template = req.body?.template || 'general';
  // Encolado (dedupe en DB): si ya hay un summarize activo, no duplica.
  await setStatus(r.id, req.userId, 'summarizing', null);
  await enqueueJob({
    recordingId: r.id, userId: req.userId, kind: 'summarize',
    params: { template },
  });
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
  // S7: rate limit por usuario antes de cualquier trabajo.
  try {
    checkRateLimit(req.userId, 'ask');
  } catch (e) {
    if (e.code === 'rate_limited') return sendRateLimited(reply, e);
    throw e;
  }
  const r = await getRecording(req.params.id, req.userId);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!llmAvailable()) {
    return reply.code(500).send({ error: 'Sin proveedor LLM: configure GEMINI_API_KEY o OPENAI_API_KEY' });
  }

  const question = req.body?.question || '';
  if (!question.trim()) return reply.code(400).send({ error: 'Pregunta vacía' });
  if (await activeJob(r.id, 'summarize')) {
    return reply.code(409).send({ error: 'La nota se está resumiendo. Esperá unos minutos y volvé a preguntar.' });
  }

  const transcriptText = relevantTranscript(r.transcript, question);
  if (!transcriptText) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });
  const summaryContext = r.summary ? `Resumen de la clase:\n${r.summary}\n\n` : '';

  try {
    const answer = await chat([
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

// ---------- Runner de la cola (jobs en DB) ----------

/**
 * Transcribe vía el worker propio (STT + diarización real) o, en dev sin
 * worker, vía Groq (sin diarización: speaker único, nunca alternancia falsa).
 */
async function workerTranscribe(audioPath) {
  const buf = await readFile(audioPath);
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: mimeFor(audioPath) }), path.basename(audioPath));
  const headers = WORKER_TOKEN ? { 'X-Worker-Token': WORKER_TOKEN } : {};
  const res = await groqFetch(
    'worker STT',
    `${WORKER_URL}/transcribe`,
    { method: 'POST', headers, body: form },
    WORKER_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`worker STT: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * S3: los IDs crudos de diarización (S0, SPEAKER_00) se muestran como
 * "Hablante N" por orden de primera aparición: legibles en la UI, sin exponer
 * el formato interno del worker, y listos para el rename por nota (T9).
 * Agrupa por label real del worker (no alternancia por índice).
 */
function displaySpeakers(segments) {
  const seen = new Map();
  return segments.map((s) => {
    const raw = String(s.speaker || 'SPEAKER_00');
    if (!seen.has(raw)) seen.set(raw, `Hablante ${seen.size + 1}`);
    return { ...s, speaker: seen.get(raw) };
  });
}

async function transcribeHandler(job) {
  const r = await getRecording(job.recording_id, job.user_id);
  if (!r) return; // la nota se borró en el medio
  if (!r.audioPath) throw new Error('sin audio subido');

  let segments;
  // Duración real medida por el STT (worker o Groq), si viene en la respuesta.
  let realDuration = null;
  if (WORKER_URL) {
    const out = await workerTranscribe(r.audioPath);
    realDuration = Number(out.duration);
    segments = (out.segments || []).map((s) => ({
      start: Number(s.start),
      end: Number(s.end),
      speaker: String(s.speaker || 'SPEAKER_00'),
      text: String(s.text || '').trim(),
    }));
  } else {
    // Fallback dev sin worker: Groq no diariza → un solo speaker honesto.
    const out = await openaiTranscribe(r.audioPath);
    realDuration = Number(out.duration);
    segments = (out.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      speaker: 'SPEAKER_00',
      text: String(s.text || '').trim(),
    }));
  }
  if (segments.length === 0) throw new Error('La transcripción no devolvió segmentos');

  // job.user_id, no r.userId: toRecording no expone userId, así que r.userId
  // era undefined y estos UPDATEs (ready/duration/audioPath) matcheaban 0 filas.
  segments = displaySpeakers(segments);
  await saveTranscript(r.id, job.user_id, segments);

  // S1: la cuota se estimó al subir (bytes o duración del cliente); acá la
  // reconciliamos con la duración REAL del audio según whisper — o, si el
  // proveedor no la trajo, con el fin del último segmento.
  const measured = Number.isFinite(realDuration) && realDuration > 0
    ? realDuration
    : Math.max(...segments.map((s) => s.end));
  if (measured > 0) await setDurationSeconds(r.id, job.user_id, Math.round(measured));
  // La transcripción ya está en la base: el servidor no necesita el audio.
  await removeAudioFile(r.audioPath, app.log);
  await setAudioPath(r.id, job.user_id, null);
  console.log(`[transcribe] ${r.id}: ${segments.length} segmentos listos`);
}

const runnerHandlers = {
  transcribe: transcribeHandler,
  summarize: (job) => runSummaryJob(
    job.recording_id, job.user_id, job.params?.template || 'general',
  ),
  // Trabajo agotado (JOB_MAX_ATTEMPTS): la nota queda en error visible.
  onFailed: async (job, err) => {
    const prefix = job.kind === 'summarize' ? 'No se pudo resumir: ' : '';
    await setStatus(job.recording_id, job.user_id, 'error', `${prefix}${err?.message || err}`);
  },
};

// Arranque real solo cuando somos el proceso principal (npm run dev/start).
// Los tests importan la app y la prueban con inyect sin abrir puerto.
const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT || 3001);
  // Con hostname: reencola solo los jobs de ESTA instancia; los demás
  // (u otra instancia viva) no se tocan.
  await resetInterrupted(HOSTNAME);
  await cleanupOrphanAudio(app.log);
  setInterval(() => {
    cleanupOrphanAudio(app.log).catch((e) => app.log.warn({ err: e }, 'cleanup de audios falló'));
  }, 6 * 60 * 60 * 1000).unref();
  startRunner(runnerHandlers, {
    concurrency: {
      transcribe: Number(process.env.JOB_CONCURRENCY_TRANSCRIBE || 1),
      summarize: Number(process.env.JOB_CONCURRENCY_SUMMARIZE || 1),
    },
  });
  await app.listen({ port, host: '0.0.0.0' });
}

export { app, isMain, runnerHandlers };
