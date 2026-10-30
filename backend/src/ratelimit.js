// Rate limiting básico por usuario en los endpoints de IA (S7).
//
// IMPORTANTE: es POR PROCESO (beta single-instance): el Map vive en la
// memoria del backend y se pierde al reiniciar. Con varias instancias detrás
// de un balanceador habría que moverlo a Postgres/Redis; por ahora el tope
// real del sistema es la cuota de audio en DB (quota.js), que sí persiste.
//
// La configuración se lee por llamada (igual que quota.js y llm.js) para que
// los tests puedan setear RL_*_MAX entre casos.
const RULES = {
  // acción            env                default  ventana (s)
  transcribe: { env: 'RL_TRANSCRIBE_MAX', fallback: 10, windowSec: 60, label: 'transcripción' },
  summarize: { env: 'RL_SUMMARIZE_MAX', fallback: 10, windowSec: 3600, label: 'resumen' },
  ask: { env: 'RL_ASK_MAX', fallback: 30, windowSec: 60, label: 'preguntas' },
};

// "userId:acción" → timestamps (ms) dentro de la ventana.
const hits = new Map();

const fmtWait = (sec) => (sec >= 120 ? `~${Math.round(sec / 60)} min` : `~${sec} s`);

/** Memoria acotada: poda claves cuyos timestamps ya vencieron todos. */
function pruneEmpty(now) {
  for (const [key, stamps] of hits) {
    if (stamps.length === 0 || now - stamps[stamps.length - 1] >= windowOf(key)) {
      hits.delete(key);
    }
  }
}

function windowOf(key) {
  const action = key.slice(key.indexOf(':') + 1);
  return (RULES[action]?.windowSec || 60) * 1000;
}

/**
 * Registra un llamado de `userId` a `action` y lanza si supera el máximo de
 * la ventana deslizante. El error lleva .code='rate_limited' y .retryAfterSec
 * (segundos hasta que vence el llamado más viejo de la ventana).
 */
export function checkRateLimit(userId, action) {
  const rule = RULES[action];
  if (!rule) throw new Error(`rate limit: acción desconocida "${action}"`);

  const now = Date.now();
  const windowMs = rule.windowSec * 1000;
  const max = Number(process.env[rule.env] || rule.fallback);
  const key = `${userId}:${action}`;

  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);

  if (recent.length >= max) {
    hits.set(key, recent);
    const retryAfterSec = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
    const err = new Error(
      `Demasiadas solicitudes de ${rule.label}. Esperá ${fmtWait(rule.windowSec)}.`,
    );
    err.code = 'rate_limited';
    err.retryAfterSec = retryAfterSec;
    throw err;
  }

  recent.push(now);
  hits.set(key, recent);
  // Acotado: >50k claves implica memoria sin poda posible; limpiamos vacías.
  if (hits.size > 50_000) pruneEmpty(now);
  return { remaining: max - recent.length, limit: max };
}
