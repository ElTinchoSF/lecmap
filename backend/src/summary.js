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
    + 'Si el material incluye tareas o consignas, incluilo en el resumen con su fecha límite. '
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

// Extracción por bloques en TEXTO PLANO — el modo JSON de Groq con
// gpt-oss-120b devolvía 400 "Failed to generate JSON" en los chunks y los
// retries no alcanzaban. Los marcadores "Ejemplo:" y "Tarea:" (con fecha
// límite si el docente la menciona) sobreviven la condensación y el mindmap.
export const CHUNK_SYSTEM_PROMPT =
  'Sos un asistente que resume clases en español. Respondé SOLO con texto en esta forma exacta, '
  + 'sin JSON y sin encabezados extra:\n'
  + 'Resumen: dos o tres frases con las ideas principales del fragmento.\n'
  + '- una idea concreta por línea, hasta 6 ideas (datos, definiciones, ejemplos, conclusiones).\n'
  + 'No inventes contenido que no esté en el texto. '
  + 'Marcá los ejemplos que da el docente empezando la idea con "Ejemplo:" y las tareas o '
  + 'consignas con "Tarea:" incluyendo la fecha límite si la menciona.';

// Parsea la salida del bloque: viñetas (-, *, •, 1.) = points; el resto
// (incluida la línea "Resumen:") = summary. Tolera fences markdown y salida
// truncada (las líneas incompletas que no empiezan con viñeta van al summary).
export function parseChunkText(raw) {
  const text = String(raw || '')
    .replace(/^```(?:text)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const points = [];
  const summaryLines = [];
  for (const line of lines) {
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      if (points.length < 8) points.push(bullet[1].trim());
    } else if (/^resumen:/i.test(line)) {
      summaryLines.push(line.replace(/^resumen:\s*/i, ''));
    } else {
      summaryLines.push(line);
    }
  }
  const summary = summaryLines.join(' ').trim();
  if (!summary && points.length === 0) {
    throw new Error('La IA no devolvió contenido legible para el bloque');
  }
  return { summary, points: points.filter(Boolean) };
}

// Condensación jerárquica: debe preservar los marcadores de consignas.
export const MERGE_SYSTEM_PROMPT =
  'Sos un asistente que condensa resúmenes de fragmentos de una clase. Reescribí un texto compacto '
  + 'en español que conserve TODOS los hechos, definiciones, fórmulas, ejemplos, nombres, tareas, '
  + 'fechas límite y conclusiones de los fragmentos —incluidos los puntos que empiezan con '
  + '"Ejemplo:" y "Tarea:"—, sin inventar nada y sin repetirte. '
  + 'Sin encabezados ni preámbulo: sólo el contenido condensado.';
