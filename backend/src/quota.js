// Cuota de audio diaria por usuario (S1) + duración del audio subido (T7).
// El env se lee por llamada (mismo patrón que src/llm.js) para que los tests
// puedan setear QUOTA_AUDIO_SECONDS_PER_DAY / QUOTA_TZ entre casos.
import { spawnSync } from 'node:child_process';
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

// ffprobe es la fuente autoritativa de duración cuando está instalado.
// Se chequea una sola vez por proceso (el binario no aparece ni desaparece
// en runtime): spawnSync no lanza, devuelve .error (ENOENT) si falta.
let ffprobeState = null;
function hasFfprobe() {
  if (ffprobeState === null) {
    try {
      const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 3000 });
      ffprobeState = !probe.error && probe.status === 0;
    } catch {
      ffprobeState = false;
    }
  }
  return ffprobeState;
}

/**
 * Duración en segundos, nunca null:
 *   a) ffprobe sobre el archivo escrito (si el binario existe);
 *   b) la duración que midió el cliente en el navegador/Android;
 *   c) estimación por bytes a 32 kbps (bitrate default de grabación Android).
 */
export function resolveDurationSeconds(filePath, clientSeconds, bytes) {
  if (filePath && hasFfprobe()) {
    try {
      const r = spawnSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1', String(filePath)],
        { encoding: 'utf8', timeout: 5000 },
      );
      const secs = Number(String(r.stdout || '').trim());
      if (!r.error && r.status === 0 && Number.isFinite(secs) && secs > 0) {
        return Math.round(secs);
      }
    } catch {
      // ffprobe roto/incompatible: seguimos con el fallback del cliente.
    }
  }
  const client = Number(clientSeconds);
  if (Number.isFinite(client) && client > 0) return Math.round(client);
  return Math.max(1, Math.round((Number(bytes) || 0) / 4000));
}
