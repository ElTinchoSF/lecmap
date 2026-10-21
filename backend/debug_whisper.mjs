import { readFile } from 'fs/promises';
import 'dotenv/config';

const key = process.env.OPENAI_API_KEY || '';
console.log('Key prefix:', key.slice(0, 8) + '...');

const fileBuffer = await readFile('samples/teorema_green.wav');
console.log('WAV bytes:', fileBuffer.length);

const form = new FormData();
form.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), 'teorema_green.wav');
form.append('model', 'whisper-large-v3');
form.append('response_format', 'verbose_json');
form.append('timestamp_granularities[]', 'segment');

const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}` },
  body: form,
});
const text = await res.text();
console.log('Status:', res.status);
console.log('Response:', text.slice(0, 800));
