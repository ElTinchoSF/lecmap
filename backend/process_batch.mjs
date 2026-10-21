import { readFile } from 'fs/promises';
import path from 'path';

const API = 'http://localhost:3001';

const cases = [
  ['samples/historia_computacion.wav', 'Historia de la computacion'],
  ['samples/estadistica_definiciones.wav', 'Estadistica descriptiva: definiciones'],
  ['samples/cambio_climatico.wav', 'Causas y consecuencias del cambio climatico'],
  ['samples/trafico_urbano.wav', 'Problemas y soluciones del trafico urbano'],
];

for (const [file, title] of cases) {
  const buf = await readFile(file);
  const form = new FormData();
  form.append('audio', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
  form.append('title', title);

  const rec = await (await fetch(`${API}/recordings`, { method: 'POST', body: form })).json();
  await fetch(`${API}/recordings/${rec.id}/transcribe`, { method: 'POST' });
  const s = await (await fetch(`${API}/recordings/${rec.id}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: 'class' }),
  })).json();

  const mm = s.mindmap || {};
  const counts = {
    topics: mm.topics?.length || 0,
    items: mm.items?.length || 0,
    steps: mm.steps?.length || 0,
    events: mm.events?.length || 0,
    terms: mm.terms?.length || 0,
    causes: mm.causes?.length || 0,
    problems: mm.problems?.length || 0,
  };
  console.log(`--- ${title}`);
  console.log(`    id=${rec.id} layout=${mm.layout} ${JSON.stringify(counts)}`);
  console.log(`    title="${mm.title}"`);
}
