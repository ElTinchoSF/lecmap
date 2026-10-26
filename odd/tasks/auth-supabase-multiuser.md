# Auth + Multiusuario con Supabase

Objetivo: cada usuario tiene su cuenta (email+password o Google OAuth), sus datos están aislados por `user_id`, y la cuenta del usuario es admin para un futuro panel estadístico. Audio queda solo en el dispositivo que lo capturó.
Rama: `feat/auth-supabase` · Estrategia: commits por unidad de trabajo · Prueba: backend con Supabase Postgres, web con login, Android con login.
Forecast: ~800 líneas (additions + deletions). Ruta: **inline** (unidades secuenciales en cada superficie).

## Specs

S1 — Supabase: schema con profiles, recordings.user_id, RLS.
Fuente verbatim (decisión del usuario): "yo quiero que cada persona tenga su cuenta personal y que lo que genera desde la web o la app estén sincronizadas, teniendo en cuenta las cuestiones de diseño que establecen que el audio queda sólo en el dispositivo que lo capturó" y "necesito que mi cuenta sea de administrador para mas adelante poder armar un panel estadístico".
Aceptación: tabla `profiles` vinculada a `auth.users` con `is_admin boolean`; `recordings` tiene `user_id uuid REFERENCES auth.users(id)`; RLS habilitado en `recordings` y `segments` con policy `user_id = auth.uid()`; el schema corre sin errores en Supabase SQL editor.

S2 — Backend: auth con Supabase JWT + aislamiento por usuario.
Fuente verbatim: "si en un futuro se tienen más de 50k usuarios, podemos escalar el proyecto? hay que tenerlo en cuenta nada más".
Aceptación: el middleware actual de `API_TOKEN` se reemplaza por validación de Supabase JWT (verificación de firma con `SUPABASE_JWT_SECRET`); todas las funciones de `db.js` aceptan y filtran por `userId`; `GET /recordings` solo devuelve las grabaciones del usuario autenticado; `GET /recordings/:id` devuelve 404 si la grabación no pertenece al usuario; `POST /recordings` asigna `user_id` del JWT; `DELETE /recordings/:id` verifica pertenencia; las rutas públicas siguen siendo `/health` y `/files/:name`; sin JWT válido → 401.

S3 — Web: login/registro Supabase + JWT en todos los requests.
Fuente verbatim: "necesito que mi cuenta sea de administrador".
Aceptación: pantalla de login con email+password y botón "Continuar con Google"; al autenticarse, el access token de Supabase se envía como `Authorization: Bearer` en todos los `apiFetch`; al expirar el token se refresca automáticamente (`supabase.auth.getSession()`); 401 del backend redirige a login; logout limpia la sesión; el flujo de grabar→analizar→resumen funciona autenticado.

S4 — Android: login/registro Supabase + JWT en requests.
Fuente verbatim: "lo que genera desde la web o la app estén sincronizadas".
Aceptación: pantalla de login con email+password y Google; el access token se envía como `Authorization: Bearer` en todas las llamadas Retrofit; token persistido en SharedPreferences; al recibir 401, la app muestra login; logout limpia todo; las notas creadas en un dispositivo aparecen en el otro (mismo usuario).

S5 — Escalabilidad contemplada (sin implementar).
Fuente verbatim: "si en un futuro se tienen más de 50k usuarios, podemos escalar el proyecto? hay que tenerlo en cuenta nada más".
Aceptación: documentado en el feature doc que la arquitectura (Supabase Postgres + backend stateless con JWT) escala horizontalmente; Supabase free tier cubre 50k usuarios, para más se puede upgrade o migrar a Postgres managed; el backend no guarda estado en memoria (los `summaryJobs` in-memory deben migrarse a DB o Supabase).

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S1 | inline | ✅ hecho | Migration corrida en Supabase Dashboard ("Lecmap query"): profiles, recordings.user_id, segments, RLS ✅ |
| T2 | S2 | inline | ✅ hecho | commits `b74f920` + `142fec2`: JWT ES256 via JWKS (no HS256), userId en todas las queries, SQLite→Postgres, 401 sin token, 200 con JWT válido |
| T3 | S3 | inline | ✅ hecho | commit `4f779c4`: useAuth hook, LoginScreen, Google OAuth, auto-attach JWT, web/.env.local configurado |
| T4 | S4 | inline | ✅ hecho | commit `2489d05`: SupabaseAuth REST client, LoginScreen, auth gate, token persistence |
| T5 | S5 | inline | ✅ hecho | Escalabilidad documentada en Log L4 |

## Log

L1 (2026-10-26, usuario, verbatim): "yo quiero que cada persona tenga su cuenta personal y que lo que genera desde la web o la app estén sincronizadas, necesito que sea así, teniendo en cuenta las cuestiones de diseño que establecen que el audio queda sólo en el dispositivo que lo capturó"

L2 (2026-10-26, usuario, verbatim): "1. Es la máquina de mi trabajo, pero lo que quiero es que no depende de una máquina u otra. Necesitamos en servidor en linea gratuito ... 2. Me gustaría que tenga ambos métodos de Login, es posible? 3. Exacto, todo menos el audio."

L3 (2026-10-26, usuario, verbatim): "implementemos esto primero y tené en cuenta que necesito que mi cuenta sea de administrador para mas adelante poder armar un panel estadístico. Por otro lado, si en un futuro se tienen más de 50k usuarios, podemos escalar el proyecto? hay que tenerlo en cuenta nada más"

L4 (2026-10-26, escalabilidad): Supabase free tier cubre 50k MAU. Para escalar más: upgrade Supabase Pro ($25/mes, 100k MAU) o migrar a Postgres managed (Neon, Railway). El backend es stateless (JWT validation, sin sesión en memoria) → escala horizontal con múltiples instancias. Deuda conocida: `summaryJobs` es un Set in-memory, perdido en crash; migrar a tabla en DB o Redis cuando sea necesario.

L5 (2026-10-26, implementación completa): T1–T5 ✅. Hallazgos: (1) Supabase free tier firma JWTs con ES256, no HS256 → verificar vía JWKS con `jose`; (2) conexión directa a Postgres es IPv6-only, usar Session pooler (`aws-1-us-west-2.pooler.supabase.com:5432`); (3) DNS local no resuelve pooler → fallback a 8.8.8.8/1.1.1.1; (4) cuenta admin creada: `galantimartin@gmail.com` con `is_admin=true`. Verificado: 401 sin token, 200 con JWT válido, recording creado con user_id correcto, RLS activo.
