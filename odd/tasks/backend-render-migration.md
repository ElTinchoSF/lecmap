# Backend a hosting gratuito sin tarjeta (Render)

Objetivo: restaurar `api.lecmap.app` en un hosting con tier gratuito que **no pida tarjeta**, después de que Fly.io suspendiera las VMs por trial vencido (HTTP 525).
Rama: `main` · Estrategia: commits por unidad de trabajo · Prueba: `GET /health` 200 + E2E web y Android.
Forecast: ~150 líneas (casi todo config y DNS, poco código). Ruta: **inline** (unidad secuenciales, sin dependencias paralelas).

## Specs

S1 — Backend sirviendo en tier gratuito sin card wall.
Fuente verbatim (decisión del usuario): "desde el inicio quedamos en que no hay presupuesto, hay que optar por herramientas gratuitas al menos al principio, ten siempre en cuenta esto, no tenemos financiamiento disponible."
Aceptación: el servicio de hosting se registra **sin tarjeta de crédito**; el backend (Dockerfile existente) corre allí; `https://api.lecmap.app/health` devuelve 200 con JSON; ninguna VM/instancia queda suspendida por falta de pago.

S2 — DNS `api.lecmap.app` apuntando al nuevo origen.
Fuente verbatim: "Necesitamos en servidor en linea gratuito ... lo que quiero es que no depende de una máquina u otra."
Aceptación: `api.lecmap.app` resuelve al host del nuevo hosting; TLS válido — sin error 525/526. Registro en modo **DNS only** (sin proxy de Cloudflare): Render debe ver el CNAME para verificar el dominio y emitir su certificado Let's Encrypt, y con el proxy naranja Cloudflare devuelve solo sus propias IPs. El "host crudo" expuesto es la IP compartida de Render (`*.origin.onrender.com`), no una máquina propia, y Render ya frontea su origen con Cloudflare — el motivo original del proxy no aplica.

S3 — Verificación end-to-end en producción.
Aceptación: en `lecmap.app`, login → grabar → analizar → transcripción → resumen → mindmap → "Preguntar a ApIA" sin errores; en Android, login con la misma cuenta y la lista muestra las mismas notas del servidor; sin banner de error rojo en ninguna de las dos superficies.

S4 — Sin regresión en el flujo de audio durante la migración.
Aceptación: el flujo actual se mantiene sin cambios — el cliente sube el audio, el backend lo guarda en `uploads/`, lo manda a Groq y **lo borra apenas termina la transcripción** (`index.js:608`, `audioPath = null`); el disco efímero del nuevo hosting es aceptable *precisamente* porque el archivo solo vive entre la subida y la transcripción. Documentado en el Log por qué no hace falta disco persistente.

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S1 | inline | ✅ hecho | Usuario logueado en Render con GitHub `ElTinchoSF`; API key en `backend/.render-key` (gitignored) |
| T2 | S1 | inline | ✅ hecho | Servicio `lecmap-api` (`srv-dbgah4fb9u1s73co1cn0`) creado por API: plan `free`, región `oregon`, runtime `docker`, root `backend/`, 7 env vars. Deploy `dep-dbgah4vb9u1s73co1e2g` → `live` en 36 s. `GET /health` 200 (`auth: supabase`, `whisper-large-v3`, `gpt-oss-120b`); `/recordings` sin token → 401 |
| T3 | S2 | inline | ✅ hecho | CNAME `api` → `lecmap-api.onrender.com` (DNS only, hecho por el usuario). Dominio custom `cdm-dbgam0ijnfac73fooic0` → `verified` vía `POST .../verify`. `GET https://api.lecmap.app/health` → 200, `ssl_verify=0`, HTTP/2 |
| T4 | S3 | inline | ✅ hecho | Web: bundle de producción apunta a `https://api.lecmap.app`, sesión activa, `Clase de Fotosíntesis` visible sin banner de error. Android: login vía skill `lecmap-android-login`, `Clase de Fotosíntesis` + `ready` cargadas, sin HTTP 525 |
| T5 | S4 | inline | ✅ hecho | E2E por API: crear nota → subir m4a (211 KB) → `POST /transcribe` 200 en 1.09 s → `status: ready`, `audioPath: null` (borrado tras transcribir), transcript correcto. Nota de prueba eliminada |

## Log

L1 (2026-10-27, usuario, verbatim): "desde el inicio quedamos en que no hay presupuesto, hay que optar por herramientas gratuitas al menos al principio, ten siempre en cuenta esto, no tenemos financiamiento disponible. Propón una solución que cumpla con lo ya establecido."

L2 (2026-10-27, usuario, verbatim): "Con respecto al punto 2, si tenemos almacenamiento en supabase y el audio no queda guardado en el servidor, no es posible hacer que se suba a supabase, desde ahí se analice y luego se borre como ya está haciendo? Dime lo que es mejor"

L3 (2026-10-27, diagnóstico del 525): `fly status` → "trial has ended, please add a credit card by visiting https://fly.io/trial". `curl https://lecmap-api.fly.dev/health` → TCP conecta pero el TLS handshake falla (`SSL_ERROR_SYSCALL`); `curl https://api.lecmap.app/health` → 525. Cloudflare está bien: el origen estaba caído. Fly.io queda descartado mientras no haya presupuesto.

L4 (2026-10-27, candidatos evaluados, sin tarjeta como requisito duro): **Render Hobby free → elegido** (512 MB RAM, 0.1 CPU, 750 instance-hours/mes, spin-down a los 15 min con cold start ~1 min, 5 GB de bandwidth, 500 build minutes, custom domain + TLS, requests HTTP de hasta 100 min — suficiente para transcribir, **no pide tarjeta**). Descartados: Koyeb (pide tarjeta desde feb 2026), Hugging Face Spaces (crear Docker/Gradio Space requiere PRO desde 2026), Railway ($5 de crédito + método de pago), Oracle/Cloud Run/AWS (siempre tarjeta), Fly.io (free allowances terminaron en oct 2024). Supabase free sigue siendo la base de datos: 500 MB DB, 1 GB file storage, 5 GB egress, 50k MAU, **pausa a los 7 días de inactividad**.

L5 (2026-10-27, seguimiento pendiente sobre L2 — NO es spec todavía): Groq acepta `url` además de `file` en `/audio/transcriptions` (docs oficiales: "Either a file or a URL must be provided"), así que el backend *podría* nunca guardar el audio: el cliente sube a Supabase Storage, el backend pasa una URL firmada a Groq y borra el objeto. Beneficios: desaparece la ventana donde un restart pierde el audio, el deja de transportar bytes de audio (libera los 5 GB de Render) y se borra código (`uploads/`, `removeAudioFile`, `cleanupOrphanAudio`, `GET /files/:name`). Pendiente de decisión del usuario: además, como el servidor ya borró su copia tras transcribir, **"Liberar audio" en Android hoy borra la última copia que existe** — conservar el objeto en Supabase (1 GB gratis ≈ 400 audios de 10 min) arreglaría eso. Costo: refactor cruzado en Android + web + backend + RLS. Va como tarea aparte, después de restaurar el servicio.

L6 (2026-10-27, ejecución completa — T1–T5 ✅): Servicio creado por API de Render (`POST /v1/services`) en lugar del dashboard para automatizar las env vars sin pegar secretos a mano. `ownerId` obtenido de `GET /v1/owners` (`tea-dbga6oo473hc73atrk7g`, "My Workspace"). Región **Oregon** elegida porque Supabase está en `us-west-2`: misma región = menor latencia a la base. `PORT` **no** se setea: Render inyecta 10000 y la app ya lee `process.env.PORT` (`index.js:877`), setearlo a mano rompería el routing.

Hallazgos: (1) **S2 enmendado** — el proxy de Cloudflare quedó en modo DNS only. Render necesita ver el CNAME para verificar el dominio y emitir el certificado; con el naranja devuelve solo IPs propias. Además el "host crudo" que se expone es la IP compartida de Render, no una máquina propia, y Render ya frontea su origen con Cloudflare (`*.origin.onrender.com.cdn.cloudflare.net`), por lo que el motivo original del proxy no aplica. (2) El header `server: cloudflare` en las respuestas viene de la capa propia de Render, no de la zona del usuario. (3) `backend/fly.toml` eliminado: describía una app suspendida. (4) El README describía todavía el túnel `cloudflared` hacia `127.0.0.1:3001` y el backend en SQLite — ambos obsoletos desde la migración a Supabase/Render; corregidos. (5) Nueva skill de proyecto `skills/lecmap-android-login` para el login en el dispositivo: al enfocar un campo se abre Gboard y el layout sube ~440px, lo que hacía fallar los taps con bounds viejos; el procedimiento confiable es dump → tap → dump → Ctrl+A → type. Credenciales en `.credentials` (gitignored, 600), nunca dentro del `SKILL.md`.

Deuda abierta (sigue pendiente de decisión, ver L5): migrar el audio a Supabase Storage y pasarle a Groq una URL firmada en vez de subirlo por el backend.
