import { test } from 'node:test';
import assert from 'node:assert/strict';
import { targetSummarySentences, transcriptDurationSeconds } from '../src/summary.js';

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
