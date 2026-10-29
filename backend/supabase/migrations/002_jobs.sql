-- 002: cola de trabajos persistente (transcripción y resumen).
-- Antes vivía en un Set en memoria: un reinicio perdía los trabajos y
-- resetInterrupted() marcaba error a TODOS los usuarios.
create table if not exists jobs (
  id text PRIMARY KEY,
  recording_id text NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  kind text NOT NULL,               -- 'transcribe' | 'summarize'
  params jsonb,                     -- p.ej. { "template": "class" }
  status text NOT NULL DEFAULT 'queued', -- queued | running | done | error
  error text,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,                   -- instancia que lo tomó (hostname:pid)
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Un solo trabajo activo por nota+tipo (dedupe al encolar).
create unique index if not exists idx_jobs_active
  ON jobs (recording_id, kind)
  WHERE status IN ('queued', 'running');

create index if not exists idx_jobs_claim ON jobs (kind, status, available_at);
