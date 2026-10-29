// Runner de la cola de trabajos (jobs en DB).
// Reclama trabajos con SKIP LOCKED (seguro con varias instancias), los procesa
// con los handlers que inyecta index.js, y gestiona heartbeat + reintentos.
import os from 'os';
import { claimJob, finishJob, failJob, heartbeatJob } from './db.js';

// Identidad de esta instancia: hostname:pid. resetInterrupted la usa para
// reencolar SOLO los trabajos que corrían en esta instancia.
export const WORKER_ID = `${os.hostname()}:${process.pid}`;
export const HOSTNAME = os.hostname();

const HEARTBEAT_MS = 30_000;

/**
 * Procesa un trabajo ya reclamado. handlers = {
 *   transcribe(job), summarize(job),   // lanzan Error si falla (reintentable)
 *   onFailed(job, err)                 // trabajo agotado → marcar nota en error
 * }
 * Devuelve { ok, final? }.
 */
export async function processJob(job, handlers) {
  // Heartbeat: sin él, una transcripción de 2 h excede JOB_STALE_MIN y otro
  // worker la reclamaría a mitad de proceso.
  const hb = setInterval(() => {
    heartbeatJob(job.id, WORKER_ID).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`tipo de trabajo desconocido: ${job.kind}`);
    await handler(job);
    await finishJob(job.id);
    return { ok: true };
  } catch (e) {
    const updated = await failJob(job.id, e?.message || String(e), WORKER_ID);
    const final = updated && updated.status === 'error';
    if (final && handlers.onFailed) {
      try {
        await handlers.onFailed(job, e);
      } catch { /* la nota pudo haberse borrado en el medio */ }
    }
    console.error(`[runner] job ${job.id} (${job.kind}) falló${final ? ' (agotado)' : ' (reintento programado)'}:`, e?.message || e);
    return { ok: false, final };
  } finally {
    clearInterval(hb);
  }
}

/**
 * Arranca el loop de la cola. concurrency: trabajos en paralelo por tipo
 * (transcribe=1 porque la VM tiene 2 OCPU y el worker procesa de a uno).
 * Retorna { stop } para tests/shutdown.
 */
export function startRunner(handlers, { pollMs = 2000, concurrency = { transcribe: 1, summarize: 1 } } = {}) {
  const kinds = Object.keys(concurrency);
  const inFlight = Object.fromEntries(kinds.map((k) => [k, 0]));

  const tick = async (kind) => {
    while (inFlight[kind] < concurrency[kind]) {
      let job;
      try {
        job = await claimJob(kind, WORKER_ID);
      } catch (e) {
        console.error(`[runner] claim ${kind} falló:`, e.message);
        return;
      }
      if (!job) return;
      inFlight[kind] += 1;
      processJob(job, handlers)
        .catch((e) => console.error(`[runner] job ${job.id} crasheó:`, e))
        .finally(() => { inFlight[kind] -= 1; });
    }
  };

  const timer = setInterval(() => {
    for (const kind of kinds) tick(kind);
  }, pollMs);
  timer.unref?.();
  for (const kind of kinds) tick(kind); // primer barrido sin esperar
  console.log(`[runner] cola activa (${kinds.join(', ')}) instancia=${WORKER_ID}`);
  return { stop: () => clearInterval(timer) };
}
