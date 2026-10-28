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

// Condensación jerárquica: agrupa partes consecutivas en lotes que entran
// en el presupuesto de cada llamada, y condensa lote a lote hasta que el
// material final entra en el máximo. Ninguna parte se descarta: a diferencia
// de un slice, la información del final de la clase se preserva.
export function groupPartsForMerge(parts, maxChars = 6000) {
  const groups = [];
  let current = '';
  for (const p of parts) {
    const piece = String(p ?? '');
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + 2 + piece.length <= maxChars) {
      current += `\n\n${piece}`;
    } else {
      groups.push(current);
      current = piece;
    }
  }
  if (current) groups.push(current);
  return groups;
}

export async function condenseToFit(parts, condense, maxChars, maxRounds = 4) {
  let current = parts.map((p) => String(p ?? ''));
  let material = current.join('\n\n');
  let round = 0;
  while (material.length > maxChars && round < maxRounds) {
    const groups = groupPartsForMerge(current, Math.floor(maxChars / 2));
    if (groups.length <= 1 && current.length <= 1) break;
    const condensed = [];
    for (let i = 0; i < groups.length; i++) {
      condensed.push(await condense(groups[i], i, groups.length));
    }
    current = condensed;
    material = current.join('\n\n');
    round += 1;
  }
  return { material, rounds: round };
}
