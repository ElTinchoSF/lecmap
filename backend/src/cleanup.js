import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { listAudioPaths } from './db.js';

// UPLOADS_DIR permite apuntar a un volumen montado (Oracle) o a un scratch
// temporal en tests, sin tocar el código.
export const defaultUploadsDir = () => path.resolve(process.env.UPLOADS_DIR || 'uploads');

/**
 * Borra el audio de una grabación. Solo acepta rutas dentro de uploads/ y
 * reintenta por si Windows lo tiene bloqueado un instante (streaming).
 */
export async function removeAudioFile(audioPath, log, uploadsDir = defaultUploadsDir()) {
  if (!audioPath) return;
  const resolved = path.resolve(audioPath);
  if (resolved !== uploadsDir && !resolved.startsWith(uploadsDir + path.sep)) {
    log?.warn({ file: resolved }, 'audio fuera de uploads; no se borra');
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await unlink(resolved);
      return;
    } catch (e) {
      if (e.code === 'ENOENT') return;
      if (attempt === 3) {
        log?.warn({ err: e }, 'no se pudo borrar el audio');
        return;
      }
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

/**
 * Borra archivos de uploads/ que ninguna fila de recordings referencia. Esto
 * cubre audios que quedaron huérfanos porque Windows bloqueó el borrado, o
 * porque una subida se cortó antes de crear la nota.
 */
export async function cleanupOrphanAudio(log, uploadsDir = defaultUploadsDir()) {
  let files;
  try {
    files = await readdir(uploadsDir);
  } catch {
    return;
  }
  const referenced = new Set((await listAudioPaths()).map((p) => path.resolve(p)));
  let removed = 0;
  for (const name of files) {
    const fp = path.join(uploadsDir, name);
    if (referenced.has(path.resolve(fp))) continue;
    try {
      const info = await stat(fp);
      if (!info.isFile()) continue;
    } catch {
      continue;
    }
    await removeAudioFile(fp, log, uploadsDir);
    removed += 1;
  }
  if (removed > 0) log?.info({ removed }, 'audios huérfanos eliminados');
  return removed;
}
