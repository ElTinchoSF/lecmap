import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  targetSummarySentences,
  transcriptDurationSeconds,
  groupPartsForMerge,
  condenseToFit,
} from '../src/summary.js';

test('targetSummarySentences aplica el piso de 6 frases', () => {
  assert.equal(targetSummarySentences(0), 6);
  assert.equal(targetSummarySentences(10), 6); // 10 × 0.4 = 4 → piso
});

test('targetSummarySentences escala linealmente en el rango medio', () => {
  assert.equal(targetSummarySentences(45), 18); // 45 × 0.4 = 18
  assert.equal(targetSummarySentences(120), 48); // 2h → 48 frases ≈ 700-800 palabras
});

test('targetSummarySentences aplica el techo de 70 frases', () => {
  assert.equal(targetSummarySentences(175), 70); // 175 × 0.4 = 70 exacto
  assert.equal(targetSummarySentences(300), 70); // techo
});

test('targetSummarySentences tolera entradas sucias', () => {
  assert.equal(targetSummarySentences(NaN), 6);
  assert.equal(targetSummarySentences(-5), 6);
  assert.equal(targetSummarySentences('90'), 36);
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
