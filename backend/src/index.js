import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { readFile, writeFile, unlink, readdir, stat } from 'fs/promises';
import { createReadStream } from 'fs';
import { mkdirSync } from 'fs';
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
  listAudioPaths,
  deleteRecording,
} from './db.js';

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
});
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });

const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE = process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1';
const STT_MODEL = process.env.STT_MODEL || 'whisper-large-v3';
const CHAT_MODEL = process.env.CHAT_MODEL || 'openai/gpt-oss-120b';

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
  const referenced = new Set(listAudioPaths().map((p) => path.resolve(p)));
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

async function openaiChat(messages, { json = false } = {}) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: CHAT_MODEL, messages, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
  });
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
  const res = await fetch(`${OPENAI_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper error: ${res.status} ${await res.text()}`);
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

// Normaliza al modelo { title, layout, topics[], dimensions[], items[], steps[], events[], terms[], causes[], problems[] }.
// El layout lo elige la IA. Acepta también formatos viejos: { branches }, { nodes } y { root, children }.
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

function asBranches(list, depth = 0) {
  if (!Array.isArray(list) || depth > 4) return [];
  return list
    .map((b) => ({
      label: str(b?.label),
      detail: b?.detail ? String(b.detail) : undefined,
      points: strList(b?.points),
      branches: asBranches(b?.branches ?? b?.children, depth + 1),
    }))
    .filter((b) => b.label);
}

function buildTopics(mm, fallbackTitle) {
  if (Array.isArray(mm.topics) && mm.topics.length > 0) {
    const topics = mm.topics
      .map((t, i) => {
        const branches = asBranches(t?.branches);
        const title = str(t?.title ?? t?.label) || branches[0]?.label || `Tema ${i + 1}`;
        return { title, branches };
      })
      .filter((t) => t.branches.length > 0);
    if (topics.length > 0) return topics;
  }

  if (Array.isArray(mm.branches)) {
    const branches = asBranches(mm.branches);
    if (branches.length > 0) return [{ title: fallbackTitle || branches[0].label, branches }];
  }

  if (Array.isArray(mm.nodes) && mm.nodes.length > 0) {
    const nodes = mm.nodes
      .map((n, i) => ({
        id: str(n?.id) || `n${i + 1}`,
        label: str(n?.label),
        detail: n?.detail ? String(n.detail) : undefined,
        parent: n?.parent ? String(n.parent) : null,
      }))
      .filter((n) => n.label);

    const ids = new Set(nodes.map((n) => n.id));
    const childrenOf = new Map();
    for (const n of nodes) {
      const parent = n.parent && ids.has(n.parent) && n.parent !== n.id ? n.parent : null;
      const arr = childrenOf.get(parent) || [];
      arr.push(n);
      childrenOf.set(parent, arr);
    }

    const toBranch = (n) => ({
      label: n.label,
      detail: n.detail,
      points: [],
      branches: (childrenOf.get(n.id) || []).map(toBranch),
    });

    const roots = childrenOf.get(null) || [];
    const rootKids = roots.length === 1 ? childrenOf.get(roots[0].id) || [] : [];
    const baseTitle = fallbackTitle || str(roots[0]?.label) || 'Mapa de ideas';

    if (roots.length === 1 && rootKids.length >= 2) {
      return [{ title: baseTitle, branches: rootKids.map(toBranch) }];
    }
    if (roots.length === 1 && nodes.length > 2) {
      return [{
        title: baseTitle,
        branches: nodes.map((n) => ({ label: n.label, detail: n.detail, points: [], branches: [] })),
      }];
    }
    return [{ title: baseTitle, branches: roots.map(toBranch) }];
  }

  if (mm.root || mm.children) {
    const root = String(mm.root || mm.title || 'Mapa de ideas');
    return [{
      title: root,
      branches: (mm.children || [])
        .map((c) => ({
          label: str(typeof c === 'string' ? c : c?.label),
          detail: typeof c === 'object' && c?.detail ? String(c.detail) : undefined,
          points: [],
          branches: [],
        }))
        .filter((b) => b.label),
    }];
  }
  return [];
}

const ALL_LAYOUTS = ['topics', 'comparison', 'steps', 'timeline', 'glossary', 'cause', 'solution'];

function emptyData(layout, title) {
  return {
    title: title || 'Mapa de ideas',
    layout,
    topics: [],
    dimensions: [],
    items: [],
    steps: [],
    events: [],
    terms: [],
    causes: [],
    problems: [],
  };
}

function buildComparison(mm, title) {
  const dimensions = strList(mm.dimensions);
  const items = (Array.isArray(mm.items) ? mm.items : [])
    .map((it) => ({
      name: str(it?.name ?? it?.label),
      values: Array.isArray(it?.values) ? it.values.map((v) => String(v)) : [],
    }))
    .filter((it) => it.name);
  return items.length > 0 ? { ...emptyData('comparison', title), dimensions, items } : null;
}

function buildSteps(mm, title) {
  const steps = (Array.isArray(mm.steps) ? mm.steps : [])
    .map((s) => ({
      label: str(s?.label),
      detail: s?.detail ? String(s.detail) : undefined,
      points: strList(s?.points),
    }))
    .filter((s) => s.label);
  return steps.length > 0 ? { ...emptyData('steps', title), steps } : null;
}

function buildTimeline(mm, title) {
  const events = (Array.isArray(mm.events) ? mm.events : [])
    .map((e) => ({
      date: e?.date ? String(e.date) : undefined,
      label: str(e?.label ?? e?.title),
      detail: e?.detail ? String(e.detail) : undefined,
      points: strList(e?.points),
    }))
    .filter((e) => e.label);
  return events.length > 0 ? { ...emptyData('timeline', title), events } : null;
}

function buildGlossary(mm, title) {
  const terms = (Array.isArray(mm.terms) ? mm.terms : [])
    .map((t) => ({
      term: str(t?.term ?? t?.label ?? t?.name),
      definition: str(t?.definition ?? t?.detail),
      points: strList(t?.points),
    }))
    .filter((t) => t.term && t.definition);
  return terms.length > 0 ? { ...emptyData('glossary', title), terms } : null;
}

function buildCause(mm, title) {
  const causes = (Array.isArray(mm.causes) ? mm.causes : [])
    .map((c) => ({
      label: str(c?.label ?? c?.cause),
      detail: c?.detail ? String(c.detail) : undefined,
      effects: strList(c?.effects ?? c?.points),
    }))
    .filter((c) => c.label);
  return causes.length > 0 ? { ...emptyData('cause', title), causes } : null;
}

function buildSolution(mm, title) {
  const problems = (Array.isArray(mm.problems) ? mm.problems : [])
    .map((p) => ({
      label: str(p?.label ?? p?.problem),
      detail: p?.detail ? String(p.detail) : undefined,
      solutions: strList(p?.solutions ?? p?.points),
    }))
    .filter((p) => p.label);
  return problems.length > 0 ? { ...emptyData('solution', title), problems } : null;
}

// Si el layout pedido no trae datos válidos, prueba los demás y cae a topics.
function normalizeMindmap(mm) {
  if (!mm) return null;
  const title = str(mm.title);
  const requested = ALL_LAYOUTS.includes(mm.layout) ? mm.layout : 'topics';

  const builders = {
    topics: () => {
      const topics = buildTopics(mm, title);
      return topics.length > 0
        ? { ...emptyData('topics', title || topics[0].title), topics }
        : null;
    },
    comparison: () => buildComparison(mm, title),
    steps: () => buildSteps(mm, title),
    timeline: () => buildTimeline(mm, title),
    glossary: () => buildGlossary(mm, title),
    cause: () => buildCause(mm, title),
    solution: () => buildSolution(mm, title),
  };

  const order = [requested, ...ALL_LAYOUTS.filter((l) => l !== requested)];
  for (const layout of order) {
    const data = builders[layout]();
    if (data) return data;
  }
  return null;
}

app.get('/health', async () => ({ ok: true, openai: !!OPENAI_KEY, stt: STT_MODEL, chat: CHAT_MODEL }));

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

  return createRecording({ id: id(), title, audioPath, youtubeUrl, createdAt: now() });
});

// Vuelve a subir el audio de una nota existente (por ejemplo, para reanalizarla
// después de que el servidor borró su copia tras transcribir).
app.post('/recordings/:id/audio', async (req, reply) => {
  const r = getRecording(req.params.id);
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
  setAudioPath(r.id, fp);
  return getRecording(r.id);
});

app.get('/recordings', async (req) => {
  return listRecordings(req.query?.q || '');
});

app.get('/recordings/:id', async (req, reply) => {
  const r = getRecording(req.params.id);
  if (!r) return reply.code(404).send({ error: 'not found' });
  return r;
});

app.delete('/recordings/:id', async (req, reply) => {
  const r = getRecording(req.params.id);
  if (!r) return reply.code(404).send({ error: 'not found' });
  // Primero la fila (la nota desaparece ya) y después el archivo. Si el
  // archivo está bloqueado, el cleanup lo borra más tarde.
  deleteRecording(req.params.id);
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
  const r = getRecording(req.params.id);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });
  if (!r.audioPath) return reply.code(400).send({ error: 'sin audio subido' });

  setStatus(r.id, 'transcribing');
  try {
    const result = await openaiTranscribe(r.audioPath);
    const segments = (result.segments || []).map((s, i) => ({
      start: s.start,
      end: s.end,
      speaker: `SPEAKER_${String(i % 2).padStart(2, '0')}`,
      text: s.text.trim(),
    }));
    const saved = saveTranscript(r.id, segments);
    // La transcripción ya está en SQLite: el servidor no necesita conservar el
    // audio. El cliente mantiene su copia local para reproducir la clase.
    await removeAudioFile(r.audioPath, req.log);
    setAudioPath(r.id, null);
    return { ...saved, audioPath: null };
  } catch (e) {
    console.error('[transcribe] error:', e.message);
    return setStatus(r.id, 'error', e.message);
  }
});

app.post('/recordings/:id/summarize', async (req, reply) => {
  const r = getRecording(req.params.id);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });

  const template = req.body?.template || 'general';
  const transcriptText = r.transcript.map((s) => `[${s.speaker}] ${s.text}`).join('\n');
  if (!transcriptText) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });

  try {
    const messages = [
      {
        role: 'system',
        content: `Eres un experto que convierte transcripciones en mapas de ideas de estudio en español. Template: ${template}. `
          + 'Responde SOLO JSON con esta forma exacta: '
          + '{'
          + '"summary": string, '
          + '"mindmap": {'
          + '"title": string, '
          + '"layout": "topics"|"comparison"|"steps"|"timeline"|"glossary"|"cause"|"solution", '
          + '"topics": [{"title": string, "branches": [{"label": string, "detail": string, "points": [string], "branches": [{"label": string, "detail": string, "points": [string]}]}]}], '
          + '"dimensions": [string], '
          + '"items": [{"name": string, "values": [string]}], '
          + '"steps": [{"label": string, "detail": string, "points": [string]}], '
          + '"events": [{"date": string, "label": string, "detail": string, "points": [string]}], '
          + '"terms": [{"term": string, "definition": string, "points": [string]}], '
          + '"causes": [{"label": string, "detail": string, "effects": [string]}], '
          + '"problems": [{"label": string, "detail": string, "solutions": [string]}]'
          + '}'
          + '}. '
          + 'Elegí el layout que MEJOR se adapte al contenido escuchado y completá SOLO sus campos (podés omitir los demás): '
          + '"topics" = mapa conceptual de uno o varios temas con sus ideas (USO GENERAL, el más común); '
          + '"comparison" = se comparan varios elementos (teorías, modelos, autores, enfoques) a lo largo de dimensiones comunes; '
          + '"steps" = proceso, método, algoritmo o secuencia de pasos a seguir; '
          + '"timeline" = evolución o sucesión histórica de hechos con fechas o etapas; '
          + '"glossary" = la clase consiste esencialmente en DEFINIR términos o conceptos (una lista de definiciones, sin comparación, proceso ni causas); '
          + '"cause" = se explican causas y sus efectos o consecuencias; '
          + '"solution" = se plantean problemas y sus soluciones, o un caso con diagnóstico y tratamiento. '
          + 'IMPORTANTE: los diseños especiales (comparison, steps, timeline, glossary, cause, solution) usalos SOLO si el contenido realmente se ajusta a esa forma; si no, usá "topics". No fuerces un diseño. '
          + 'NO hay límite de temas, ramas, sub-ramas, puntos, elementos, pasos, eventos, términos, causas ni problemas: usá tantos como necesite la clase para cubrir TODAS las ideas principales. '
          + 'Si el tema lo pide, anidá sub-ramas dentro de una rama usando su campo "branches". '
          + 'Una clase puede tratar uno o varios temas centrales; si son varios, devolvé varios objetos en topics. '
          + 'Reglas de contenido: label/term/label de paso/evento/etiqueta corto (2 a 5 palabras); detail o definition una o dos frases con el contenido real de la transcripción; points/effects/solutions viñetas concretas (datos, sub-ideas, fórmulas, ejemplos); para comparison, cada item con sus values en el mismo orden que dimensions; para timeline usá "date" con el año, década o momento mencionado. '
          + 'Organizá por relación de ideas; solo usá orden cronológico cuando elijas "timeline" o "steps". No menciones minutos de la grabación. '
          + 'No repitas ideas y no inventes contenido ausente. '
          + 'El summary debe ser un resumen de estudio de 3 a 6 frases.',
      },
      { role: 'user', content: transcriptText },
    ];

    let raw;
    try {
      raw = await openaiChat(messages, { json: true });
    } catch (e) {
      console.warn('[summarize] JSON mode falló, reintento sin response_format:', e.message.slice(0, 160));
      raw = await openaiChat(messages, { json: false });
    }

    const parsed = parseJsonLoose(raw);
    return saveSummary(r.id, parsed.summary, normalizeMindmap(parsed.mindmap));
  } catch (e) {
    console.error('[summarize] error:', e.message);
    return reply.code(500).send({ error: e.message });
  }
});

app.post('/recordings/:id/ask', async (req, reply) => {
  const r = getRecording(req.params.id);
  if (!r) return reply.code(404).send({ error: 'not found' });
  if (!OPENAI_KEY) return reply.code(500).send({ error: 'OPENAI_API_KEY no configurada' });

  const question = req.body?.question || '';
  if (!question.trim()) return reply.code(400).send({ error: 'Pregunta vacía' });

  const transcriptText = r.transcript.map((s) => `[${s.start}-${s.end}] ${s.speaker}: ${s.text}`).join('\n');
  if (!transcriptText) return reply.code(400).send({ error: 'La grabación no tiene transcripción' });

  try {
    const answer = await openaiChat([
      { role: 'system', content: 'Respondé preguntas sobre la transcripción. Sé preciso y breve. Si la respuesta no está en la transcripción, decilo.' },
      { role: 'user', content: `Transcripción:\n${transcriptText}\n\nPregunta: ${question}` },
    ]);
    return {
      answer,
      citations: r.transcript.map((s) => ({ start: s.start, end: s.end })),
    };
  } catch (e) {
    return reply.code(500).send({ error: e.message });
  }
});

const port = Number(process.env.PORT || 3001);
await cleanupOrphanAudio(app.log);
setInterval(() => {
  cleanupOrphanAudio(app.log).catch((e) => app.log.warn({ err: e }, 'cleanup de audios falló'));
}, 6 * 60 * 60 * 1000).unref();
await app.listen({ port, host: '0.0.0.0' });
