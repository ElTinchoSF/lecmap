// Duración de la transcripción y longitud objetivo del resumen de estudio.
//
// Escala 0.6 frases/minuto (densidad pedida por el usuario tras el primer
// deploy: 0.4 resultó demasiado escueto para clases de ~70 min): una clase
// de 72 min apunta a ~43 frases ≈ 600-700 palabras; una de 2h toca el techo
// de 70. Piso 6 frases para clases cortas; el techo 70 ≈ 1000 palabras
// entra holgado en SUMMARY_MAX_TOKENS (2500).

export function targetSummarySentences(minutes) {
  const m = Number(minutes);
  const safe = Number.isFinite(m) && m > 0 ? m : 0;
  return Math.min(70, Math.max(6, Math.round(safe * 0.6)));
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

// Prompt del call final de resumen. Vive separado del prompt del mindmap para
// que el resumen tenga su propio maxTokens y no compita con el JSON del mapa
// de ideas (un mapa multi-sección se come los tokens de salida del call único).
export function summarySystemPrompt(targetSentences) {
  return 'Eres un experto que escribe resúmenes de estudio en español a partir del material de una clase. '
    + 'Respondé SOLO con el texto del resumen: sin JSON, sin encabezados, sin preámbulo y sin comillas alrededor. '
    + 'El resumen debe tener aproximadamente ' + targetSentences
    + ' frases; priorizá cubrir todas las ideas principales antes que acortar. '
    + 'No repitas ideas y no inventes contenido ausente.';
}

// Tolerante a cualquier formato de salida: texto plano (lo pedido), JSON con
// campo summary, o JSON dentro de fences markdown. El resumen es prosa — no
// debe depender del modo JSON del proveedor (Groq 400 "Failed to generate
// JSON" con gpt-oss-120b truncaba el call y dejaba el JSON sin cerrar).
export function extractSummaryText(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const brace = unfenced.match(/\{[\s\S]*\}/);
  try {
    const obj = JSON.parse(brace ? brace[0] : unfenced);
    if (typeof obj?.summary === 'string' && obj.summary.trim()) return obj.summary.trim();
  } catch { /* no es JSON: el unfenced es el resumen */ }
  return unfenced;
}
