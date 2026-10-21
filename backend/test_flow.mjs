import { readFile } from 'fs/promises';

const f = await readFile('samples/teorema_green.wav');
const form = new FormData();
form.append('audio', new Blob([f], { type: 'audio/wav' }), 'teorema_green.wav');
form.append('title', 'Teorema de Green');

const r = await fetch('http://localhost:3001/recordings', { method: 'POST', body: form });
const rec = await r.json();
console.log('CREATED:', JSON.stringify(rec));

// Transcribir
await fetch(`http://localhost:3001/recordings/${rec.id}/transcribe`, { method: 'POST' });
const t = await (await fetch(`http://localhost:3001/recordings/${rec.id}`)).json();
console.log('TRANSCRIPT:', JSON.stringify(t.transcript, null, 2));

// Resumir
const s = await (await fetch(`http://localhost:3001/recordings/${rec.id}/summarize`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ template: 'class' })
})).json();
console.log('SUMMARY:', s.summary);
console.log('MINDMAP:', JSON.stringify(s.mindmap));

// Preguntar
const a = await (await fetch(`http://localhost:3001/recordings/${rec.id}/ask`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: '¿Qué dice el teorema de Green?' })
})).json();
console.log('ANSWER:', a.answer);
