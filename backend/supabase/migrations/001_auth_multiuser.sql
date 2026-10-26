-- Auth + Multiusuario para Lecmap
-- Ejecutar en Supabase SQL Editor (Dashboard → SQL → New query)

-- 1. Tabla de perfiles vinculada a auth.users
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Auto-crear perfil al registrar usuario
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Recordings con user_id
-- Primero crear la tabla si no existe (o alterar la existente)
create table if not exists public.recordings (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  status text not null default 'queued',
  error text,
  audio_path text,
  youtube_url text,
  summary text,
  mindmap jsonb,
  created_at timestamptz not null default now()
);

-- Si la tabla ya existía sin user_id, agregarlo
-- (Supabase ignora esto si la columna ya existe)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'recordings' and column_name = 'user_id'
  ) then
    alter table public.recordings add column user_id uuid references auth.users(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_recordings_user ON recordings(user_id, created_at DESC);

-- 3. Segments vinculados a recordings
create table if not exists public.segments (
  recording_id text not null references recordings(id) on delete cascade,
  idx integer not null,
  start double precision not null,
  "end" double precision not null,
  speaker text not null,
  text text not null,
  primary key (recording_id, idx)
);

-- 4. Row Level Security
alter table public.profiles enable row level security;
alter table public.recordings enable row level security;
alter table public.segments enable row level security;

-- Profiles: cada usuario ve/edita solo el suyo
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Admin puede ver todos los profiles (para panel estadístico)
create policy "profiles_select_admin"
  on public.profiles for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Recordings: cada usuario solo ve los suyos
create policy "recordings_select_own"
  on public.recordings for select
  using (auth.uid() = user_id);

create policy "recordings_insert_own"
  on public.recordings for insert
  with check (auth.uid() = user_id);

create policy "recordings_update_own"
  on public.recordings for update
  using (auth.uid() = user_id);

create policy "recordings_delete_own"
  on public.recordings for delete
  using (auth.uid() = user_id);

-- Admin puede ver todos los recordings (para panel estadístico)
create policy "recordings_select_admin"
  on public.recordings for select
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Segments: hereda acceso via recordings
create policy "segments_select_own"
  on public.segments for select
  using (
    exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

create policy "segments_insert_own"
  on public.segments for insert
  with check (
    exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );

create policy "segments_delete_own"
  on public.segments for delete
  using (
    exists (
      select 1 from public.recordings r
      where r.id = recording_id and r.user_id = auth.uid()
    )
  );
