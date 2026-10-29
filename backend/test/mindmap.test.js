import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMindmap, mindmapSystemPrompt } from '../src/mindmap.js';

// --- Formato v2: mindmap.sections[] con layout propio por tema central ---

test('normalizeMindmap v2 normaliza cada sección con su propio layout', () => {
  const mm = {
    title: 'Clase de Física',
    sections: [
      {
        title: 'Cinemática',
        layout: 'topics',
        topics: [{
          title: 'Movimiento rectilíneo',
          branches: [{ label: 'Velocidad', detail: 'Derivada de la posición', points: ['v = dx/dt'] }],
        }],
      },
      {
        title: 'Método de Euler',
        layout: 'steps',
        steps: [
          { label: 'Paso 1', detail: 'Discretizar el intervalo', points: [] },
          { label: 'Paso 2', detail: 'Iterar la fórmula', points: [] },
        ],
      },
    ],
  };
  const out = normalizeMindmap(mm);
  assert.equal(out.title, 'Clase de Física');
  assert.equal(out.sections.length, 2);
  assert.equal(out.sections[0].layout, 'topics');
  assert.equal(out.sections[0].title, 'Cinemática');
  assert.equal(out.sections[0].topics.length, 1);
  assert.equal(out.sections[0].topics[0].branches[0].label, 'Velocidad');
  assert.equal(out.sections[1].layout, 'steps');
  assert.equal(out.sections[1].title, 'Método de Euler');
  assert.equal(out.sections[1].steps.length, 2);
});

test('normalizeMindmap v2 conserva el orden de las secciones', () => {
  const mm = {
    title: 'Clase',
    sections: [
      { title: 'B', layout: 'glossary', terms: [{ term: 'Termino', definition: 'Definición' }] },
      { title: 'A', layout: 'steps', steps: [{ label: 'Paso', points: [] }] },
    ],
  };
  const out = normalizeMindmap(mm);
  assert.deepEqual(out.sections.map((s) => s.title), ['B', 'A']);
});

test('normalizeMindmap v2 hace fallback de layout cuando la sección pide uno inválido', () => {
  const mm = {
    title: 'Clase',
    sections: [{
      title: 'Proceso',
      layout: 'timeline', // pedido inválido en realidad trae steps
      steps: [{ label: 'Preparar', points: [] }],
    }],
  };
  const out = normalizeMindmap(mm);
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0].layout, 'steps');
});

test('normalizeMindmap v2 descarta secciones sin datos válidos', () => {
  const mm = {
    title: 'Clase',
    sections: [
      { title: 'Vacía', layout: 'comparison', items: [], dimensions: [] },
      { title: 'Glosario', layout: 'glossary', terms: [{ term: 'A', definition: 'def a' }] },
    ],
  };
  const out = normalizeMindmap(mm);
  assert.equal(out.sections.length, 1);
  assert.equal(out.sections[0].layout, 'glossary');
});

test('normalizeMindmap v2 devuelve null si ninguna sección es válida', () => {
  const mm = { title: 'Clase', sections: [{ title: 'Nada', layout: 'steps', steps: [] }] };
  assert.equal(normalizeMindmap(mm), null);
});

// --- Compat: formato viejo single-layout (notas existentes y modelo que no aplica v2) ---

test('normalizeMindmap acepta el formato viejo single-layout', () => {
  const mm = {
    title: 'Comparación de teorías',
    layout: 'comparison',
    dimensions: ['Definición', 'Autor'],
    items: [{ name: 'Teoría A', values: ['x', 'y'] }],
  };
  const out = normalizeMindmap(mm);
  assert.equal(out.layout, 'comparison');
  assert.equal(out.title, 'Comparación de teorías');
  assert.equal(out.items.length, 1);
  assert.equal(out.sections, undefined);
});

test('normalizeMindmap formato viejo con branches cae a topics', () => {
  const mm = {
    title: 'Clase',
    branches: [{ label: 'Tema 1', points: ['p1'] }, { label: 'Tema 2', points: [] }],
  };
  const out = normalizeMindmap(mm);
  assert.equal(out.layout, 'topics');
  assert.equal(out.topics[0].branches.length, 2);
});

test('normalizeMindmap devuelve null para entrada vacía', () => {
  assert.equal(normalizeMindmap(null), null);
  assert.equal(normalizeMindmap({}), null);
});

// --- Prompt v2 ---

test('mindmapSystemPrompt pide secciones con layout propio por tema', () => {
  const p = mindmapSystemPrompt('general');
  // El layout vive dentro de cada sección, no como campo único del mindmap.
  assert.match(p, /"sections":\s*\[\{"title": string, "layout"/);
  assert.match(p, /tema central/i);
});

test('mindmapSystemPrompt ya no pide el summary (sale en call dedicado)', () => {
  const p = mindmapSystemPrompt('general');
  assert.ok(!/"summary"/.test(p), 'el schema del mindmap no debe incluir summary');
  assert.ok(!/El summary debe ser/.test(p), 'el objetivo de frases vive en summarySystemPrompt');
});

test('mindmapSystemPrompt refuerza la fragmentación por tema central', () => {
  const p = mindmapSystemPrompt('general');
  assert.match(p, /dos temas centrales/);
  assert.match(p, /secciones acotadas|partil[oa] en varias/i);
});

test('mindmapSystemPrompt etiqueta ejemplos y arma Trabajos y consignas', () => {
  const p = mindmapSystemPrompt('general');
  assert.match(p, /Ejemplo:/);
  assert.match(p, /Trabajos y consignas/);
  assert.match(p, /fecha límite/i);
});
