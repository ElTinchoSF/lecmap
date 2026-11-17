-- 003: cuota de audio diaria por usuario (T7 — specs S1 y S7).
--
-- duration_seconds: duración medida del audio (cliente / ffprobe / whisper).
-- Es lo que se suma contra la cuota del día en backend/src/quota.js.
ALTER TABLE public.recordings ADD COLUMN IF NOT EXISTS duration_seconds integer;

-- Cuota por usuario. NULL (o sin fila) = usa el default global del entorno
-- (QUOTA_AUDIO_SECONDS_PER_DAY, 7200 s = 2 h por usuario por día, S1).
-- Un valor = override del usuario: los tiers pro se habilitan solo seteando
-- esta columna, sin tocar código ni deploy.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS quota_seconds_per_day integer;
