import pg from 'pg';
import dns from 'dns';

// Supabase pooler: el DNS local a veces no resuelve. Forzamos DNS públicos.
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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
  transcript: segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text })),
  createdAt: row.created_at,
});

export async function createRecording({ id, userId, title, audioPath = null, youtubeUrl = null, createdAt }) {
  await pool.query(
    `INSERT INTO recordings (id, user_id, title, status, audio_path, youtube_url, created_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6)`,
    [id, userId, title, audioPath, youtubeUrl, createdAt],
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
        'INSERT INTO segments (recording_id, idx, start, end, speaker, text) VALUES ($1,$2,$3,$4,$5,$6)',
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

export async function listAudioPaths(userId) {
  const { rows } = await pool.query(
    'SELECT audio_path FROM recordings WHERE user_id = $1 AND audio_path IS NOT NULL',
    [userId],
  );
  return rows.map((r) => r.audio_path).filter(Boolean);
}

export async function deleteRecording(id, userId) {
  await pool.query('DELETE FROM recordings WHERE id = $1 AND user_id = $2', [id, userId]);
}

/** Al arrancar, las notas que quedaron a mitad de análisis pasan a error. */
export async function resetInterrupted() {
  await pool.query(
    `UPDATE recordings SET status = 'error',
     error = 'El análisis se interrumpió (el servidor se reinició). Volvé a intentarlo.'
     WHERE status IN ('transcribing', 'summarizing')`,
  );
}
