import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetSummarySentences,
  transcriptDurationSeconds,
  groupPartsForMerge,
  condenseToFit,
  summarySystemPrompt,
  extractSummaryText,
  CHUNK_SYSTEM_PROMPT,
  MERGE_SYSTEM_PROMPT,
} from '../src/summary.js';

test('targetSummarySentences aplica el piso de 6 frases', () => {
  assert.equal(targetSummarySentences(0), 6);
  assert.equal(targetSummarySentences(9), 6); // 9 × 0.6 = 5.4 → piso
});

test('targetSummarySentences escala linealmente en el rango medio', () => {
  assert.equal(targetSummarySentences(45), 27); // 45 × 0.6 = 27
  assert.equal(targetSummarySentences(72), 43); // clase real de 71.8 min ≈ 43 frases
});

test('targetSummarySentences aplica el techo de 70 frases', () => {
  assert.equal(targetSummarySentences(117), 70); // 117 × 0.6 = 70.2 → techo
  assert.equal(targetSummarySentences(300), 70); // techo
});

test('targetSummarySentences tolera entradas sucias', () => {
  assert.equal(targetSummarySentences(NaN), 6);
  assert.equal(targetSummarySentences(-5), 6);
  assert.equal(targetSummarySentences('90'), 54); // 90 × 0.6 = 54
});

test('transcriptDurationSeconds toma el end más grande', () => {
  const segs = [
    { start: 0, end: 12.5, text: 'hola' },
    { start: 12.5, end: 5400.25, text: 'clase larga' },
    { start: 5400.25, end: 900, text: 'segmento desordenado' },
  ];
  assert.equal(transcriptDurationSeconds(segs), 5400.25);
});

test('transcriptDurationSeconds devuelve 0 sin segmentos válidos', () => {
  assert.equal(transcriptDurationSeconds([]), 0);
  assert.equal(transcriptDurationSeconds(null), 0);
  assert.equal(transcriptDurationSeconds([{ start: 0 }, { end: 'x' }]), 0);
});

test('groupPartsForMerge respeta el máximo por lote', () => {
  const parts = ['A'.repeat(400), 'B'.repeat(400), 'C'.repeat(400)];
  const groups = groupPartsForMerge(parts, 1000);
  assert.equal(groups.length, 2);
  assert.equal(groups[0], `${'A'.repeat(400)}\n\n${'B'.repeat(400)}`);
  assert.equal(groups[1], 'C'.repeat(400));
});

test('groupPartsForMerge deja en su lote a una parte indivisible más grande que el máximo', () => {
  const parts = ['X'.repeat(1500), 'Y'.repeat(10)];
  const groups = groupPartsForMerge(parts, 1000);
  assert.equal(groups.length, 2);
  assert.ok(groups[0].startsWith('X'));
  assert.ok(groups[1].startsWith('Y'));
});

test('condenseToFit no itera si el material ya entra en el máximo', async () => {
  let calls = 0;
  const condense = async (t) => { calls += 1; return t; };
  const { material, rounds } = await condenseToFit(['hola'], condense, 1000);
  assert.equal(rounds, 0);
  assert.equal(calls, 0);
  assert.equal(material, 'hola');
});

test('condenseToFit condensa lotes hasta entrar en el máximo', async () => {
  let calls = 0;
  const condense = async () => { calls += 1; return 'c'; };
  const parts = Array.from({ length: 6 }, () => 'x'.repeat(400));
  const { material, rounds } = await condenseToFit(parts, condense, 10);
  assert.ok(rounds >= 1);
  assert.ok(calls > 0);
  assert.ok(material.length <= 10 || rounds === 4);
});

test('condenseToFit conserva el orden de las partes condensadas', async () => {
  // El fake imita al LLM real: produce un texto más corto pero estable
  // (idempotente), como haría una condensación de verdad.
  const condense = async (text) => (text.startsWith('[') ? text : `[${text.slice(0, 1)}]`);
  const parts = ['aaa', 'bbb', 'ccc', 'ddd'];
  const { material } = await condenseToFit(parts, condense, 5);
  assert.equal(material, '[a]\n\n[b]\n\n[c]\n\n[d]');
});

// --- Prompt del resumen (call dedicado, separado del mindmap) ---

test('summarySystemPrompt pide el objetivo de frases escalonado', () => {
  const p = summarySystemPrompt(48);
  assert.match(p, /aproximadamente 48\s+frases/);
});

test('summarySystemPrompt pide texto plano, sin JSON', () => {
  const p = summarySystemPrompt(24);
  assert.ok(!/"summary"/.test(p), 'sin schema JSON — el resumen sale como texto plano');
  assert.ok(!/sections|layout|topics/i.test(p), 'sin referencias al schema del mindmap');
  assert.match(p, /sin JSON|texto puro|sin encabezados/i);
});

test('summarySystemPrompt prioriza cubrir todas las ideas', () => {
  const p = summarySystemPrompt(30);
  assert.match(p, /ideas principales/i);
});

// --- Extracción del resumen de la salida del LLM ---

test('extractSummaryText usa texto plano tal cual', () => {
  assert.equal(extractSummaryText('Un resumen de estudio. Segunda frase.'),
    'Un resumen de estudio. Segunda frase.');
});

test('extractSummaryText rescata el campo summary si viene en JSON', () => {
  assert.equal(extractSummaryText('{"summary": "Viene envuelto en JSON."}'),
    'Viene envuelto en JSON.');
});

test('extractSummaryText rescata JSON dentro de fences markdown', () => {
  assert.equal(extractSummaryText('```json\n{"summary": "Con fence."}\n```'),
    'Con fence.');
});

test('extractSummaryText recorta fences de texto plano', () => {
  assert.equal(extractSummaryText('```\nTexto con fence.\n```'),
    'Texto con fence.');
});

// --- Consignas del docente: ejemplos, tareas y fechas límite ---

test('summarySystemPrompt pide incluir tareas y fechas límite', () => {
  const p = summarySystemPrompt(30);
  assert.match(p, /fecha límite/i);
  assert.match(p, /tarea|tareas/i);
});

test('CHUNK_SYSTEM_PROMPT marca ejemplos y tareas con fecha', () => {
  assert.match(CHUNK_SYSTEM_PROMPT, /Ejemplo:/);
  assert.match(CHUNK_SYSTEM_PROMPT, /Tarea:/);
  assert.match(CHUNK_SYSTEM_PROMPT, /fecha límite/i);
});

test('MERGE_SYSTEM_PROMPT preserva marcadores de ejemplo y tarea', () => {
  assert.match(MERGE_SYSTEM_PROMPT, /Ejemplo:/);
  assert.match(MERGE_SYSTEM_PROMPT, /Tarea:/);
  assert.match(MERGE_SYSTEM_PROMPT, /fechas límite|fecha límite/i);
});
