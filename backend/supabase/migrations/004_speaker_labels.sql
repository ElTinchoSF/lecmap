-- 004: renombrar hablantes por nota (T9 — spec S3).
--
-- speaker_labels: mapa {label original → nombre visible} en JSONB.
-- El renombre vive SOLO acá: segments.speaker conserva la diarización
-- original sin alterarla; el overlay se aplica al leer (toRecording).
ALTER TABLE public.recordings ADD COLUMN IF NOT EXISTS speaker_labels jsonb;
