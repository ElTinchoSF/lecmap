// Gestor de usuarios admin (S1–S5). Rutas bajo /admin/* protegidas por JWT
// (middleware existente en index.js) + gate de admin local + service_role.
import { pool } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function isValidEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

function supabaseAdminHeaders(key) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function requireAdmin(req, reply) {
  if (req.method === 'OPTIONS') return;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!key) {
    return reply.code(503).send({ error: 'Servicio no configurado: falta SUPABASE_SERVICE_ROLE_KEY' });
  }
  const { rows } = await pool.query('SELECT is_admin FROM profiles WHERE id = $1', [req.userId]);
  if (!rows[0]?.is_admin) {
    return reply.code(403).send({ error: 'Acceso restringido al panel de administración' });
  }
}

function toAdminUser(supabaseUser, profileRow) {
  return {
    id: supabaseUser.id,
    email: supabaseUser.email || null,
    createdAt: supabaseUser.created_at || null,
    isAdmin: !!(profileRow?.is_admin),
    quotaSeconds: profileRow?.quota_seconds_per_day ?? null,
  };
}

function toAdminUserLocal(id, profileRow) {
  return {
    id,
    email: null,
    createdAt: null,
    isAdmin: !!(profileRow?.is_admin),
    quotaSeconds: profileRow?.quota_seconds_per_day ?? null,
  };
}

export async function registerAdminRoutes(app, { supabaseUrl }) {
  app.register(async (adminApp) => {
    adminApp.addHook('preHandler', requireAdmin);

    adminApp.get('/users', async (req, reply) => {
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      let res;
      try {
        res = await fetch(
          `${supabaseUrl}/auth/v1/admin/users?per_page=100&page=1`,
          { headers: supabaseAdminHeaders(key) },
        );
      } catch (e) {
        return reply.code(502).send({ error: 'No se pudo listar usuarios' });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: 'No se pudo listar usuarios' });
      }
      const data = await res.json();
      const users = Array.isArray(data?.users) ? data.users : [];

      const ids = users.map((u) => u.id).filter(isUuid);
      let profileMap = new Map();
      if (ids.length) {
        const { rows } = await pool.query(
          'SELECT id, is_admin, quota_seconds_per_day FROM profiles WHERE id = ANY($1::uuid[])',
          [ids],
        );
        for (const r of rows) profileMap.set(r.id, r);
      }

      const merged = users
        .map((u) => toAdminUser(u, profileMap.get(u.id)))
        .sort((a, b) => {
          const da = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const db_ = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return db_ - da;
        });

      return { users: merged };
    });

    adminApp.post('/users', async (req, reply) => {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
      // La contraseña NO se recorta: trim alteraría la credencial que Supabase
      // almacena (el admin cree una contraseña y se guarda otra distinta).
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!isValidEmail(email)) {
        return reply.code(400).send({ error: 'Email inválido' });
      }
      if (!password.trim()) {
        return reply.code(400).send({ error: 'La contraseña es requerida' });
      }

      const quotaSeconds = req.body?.quotaSeconds;
      if (quotaSeconds !== undefined && quotaSeconds !== null && !Number.isFinite(quotaSeconds)) {
        return reply.code(400).send({ error: 'quotaSeconds debe ser un número o null' });
      }
      const quotaValue = quotaSeconds === undefined ? null : quotaSeconds;

      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      let res;
      try {
        res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: 'POST',
          headers: supabaseAdminHeaders(key),
          body: JSON.stringify({ email, password, email_confirm: true }),
        });
      } catch (e) {
        return reply.code(502).send({ error: 'No se pudo crear el usuario' });
      }

      if (res.status === 422 || res.status === 409) {
        const body = await res.json().catch(() => ({}));
        const msg = body.msg || body.message || body.error || 'El usuario ya existe';
        return reply.code(409).send({ error: msg });
      }
      if (!res.ok) {
        return reply.code(502).send({ error: 'No se pudo crear el usuario' });
      }

      const data = await res.json().catch(() => ({}));
      const remoteUser = data.user || data;
      if (!remoteUser?.id) {
        return reply.code(502).send({ error: 'No se pudo crear el usuario' });
      }

      try {
        await pool.query(
          `INSERT INTO profiles (id, quota_seconds_per_day)
           VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET quota_seconds_per_day = EXCLUDED.quota_seconds_per_day`,
          [remoteUser.id, quotaValue],
        );
      } catch (e) {
        return reply.code(500).send({ error: e.message });
      }

      const { rows } = await pool.query('SELECT * FROM profiles WHERE id = $1', [remoteUser.id]);
      reply.code(201);
      return { user: toAdminUser(remoteUser, rows[0]) };
    });

    adminApp.patch('/users/:id', async (req, reply) => {
      const id = req.params.id;
      if (!isUuid(id)) {
        return reply.code(400).send({ error: 'ID de usuario inválido' });
      }
      const quotaSeconds = req.body?.quotaSeconds;
      // S4: el campo es obligatorio y debe ser number|null explícito —
      // undefined (body vacío o sin clave) no puede resetear la cuota a NULL.
      if (quotaSeconds === undefined || (quotaSeconds !== null && !Number.isFinite(quotaSeconds))) {
        return reply.code(400).send({ error: 'quotaSeconds debe ser un número o null' });
      }

      await pool.query(
        `INSERT INTO profiles (id, quota_seconds_per_day)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET quota_seconds_per_day = EXCLUDED.quota_seconds_per_day`,
        [id, quotaSeconds],
      );

      const { rows } = await pool.query('SELECT * FROM profiles WHERE id = $1', [id]);
      return { user: toAdminUserLocal(id, rows[0]) };
    });

    adminApp.delete('/users/:id', async (req, reply) => {
      const id = req.params.id;
      if (!isUuid(id)) {
        return reply.code(400).send({ error: 'ID de usuario inválido' });
      }
      // UUID case-insensitive (Postgres lo es; la comparación de strings no):
      // sin toLowerCase el guard se saltea con el uuid en mayúsculas.
      if (id.toLowerCase() === String(req.userId).toLowerCase()) {
        return reply.code(400).send({ error: 'No podés borrar tu propia cuenta' });
      }

      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      let res;
      try {
        res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${id}`, {
          method: 'DELETE',
          headers: supabaseAdminHeaders(key),
        });
      } catch (e) {
        return reply.code(502).send({ error: 'No se pudo borrar el usuario' });
      }

      if (res.status !== 404 && !res.ok) {
        return reply.code(502).send({ error: 'No se pudo borrar el usuario' });
      }

      try {
        await pool.query('DELETE FROM recordings WHERE user_id = $1', [id]);
        await pool.query('DELETE FROM profiles WHERE id = $1', [id]);
      } catch (e) {
        return reply.code(500).send({ error: 'Usuario borrado pero falló la limpieza local' });
      }

      return { ok: true };
    });
  }, { prefix: '/admin' });
}
