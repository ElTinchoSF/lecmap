# Gestor de usuarios admin (panel web)

Objeto: panel en lecmap.app para la cuenta admin de LecMap de crear y administrar
las cuentas beta (crear, cuota, borrar) sin tocar la DB a mano.
Rama: `feat/admin-user-manager` (base: `feat/beta-infra-oracle` — requiere la
columna `quota_seconds_per_day` de la migración 003, aún sin merge a main).
Estrategia de entrega: **pendiente** (forecast ~750-900 líneas autorizadas > 400:
pregunta de chain strategy abierta en Log L2).
Runner: backend `npm test` (node:test + Postgres Docker efímero);
web `npm run lint` + `npx tsc -b && npm run build`.

## Specs

Origen (beta-infra-oracle L12, verbatim): "gestor de usuarios, donde mi cuenta sea
administradora y pueda generar las 10 cuentas de prueba beta desde mi propia cuenta".
Decisiones de esta sesión: panel en **Web** (elegido por el usuario); Android queda
fuera de alcance.

**S1 — Gate admin (seguridad).** Todo endpoint `/admin/*` exige JWT válido (middleware
existente) Y `profiles.is_admin = true` en la DB operativa (VM local, leída por
`SELECT is_admin FROM profiles WHERE id = $1`). Sin fila o `false` → fail-closed.
Respuestas: 401 sin token / token inválido (ya existe), 403 `{ error }` para
no-admin, 503 `{ error: 'Servicio no configurado: falta SUPABASE_SERVICE_ROLE_KEY' }`
si falta la clave. El chequeo aplica igual en modo dev (sin jwks): `DEV_USER_ID`
necesita su fila `is_admin=true`. Mensajes de error en español (patrón existente).

**S2 — Listar usuarios.** `GET /admin/users` → 200 `{ users: [{ id, email, createdAt, isAdmin, quotaSeconds }] }`
ordenado `createdAt` desc. Fusión: usuarios de Supabase Admin API
(`GET {SUPABASE_URL}/auth/v1/admin/users?per_page=100&page=1`, headers
`apikey`/`Authorization` = service_role; respuesta `{ users: [...] }`) + campos
`isAdmin`/`quotaSeconds` de la DB local (fila ausente → `isAdmin:false`,
`quotaSeconds:null` = default 7200). Non-2xx de Supabase → 502
`{ error: 'No se pudo listar usuarios' }`.

**S3 — Crear usuario.** `POST /admin/users` body `{ email, password, quotaSeconds?: number|null }`
→ 201 `{ user: {...misma forma que S2} }`. Validación 400 `{ error }`: email con
formato inválido o password vacío. Crea en Supabase
(`POST {SUPABASE_URL}/auth/v1/admin/users` body `{ email, password, email_confirm: true }`
— confirmado para que el beta pueda loguearse sin SMTP) y luego upsert local
`INSERT INTO profiles (id, quota_seconds_per_day) VALUES ($1, $2) ON CONFLICT (id)
DO UPDATE SET quota_seconds_per_day = EXCLUDED.quota_seconds_per_day`
(`quotaSeconds` ausente → NULL). Supabase 422/409 → 409 con el `msg` de Supabase;
otros non-2xx → 502 `{ error: 'No se pudo crear el usuario' }`. Si falla el upsert
local tras crear en Supabase → 500 `{ error }` (usuario remoto queda creado;
reintentar con el mismo email ya no es posible — el 409 lo indica).

**S4 — Cambiar cuota.** `PATCH /admin/users/:id` body `{ quotaSeconds: number|null }`
→ 200 `{ user: {...} }` con el upsert local (NULL = volver al default 7200).
400 si `quotaSeconds` no es number|null; id no-uuid → 400. No toca Supabase.

**S5 — Borrar usuario.** `DELETE /admin/users/:id` → 200 `{ ok: true }`.
Orden: (1) remoto `DELETE {SUPABASE_URL}/auth/v1/admin/users/{id}` — 404 tolerado
("ya borrado"); (2) local: borrar `recordings` del usuario (segments y jobs caen
por FK CASCADE), después la fila de `profiles`. Auto-borrado → 400
`{ error: 'No podés borrar tu propia cuenta' }`. Si el paso 2 falla después del
remoto → 500 `{ error: 'Usuario borrado pero falló la limpieza local' }`.
Remoto non-2xx (distinto de 404) → 502 `{ error: 'No se pudo borrar el usuario' }`
sin tocar lo local.

**S6 — Panel web.** Componente nuevo `web/src/UsersAdmin.tsx`; App.tsx lo cablea.
Sondeo: con sesión activa, `GET /admin/users` con el Bearer existente → 200 ⇒
`isAdmin=true` y se muestra el botón "Usuarios" en el header (junto a Ajustes);
403/401/otro ⇒ oculto (silencioso). Panel: tabla (email, fecha de creación, cuota
editable inline con guardado, badge "admin"), formulario de creación
(email + contraseña + cuota opcional), borrado con confirmación. Errores de la API
se muestran con el patrón de banner/error existente en App.tsx. Estilo acorde a los
diálogos existentes (showLogout / namePrompt). Sin cambios en Android.

**S7 — Migración.** Archivo nuevo `backend/supabase/migrations/005_admin.sql`:
`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;`
(idempotente: en Supabase la columna ya existe desde 001). Aplicar en la VM
(`docker exec lecmap-db-1 psql`) + `UPDATE profiles SET is_admin = true WHERE id =
'29135fb8-c1a2-4ef6-950b-ad0019b35051'` (cuenta del usuario). Espejo en
`backend/test/helpers/pg.js` BASE_SCHEMA (columna `is_admin boolean NOT NULL DEFAULT false`).

**S8 — service_role (requisito externo).** Env `SUPABASE_SERVICE_ROLE_KEY` en
`/opt/lecmap/deploy/.env` de la VM; nunca en el repo, ni en el frontend, ni en
respuestas API. Keycloak del usuario: la pide el usuario en Supabase Dashboard →
Settings → API → `service_role`. `deploy/README.md` la agrega a la tabla de envs.
Lectura por request (patrón quota/llm) para que los tests puedan setearla/borrarla.

**S9 — Tests backend (RED→GREEN).** Suite nueva `backend/test/admin.test.js`
(misma infraestructura que api.test.js: JWKS local + JWT firmado + PG efímero +
stub HTTP local para `/auth/v1/admin/*`). Casos: 401 sin token; 403 no-admin
(fila `is_admin=false` y sin fila); 200 list (fusión stub+local, orden);
POST 201 (verifica upsert local), 400 validación, 409 email duplicado (stub 422),
503 sin clave; PATCH 200 con número y con null, 400 body inválido;
DELETE 200 (borra recordings+segments+profile locales, stub remoto),
400 self-delete, 502 remoto non-2xx, 404 remoto tolerado. El gate de S1 se
verifica en cada método (un caso no-admin por método basta además de los suyos).

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S7 | inline | ✅ hecho | migración `005_admin.sql` + espejo BASE_SCHEMA (`is_admin`); apply en VM (`ALTER` + `UPDATE` admin uid 29135fb8 → is_admin=true, verificado en SELECT); suite backend 90/90 verde con el espejo nuevo |
| T2 | S1, S2, S3, S4, S5, S9 | delegated (writer paralelo — trigger: unidades independientes con superficies disjuntas backend/ vs web/, cada una >100 líneas) | ✅ hecho | Commits `f987276` + corrección `b2871ca`: RED 404 → GREEN; **verifier independiente `fail` → 3 bloqueadores corregidos en un solo batch** (B1 guard self-delete case-sensitive → `toLowerCase()`; B2 PATCH aceptaba `quotaSeconds` ausente y reseteaba a NULL → 400 estricto; B3 `.trim()` alteraba la contraseña enviada a Supabase → sin trim, solo check de vacío) + 4 tests de regresión del verifier; RED verificado contra el código pre-fix (3/4 fail) → **116/116**. Advisories no bloqueantes: aserción de segments (ya agregada), botón "Usuarios" transitorio al cambiar de usuario (S6), sin ancla "Ajustes" en web |
| T3 | S6 | delegated (writer paralelo — misma evidencia que T2) | ✅ hecho | `web/src/UsersAdmin.tsx` (tabla con cuota inline, form creación, delete con confirmación, badge admin) + sonda `/admin/users` una-vez-por-sesión en App.tsx (silenciosa fuera de 200) + estilos App.css; verificación: lint OK (warnings preexistentes) + `tsc -b && vite build` OK; desviaciones: ninguna |
| T4 | S8 | inline | ⬜ pendiente | key en .env de VM + apply T1 + rebuild backend + E2E curl (requiere clave del usuario) |
| T5 | S8 | inline | ⬜ pendiente | docs (deploy/README.md) + seam check (suite backend + lint/tsc/build web) + cierre |

## Log

L1 (2026-11-14, usuario, verbatim): "perfecto, ahora sigamos con el producto" —
selección del usuario mediante pregunta: **"Gestor de usuarios (Recomendado)"**
(frente a T11 E2E y troceado Gemini) y **"Web (Recomendado)"** para la UI
(frente a Android o Web primero/Android después). Contexto: origen del feature en
beta-infra-oracle L12 (2026-11-10): "lo próximo que haremos es un gestor de
usuarios, donde mi cuenta sea administradora y pueda generar las 10 cuentas de
prueba beta desde mi propia cuenta".

L2 (2026-11-16, usuario, elección mediante pregunta): **"Single PR con commits por unidad (Recomendado)"** — el feature (~1250 líneas autorizadas) se entrega como un solo PR de `feat/admin-user-manager` sobre la base `feat/beta-infra-oracle` (24 commits sin merge; decisión de push/PR sigue siendo del usuario), con commits internos por unidad de trabajo. Estrategia registrada: `single-pr`.

L3 (2026-11-16, verificación): assess RDD nativo `risk: medium` (`executable_change`), `review_due: false` (`under_budget`) — en ambos cortes (pre y post corrección); sin ceremonia de review todavía. Verifier independiente `fail` con 3 bloqueadores (S5 guard uuid case-sensitive, S4 `quotaSeconds` ausente reseteaba cuota, S3 password con `.trim()`) → corrección acotada en un batch + recheck limitado (RED pre-fix 3/4 fail → 116/116). Risk del feature = **ítem 2** (gate de permisos + manejo de service_role).
