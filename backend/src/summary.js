// Duración de la transcripción y longitud objetivo del resumen de estudio.
//
// Escala 0.4 frases/minuto: una clase de 2h (~16-19k palabras habladas a
// ~150 palabras/min) apunta a ~48 frases ≈ 700-800 palabras, es decir
// ~4-5% de compresión — dentro del rango habitual de un resumen de
// estudio (3-10%). Piso 6 frases para clases cortas, techo 70 para no
// descontrolar la salida (maxTokens del call final).

export function targetSummarySentences(minutes) {
  const m = Number(minutes);
  const safe = Number.isFinite(m) && m > 0 ? m : 0;
  return Math.min(70, Math.max(6, Math.round(safe * 0.4)));
}

export function transcriptDurationSeconds(segments) {
  let max = 0;
  for (const s of segments || []) {
    const end = Number(s?.end);
    if (Number.isFinite(end) && end > max) max = end;
  }
  return max;
}
