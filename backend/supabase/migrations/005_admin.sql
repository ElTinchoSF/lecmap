-- 005: rol admin en profiles (S7 de odd/tasks/admin-user-manager.md).
--
-- En Supabase la columna ya existe desde 001_auth_multiuser.sql (la crea el
-- trigger handle_new_user con default false); este ALTER es idempotente y
-- cubre la DB operativa de la VM, donde profiles solo tenía
-- (id, quota_seconds_per_day) y el backend lee el rol para el gate /admin/*.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
