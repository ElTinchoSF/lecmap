// Cuota de audio diaria por usuario (S1) + duración del audio subido (T7).
// El env se lee por llamada (mismo patrón que src/llm.js) para que los tests
// puedan setear QUOTA_AUDIO_SECONDS_PER_DAY / QUOTA_TZ entre casos.
import { spawn } from 'node:child_process';
import { pool } from './db.js';

// Beta S1: 2 h de grabación por usuario por día. El override del usuario
// (profiles.quota_seconds_per_day) habilita tiers pro solo seteando esa fila.
const DEFAULT_QUOTA_SECONDS = 7200;
const DEFAULT_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Cuota en segundos del usuario: si el perfil tiene override se usa ese;
 * si no hay fila o el valor es NULL, el default global del entorno.
 */
export async function getQuotaSeconds(userId) {
  const { rows } = await pool.query(
    'SELECT quota_seconds_per_day FROM profiles WHERE id = $1',
    [userId],
  );
  const override = rows[0]?.quota_seconds_per_day;
  if (override !== null && override !== undefined) return Number(override);
  return Number(process.env.QUOTA_AUDIO_SECONDS_PER_DAY || DEFAULT_QUOTA_SECONDS);
}

/**
 * Segundos ya consumidos HOY por el usuario (día calendario en QUOTA_TZ, no
 * en UTC: la clase de la noche no debe caer en el día siguiente del servidor).
 * `excludeRecordingId` saca una nota propia del cómputo (re-upload que
 * reemplaza el mismo audio: no se debe contar dos veces).
 */
export async function getUsageSeconds(userId, { excludeRecordingId } = {}) {
  const tz = process.env.QUOTA_TZ || DEFAULT_TZ;
  let sql = `SELECT COALESCE(SUM(duration_seconds), 0) AS used
             FROM recordings
             WHERE user_id = $1
               AND (created_at AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date`;
  const params = [userId, tz];
  if (excludeRecordingId) {
    sql += ' AND id <> $3';
    params.push(excludeRecordingId);
  }
  const { rows } = await pool.query(sql, params);
  // SUM(integer) vuelve como bigint → el driver lo entrega como string.
  return Number(rows[0]?.used || 0);
}

/**
 * Corta si `incomingSeconds` más lo ya usado hoy supera la cuota.
 * Lanza Error con .code='quota_exceeded', .used, .quota y .remaining;
 * si entra, devuelve { used, quota, remaining }.
 */
export async function assertQuota(userId, incomingSeconds, opts = {}) {
  const incoming = Math.max(0, Number(incomingSeconds) || 0);
  const used = await getUsageSeconds(userId, opts);
  const quota = await getQuotaSeconds(userId);
  const remaining = Math.max(0, quota - used);
  if (used + incoming > quota) {
    const err = new Error(
      `Cuota de audio diaria excedida: ${used + incoming} s de ${quota} s`,
    );
    err.code = 'quota_exceeded';
    err.used = used;
    err.quota = quota;
    err.remaining = remaining;
    throw err;
  }
  return { used, quota, remaining };
}

// ffprobe async (R4-1): spawnSync acá bloqueaba el event loop hasta 5 s.
// Se cachea una sola vez por proceso (el binario no aparece ni se va).
let ffprobeState = null;
export function resetFfprobeCache() {
  ffprobeState = null;
}
function hasFfprobe() {
  if (!ffprobeState) {
    ffprobeState = new Promise((resolve) => {
      try {
        const p = spawn('ffprobe', ['-version'], { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }
  return ffprobeState;
}

/** Duración en segundos vía ffprobe async; null si falla o timed out (5 s). */
function ffprobeDuration(filePath) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', String(filePath)]);
    const timer = setTimeout(() => { p.kill(); resolve(null); }, 5000);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const secs = Number(out.trim());
      resolve(code === 0 && Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null);
    });
  });
}

// R1-001: si el `duration` del cliente implica > 320 kbps, es mentiroso
// (mide 1 s un archivo de horas) y manda la estimación por bytes.
const MAX_PLAUSIBLE_BPS = 320_000;

export async function resolveDurationSeconds(filePath, clientSeconds, bytes) {
  if (filePath && await hasFfprobe()) {
    const secs = await ffprobeDuration(filePath);
    if (secs) return secs;
  }
  const bytesNum = Number(bytes) || 0;
  const client = Number(clientSeconds);
  if (Number.isFinite(client) && client > 0) {
    const impliedBps = bytesNum > 0 ? (bytesNum * 8) / client : 0;
    if (bytesNum === 0 || impliedBps <= MAX_PLAUSIBLE_BPS) return Math.round(client);
  }
  return Math.max(1, Math.round(bytesNum / 4000));
}

// R4-2: serializa check→insert de cuota por usuario (single-instance, como
// ratelimit.js); multi-instancia necesitaría advisory locks de Postgres.
const quotaChains = new Map();export function withQuotaLock(userId, fn) {
  const prev = quotaChains.get(userId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.then(() => {}, () => {});
  quotaChains.set(userId, tail);
  tail.then(() => {
    if (quotaChains.get(userId) === tail) quotaChains.delete(userId);
  });
  return run;
}
