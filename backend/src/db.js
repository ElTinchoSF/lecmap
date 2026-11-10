import pg from 'pg';
import dns from 'dns';

// Supabase pooler: el DNS local a veces no resuelve. Forzamos DNS públicos.
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { Pool } = pg;

// SSL del pool: producción fuerza SSL (Render lo exige). En la VM self-hosted
// (Hetzner, T10) Postgres no lo tiene: DATABASE_SSL=disable lo apaga.
const ssl = process.env.DATABASE_SSL === 'disable'
  ? false
  : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});
// Exportado para tests (simular locks stale) y para tareas directas.
export { pool };

// ---------- recordings ----------

const toRecording = (row, segments = []) => row && ({
  id: row.id,
  title: row.title,
  status: row.status,
  error: row.error || undefined,
  audioPath: row.audio_path || null,
  youtubeUrl: row.youtube_url || null,
  summary: row.summary || null,
  mindmap: row.mindmap ?? null,
  durationSeconds: row.duration_seconds ?? null,
  // T9 (S3): overlay {label original → visible} sobre segments.speaker;
  // la diarización original en DB queda intacta.
  transcript: segments.map((s) => ({
    start: s.start,
    end: s.end,
    speaker: (row.speaker_labels || {})[s.speaker] || s.speaker,
    text: s.text,
  })),
  createdAt: row.created_at,
});

export async function createRecording({
  id, userId, title, audioPath = null, youtubeUrl = null, createdAt, durationSeconds = null,
}) {
  await pool.query(
    `INSERT INTO recordings (id, user_id, title, status, audio_path, youtube_url, created_at, duration_seconds)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)`,
    [id, userId, title, audioPath, youtubeUrl, createdAt, durationSeconds],
  );
  return getRecording(id, userId);
}

export async function getRecording(id, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM recordings WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!rows[0]) return null;
  const segs = await pool.query(
    'SELECT * FROM segments WHERE recording_id = $1 ORDER BY idx',
    [id],
  );
  return toRecording(rows[0], segs.rows);
}

export async function listRecordings(userId, keyword = '', { limit = 50, offset = 0 } = {}) {
  const kw = keyword.trim().toLowerCase();
  let rows, total;
  if (kw) {
    const r = await pool.query(
      `SELECT DISTINCT r.* FROM recordings r
       LEFT JOIN segments s ON s.recording_id = r.id
       WHERE r.user_id = $1 AND (lower(r.title) LIKE $2 OR lower(s.text) LIKE $2)
       ORDER BY r.created_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, `%${kw}%`, limit, offset],
    );
    rows = r.rows;
    const c = await pool.query(
      `SELECT COUNT(DISTINCT r.id) AS n FROM recordings r
       LEFT JOIN segments s ON s.recording_id = r.id
       WHERE r.user_id = $1 AND (lower(r.title) LIKE $2 OR lower(s.text) LIKE $2)`,
      [userId, `%${kw}%`],
    );
    total = Number(c.rows[0].n);
  } else {
    const r = await pool.query(
      'SELECT * FROM recordings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset],
    );
    rows = r.rows;
    const c = await pool.query(
      'SELECT COUNT(*) AS n FROM recordings WHERE user_id = $1',
      [userId],
    );
    total = Number(c.rows[0].n);
  }
  // Cargar segments en batch (evita N+1)
  const ids = rows.map((r) => r.id);
  let segMap = new Map();
  if (ids.length) {
    const s = await pool.query(
      'SELECT * FROM segments WHERE recording_id = ANY($1) ORDER BY recording_id, idx',
      [ids],
    );
    for (const seg of s.rows) {
      if (!segMap.has(seg.recording_id)) segMap.set(seg.recording_id, []);
      segMap.get(seg.recording_id).push(seg);
    }
  }
  const items = rows.map((row) => toRecording(row, segMap.get(row.id) || []));
  return { items, total, limit, offset };
}

export async function setStatus(id, userId, status, error = null) {
  await pool.query(
    'UPDATE recordings SET status = $1, error = $2 WHERE id = $3 AND user_id = $4',
    [status, error, id, userId],
  );
  return getRecording(id, userId);
}

export async function saveTranscript(id, userId, segments) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM segments WHERE recording_id = $1', [id]);
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      await client.query(
        'INSERT INTO segments (recording_id, idx, start, "end", speaker, text) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, i, s.start, s.end, s.speaker, s.text],
      );
    }
    await client.query(
      `UPDATE recordings SET status = 'ready', error = NULL WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return getRecording(id, userId);
}

export async function saveSummary(id, userId, summary, mindmap) {
  await pool.query(
    `UPDATE recordings SET summary = $1, mindmap = $2, status = 'ready', error = NULL
     WHERE id = $3 AND user_id = $4`,
    [summary, JSON.stringify(mindmap ?? null), id, userId],
  );
  return getRecording(id, userId);
}

export async function setAudioPath(id, userId, audioPath) {
  await pool.query(
    'UPDATE recordings SET audio_path = $1 WHERE id = $2 AND user_id = $3',
    [audioPath, id, userId],
  );
  return getRecording(id, userId);
}

/**
 * S1/T7: setea SOLO la duración del audio. Se usa para reconciliar la
 * duración estimada al subir con la duración real que midió whisper
 * (o el ffprobe del server) una vez transcrito.
 */
export async function setDurationSeconds(id, userId, seconds) {
  await pool.query(
    'UPDATE recordings SET duration_seconds = $1 WHERE id = $2 AND user_id = $3',
    [Math.round(Number(seconds)), id, userId],
  );
  return getRecording(id, userId);
}

/** S4: renombra la nota (PATCH /recordings/:id con { title }). */
export async function updateTitle(id, userId, title) {
  await pool.query(
    'UPDATE recordings SET title = $1 WHERE id = $2 AND user_id = $3',
    [title, id, userId],
  );
  return getRecording(id, userId);
}

/**
 * T9 (S3): renombra un hablante de la nota SIN tocar la diarización original.
 * Solo escribe el mapa speaker_labels {label original → visible}; los valores
 * visibles deben seguir siendo únicos por nota (evita dos "Docente" iguales).
 * `from` acepta el label original o el visible actual; `to` vacío revierte.
 * Devuelve { error, status } o el recording actualizado.
 */
export async function renameSpeaker(id, userId, from, to) {
  const { rows } = await pool.query(
    'SELECT speaker_labels FROM recordings WHERE id = $1 AND user_id = $2',
    [id, userId],
  );
  if (!rows[0]) return { error: 'not found', status: 404 };
  const labels = rows[0].speaker_labels || {};
  const { rows: segs } = await pool.query(
    'SELECT DISTINCT speaker FROM segments WHERE recording_id = $1', [id]);
  const originals = segs.map((s) => s.speaker);

  // Resolver from → label original: puede venir como original o como visible.
  let original = Object.keys(labels).find((k) => k === from || labels[k] === from);
  if (!original && originals.includes(from)) original = from;
  if (!original) return { error: `no hay hablante "${from}" en esta nota`, status: 400 };

  const next = { ...labels };
  if (!to || to === original) delete next[original]; // revertir
  else next[original] = to;

  // Los visibles resultantes deben ser únicos (incluye labels sin renombrar).
  const visible = originals.map((o) => next[o] || o);
  if (new Set(visible).size !== visible.length) {
    return { error: `ya hay un hablante llamado "${to}" en esta nota`, status: 400 };
  }

  await pool.query(
    'UPDATE recordings SET speaker_labels = $1 WHERE id = $2 AND user_id = $3',
    [Object.keys(next).length ? next : null, id, userId],
  );
  return getRecording(id, userId);
}

/**
 * ¿El usuario es dueño de la nota que referencia este audio? Para
 * GET /files/:name: el path guardado y el servido se construyen igual
 * (uploadsDir + basename), así que basta igualdad exacta.
 */
export async function recordingOwnsAudio(userId, audioPath) {
  const { rows } = await pool.query(
    'SELECT id FROM recordings WHERE user_id = $1 AND audio_path = $2 LIMIT 1',
    [userId, audioPath],
  );
  return rows.length > 0;
}

/**
 * Rutas de audio referenciadas por CUALQUIER nota. El limpiador de huérfanos
 * necesita ver todas las filas: filtrar por user_id (con userId undefined →
 * NULL) devolvía 0 filas y el cleanup borraba TODOS los audios de uploads/.
 */
export async function listAudioPaths() {
  const { rows } = await pool.query(
    'SELECT audio_path FROM recordings WHERE audio_path IS NOT NULL',
  );
  return rows.map((r) => r.audio_path).filter(Boolean);
}

export async function deleteRecording(id, userId) {
  await pool.query('DELETE FROM recordings WHERE id = $1 AND user_id = $2', [id, userId]);
}

/**
 * Al arrancar: (1) reencola los trabajos que corrían en ESTA instancia (la
 * anterior murió con ellos); (2) marca error las notas interrumpidas que NO
 * tienen job activo — las que tienen, el runner las retoma solo.
 */
export async function resetInterrupted(hostnamePrefix) {
  if (hostnamePrefix) {
    await pool.query(
      `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
         updated_at = now()
       WHERE status = 'running' AND locked_by LIKE $1 || ':%'`,
      [hostnamePrefix],
    );
  }
  await pool.query(
    `UPDATE recordings SET status = 'error',
     error = 'El análisis se interrumpió (el servidor se reinició). Volvé a intentarlo.'
     WHERE status IN ('transcribing', 'summarizing')
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.recording_id = recordings.id
           AND j.status IN ('queued', 'running')
       )`,
  );
}

/** Cierra el pool (tests y shutdown ordenado). */
export async function closePool() {
  await pool.end();
}

// ---------- cola de trabajos (transcribe | summarize) ----------

export const JOB_MAX_ATTEMPTS = Number(process.env.JOB_MAX_ATTEMPTS || 3);
export const JOB_STALE_MIN = Number(process.env.JOB_STALE_MIN || 10);

/**
 * Encola un trabajo para una nota. Dedupe: si ya hay uno activo del mismo
 * tipo para la misma nota, devuelve ese (índice único parcial).
 */
export async function enqueueJob({ recordingId, userId, kind, params = null }) {
  const id = Math.random().toString(36).slice(2, 10)
    + Math.random().toString(36).slice(2, 10);
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, recording_id, user_id, kind, params)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (recording_id, kind) WHERE status IN ('queued', 'running')
     DO UPDATE SET updated_at = now()
     RETURNING *`,
    [id, recordingId, userId, kind, params ? JSON.stringify(params) : null],
  );
  return rows[0];
}

/**
 * Reclama el próximo trabajo disponible del tipo dado (SKIP LOCKED: seguro
 * con varias instancias). Los locks viejos (instancia muerta) se toman como
 * disponibles.
 */
export async function claimJob(kind, workerId) {
  const { rows } = await pool.query(
    `UPDATE jobs SET
       status = 'running', locked_by = $1, locked_at = now(),
       attempts = attempts + 1, updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE kind = $2
         AND available_at <= now()
         AND (status = 'queued'
           OR (status = 'running'
               AND locked_at < now() - make_interval(mins => $3)))
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, kind, JOB_STALE_MIN],
  );
  return rows[0] || null;
}

/** Trabajo completado: done, sin lock. */
export async function finishJob(id) {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'done', locked_by = NULL, locked_at = NULL,
       error = NULL, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0];
}

/**
 * Fallo de trabajo: si quedan intentos vuelve a la cola (backoff simple),
 * si no queda pasa a error. Solo el dueño del lock puede marcarlo.
 */
export async function failJob(id, error, workerId) {
  const { rows } = await pool.query(
    `UPDATE jobs SET
       status = CASE WHEN attempts >= $2 THEN 'error' ELSE 'queued' END,
       error = $3,
       locked_by = NULL,
       locked_at = NULL,
       available_at = now() + make_interval(mins => attempts),
       updated_at = now()
     WHERE id = $1 AND locked_by = $4
     RETURNING *`,
    [id, JOB_MAX_ATTEMPTS, String(error || 'error').slice(0, 500), workerId],
  );
  if (rows[0]) return rows[0];
  // Sin lock propio (stale takeover u otro worker): se queda como está.
  const cur = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return cur.rows[0];
}

/** Trabajo activo (queued/running) de una nota, o null. */
export async function activeJob(recordingId, kind) {
  const { rows } = await pool.query(
    `SELECT * FROM jobs WHERE recording_id = $1 AND kind = $2
     AND status IN ('queued', 'running') LIMIT 1`,
    [recordingId, kind],
  );
  return rows[0] || null;
}

/**
 * Heartbeat mientras un trabajo corre: refresca locked_at para que otro no lo
 * reclame como stale. Indispensable: una transcripción de 2 h excede con creces
 * JOB_STALE_MIN.
 */
export async function heartbeatJob(id, workerId) {
  await pool.query(
    'UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2',
    [id, workerId],
  );
}
