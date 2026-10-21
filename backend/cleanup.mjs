import { DatabaseSync } from 'node:sqlite';
import {
  readdirSync,
  statSync,
  unlinkSync,
  mkdirSync,
  renameSync,
  existsSync,
} from 'fs';
import path from 'path';

const uploads = path.resolve('uploads');
const samples = path.resolve('samples');

// Audios de demostración generados con TTS: no son grabaciones de usuarios.
const fixtures = new Set([
  'trafico_urbano.wav',
  'cambio_climatico.wav',
  'estadistica_definiciones.wav',
  'historia_computacion.wav',
  'comportamiento_organizacional.wav',
  'calculo_vectorial.wav',
  'teorema_green.wav',
]);

const db = new DatabaseSync(path.join('data', 'notas.db'));
const rows = db.prepare('SELECT audio_path FROM recordings').all();
const referenced = new Set(
  rows.map((r) => (r.audio_path ? path.basename(r.audio_path) : null)).filter(Boolean)
);

mkdirSync(samples, { recursive: true });

let kept = 0;
let moved = 0;
let removed = 0;
let freed = 0;

if (existsSync(uploads)) {
  for (const name of readdirSync(uploads).sort()) {
    const file = path.join(uploads, name);
    if (!statSync(file).isFile()) continue;

    if (referenced.has(name)) {
      kept++;
      continue;
    }

    const sample = path.join(samples, name);
    if (fixtures.has(name) && !existsSync(sample)) {
      renameSync(file, sample);
      moved++;
      continue;
    }

    try {
      freed += statSync(file).size;
      unlinkSync(file);
      removed++;
    } catch (e) {
      console.warn(`No se pudo eliminar ${name}: ${e.message}`);
    }
  }
}

console.log(`En uso, conservados: ${kept}`);
console.log(`Fixtures movidos a samples/: ${moved}`);
console.log(`Huérfanos eliminados: ${removed} (${(freed / 1024 / 1024).toFixed(1)} MB)`);
