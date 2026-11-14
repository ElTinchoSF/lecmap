// Fetch global de Node (undici interno) corta a los 300 s esperando
// cabeceras de respuesta (headersTimeout por defecto) y lo envuelve en
// "fetch failed", aunque el AbortSignal de la llamada pida más tiempo. El
// pipeline del worker tarda 15-30 min en responder, así que subimos ese tope
// con un Agent propio; el límite real de cada llamada sigue siendo su
// AbortSignal.timeout (que acá nunca llegaba a dispararse).
//
// IMPORTANTE: el Agent, el fetch y el FormData tienen que venir del MISMO
// paquete undici (no los globales de Node): mezclar instancias rompe con
// "invalid onRequestStart method" o envía el FormData como text/plain (el
// worker responde 400 "falta el campo audio"). El Blob global sí sirve:
// undici.FormData lo envuelve en su File interno al agregarlo.
import { Agent, fetch, FormData } from 'undici';

const CAP_MS = Number(process.env.WORKER_TIMEOUT_MS || 10_800_000);

export const upstreamAgent = new Agent({
  headersTimeout: CAP_MS,
  bodyTimeout: CAP_MS,
});

export const upstreamFetch = fetch;
export { FormData };
