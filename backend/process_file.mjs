import { readFile } from 'fs/promises';
import path from 'path';

const file = process.argv[2] || 'samples/teorema_green.wav';
const title = process.argv[3] || path.basename(file);
const API = 'http://localhost:3001';

const buf = await readFile(file);
const form = new FormData();
form.append('audio', new Blob([buf], { type: 'audio/wav' }), path.basename(file));
form.append('title', title);

const rec = await (await fetch(`${API}/recordings`, { method: 'POST', body: form })).json();
console.log('CREATED:', rec.id, '-', rec.title);

const t = await (await fetch(`${API}/recordings/${rec.id}/transcribe`, { method: 'POST' })).json();
console.log('TRANSCRIPT:', t.transcript.map((s) => s.text).join(' '));

const s = await (await fetch(`${API}/recordings/${rec.id}/summarize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ template: 'class' }),
})).json();

console.log('SUMMARY:', s.summary);
console.log('MINDMAP:', JSON.stringify(s.mindmap, null, 2));
