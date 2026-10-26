import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { mkdirSync } from 'fs';

const DATA_DIR = path.resolve('data');
mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'notas.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS recordings (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    audio_path TEXT,
    youtube_url TEXT,
    summary TEXT,
    mindmap TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS segments (
    recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    start REAL NOT NULL,
    end REAL NOT NULL,
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (recording_id, idx)
  );

  CREATE INDEX IF NOT EXISTS idx_recordings_created ON recordings(created_at DESC);
`);

const toRecording = (row, segments = []) => row && ({
  id: row.id,
  title: row.title,
  status: row.status,
  error: row.error || undefined,
  audioPath: row.audio_path || null,
  youtubeUrl: row.youtube_url || null,
  summary: row.summary || null,
  mindmap: row.mindmap ? JSON.parse(row.mindmap) : null,
  transcript: segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker, text: s.text })),
  createdAt: row.created_at,
});

const q = {
  insertRecording: db.prepare(`INSERT INTO recordings (id, title, status, audio_path, youtube_url, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
  getRecording: db.prepare(`SELECT * FROM recordings WHERE id = ?`),
  listRecordings: db.prepare(`SELECT * FROM recordings ORDER BY created_at DESC LIMIT ? OFFSET ?`),
  listByKeyword: db.prepare(`
    SELECT DISTINCT r.* FROM recordings r
    LEFT JOIN segments s ON s.recording_id = r.id
    WHERE lower(r.title) LIKE ? OR lower(s.text) LIKE ?
    ORDER BY r.created_at DESC
    LIMIT ? OFFSET ?
  `),
  countRecordings: db.prepare(`SELECT COUNT(*) AS n FROM recordings`),
  countByKeyword: db.prepare(`
    SELECT COUNT(DISTINCT r.id) AS n FROM recordings r
    LEFT JOIN segments s ON s.recording_id = r.id
    WHERE lower(r.title) LIKE ? OR lower(s.text) LIKE ?
  `),
  deleteRecording: db.prepare(`DELETE FROM recordings WHERE id = ?`),
  setStatus: db.prepare(`UPDATE recordings SET status = ?, error = ? WHERE id = ?`),
  setTranscriptMeta: db.prepare(`UPDATE recordings SET status = 'ready', error = NULL WHERE id = ?`),
  setSummary: db.prepare(`UPDATE recordings SET summary = ?, mindmap = ?, status = 'ready', error = NULL WHERE id = ?`),
  resetInterrupted: db.prepare(`UPDATE recordings SET status = 'error', error = 'El análisis se interrumpió (el servidor se reinició). Volvé a intentarlo.' WHERE status IN ('transcribing', 'summarizing')`),
  setAudioPath: db.prepare(`UPDATE recordings SET audio_path = ? WHERE id = ?`),
  listAudioPaths: db.prepare(`SELECT audio_path FROM recordings WHERE audio_path IS NOT NULL`),
  insertSegment: db.prepare(`INSERT INTO segments (recording_id, idx, start, end, speaker, text) VALUES (?, ?, ?, ?, ?, ?)`),
  clearSegments: db.prepare(`DELETE FROM segments WHERE recording_id = ?`),
  getSegments: db.prepare(`SELECT * FROM segments WHERE recording_id = ? ORDER BY idx`),
};

export function createRecording({ id, title, audioPath = null, youtubeUrl = null, createdAt }) {
  q.insertRecording.run(id, title, 'queued', audioPath, youtubeUrl, createdAt);
  return getRecording(id);
}

export function getRecording(id) {
  const row = q.getRecording.get(id);
  if (!row) return null;
  return toRecording(row, q.getSegments.all(id));
}

export function listRecordings(keyword = '', { limit = 50, offset = 0 } = {}) {
  const kw = keyword.trim().toLowerCase();
  const hasKw = kw.length > 0;
  const rows = hasKw
    ? q.listByKeyword.all(`%${kw}%`, `%${kw}%`, limit, offset)
    : q.listRecordings.all(limit, offset);
  const total = hasKw
    ? q.countByKeyword.get(`%${kw}%`, `%${kw}%`).n
    : q.countRecordings.get().n;
  const items = rows.map((row) => toRecording(row, q.getSegments.all(row.id)));
  return { items, total, limit, offset };
}

export function setStatus(id, status, error = null) {
  q.setStatus.run(status, error, id);
  return getRecording(id);
}

export function saveTranscript(id, segments) {
  db.exec('BEGIN');
  try {
    q.clearSegments.run(id);
    segments.forEach((s, i) => q.insertSegment.run(id, i, s.start, s.end, s.speaker, s.text));
    q.setTranscriptMeta.run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getRecording(id);
}

export function saveSummary(id, summary, mindmap) {
  q.setSummary.run(summary, JSON.stringify(mindmap ?? null), id);
  return getRecording(id);
}

/** Al arrancar, las notas que quedaron a mitad de análisis pasan a error. */
export function resetInterrupted() {
  q.resetInterrupted.run();
}

export function setAudioPath(id, audioPath) {
  q.setAudioPath.run(audioPath, id);
  return getRecording(id);
}

export function listAudioPaths() {
  return q.listAudioPaths.all().map((row) => row.audio_path).filter(Boolean);
}

export function deleteRecording(id) {
  q.deleteRecording.run(id);
}
