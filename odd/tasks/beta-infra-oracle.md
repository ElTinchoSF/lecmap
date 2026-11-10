# Beta infra Oracle — límites holgados para 10 usuarios × 2 h/día

Objetivo: que LecMap soporte una beta de 10 usuarios con 2 horas de grabación por usuario por día, gratis y sin que la app "se muera antes de arrancar"; speakers reales en la transcripción; bugs críticos del relevamiento corregidos.
Rama: `feat/beta-infra-oracle` · Estrategia de entrega: commits por unidad de trabajo · Prueba: backend `npm run dev` (:3001) + probes con curl, `npm test`, web `npx tsc --noEmit` + `vite build`, worker Python con su `pytest`, VM Oracle vía `oci` + SSH.
Forecast de líneas autorizadas: ~1500 (additions + deletions, incluye worker Python nuevo y migración de backend). Ruta por tarea: inline salvo donde se indique delegated (trigger: unidades paralelas con superficies disjuntas).

## Specs

S1 — Beta de 10 usuarios con 2 h de grabación por usuario por día.
Fuente verbatim (L1, 29/10): "Lo que me gustaría es abrir 10 cupos sin problemas con 2 horas de grabación por usuario por día."
Fuente verbatim (19/10 contexto): "la idea es que la puedan utilizar los alumnos de universidades y escuelas para poder organizar sus clases."
Aceptación: con 10 usuarios activos, cada uno puede subir y analizar hasta 2 h (7200 s) de audio por día calendario sin recibir error de cuota; el exceso recibe error 429/403 claro con mensaje de cuota. La cuota se persiste en DB y sobrevive reinicios. El STT no depende de cuotas de Groq free (8 h audio/día): el worker propio de Oracle no tiene ese techo.

S2 — Alternativa 100% gratuita que funcione bien.
Fuente verbatim (29/10): "necesito que sea una alternativa gratuita pero que funcione bien, no puede hacer cualquier cosa la app."
Fuente verbatim (29/10): "Por mí movamos todo y mantenemos todo en el mismo lugar, no?"
Aceptación: todo el cómputo (backend Node, worker STT/diarización, Postgres, Caddy/HTTPS) corre en una sola VM ARM; Supabase se conserva solo para Auth. No hay dependencia de cuotas free de Groq ni de Gemini para el STT. **Plan B activado (L11): VM Hetzner `CAX11` (2 vCPU/4 GB, Ampere, Falkenstein) a US$7.59/mo en lugar de Oracle Always Free** — la meta "$0/mes" queda reemplazada por costo fijo bajo, registrado en L11. Documentado en README el stack, el costo y cómo se llega al mínimo.

S3 — Speakers reales en la transcripción (no `SPEAKER_00/01` por paridad de índice).
Fuente verbatim (29/10): "los 'speakers' que aparecen en la transcripción de las notas son aleatorios y coincido con eso."
Fuente verbatim (29/10): "Necesito que me recomiendes algo, pero debe ser real, no me sirve que siempre diga 'docente' porque cuando hay una pregunta de algún alumno no sería fiable."
Aceptación: cada segmento de la transcripción lleva un label de hablante derivado de diarización real sobre el audio (paquete `diarize`, Apache-2.0, CPU-only). En una clase con docente + alumno que pregunta, el turno del alumno queda etiquetado como hablante distinto. El label `speaker` sigue en el contrato API (`Segment.speaker`), pero su valor ya no es `i % 2`. Se permite renombrar hablantes desde la UI (web y Android) y el renombrado se persiste por nota sin alterar la diarización original.

S4 — Worker de transcripción propio en Oracle (STT sin techo de Groq).
Fuente verbatim (29/10): "no puede hacer cualquier cosa la app" / decisión de mover todo a Oracle.
Aceptación: servicio Python en la VM Oracle que expone una API interna de transcripción (audio in → segments con speaker real out) usando faster-whisper (modelo `small`) + `diarize`. El backend encola transcripciones en DB (202 + polling) en vez de llamar a Groq de forma síncrona. No existe límite de 25 MB por archivo: el pipeline acepta archivos de 2 h (con compresión a 16 kHz mono en el cliente). Sin límite de horas de audio por día del lado del proveedor.

S5 — LLM de resumen/mapa/ApIA en Gemini free.
Fuente verbatim (29/10): "alternativa gratuita pero que funcione bien."
Aceptación: el backend habla con un adaptador de proveedor LLM con al menos `gemini` (free tier) y `groq` (fallback por config). Resumen, mapa de ideas y ApIA funcionan contra Gemini Flash free. El pacer global `TPM_BUDGET = 7000` de Groq ya no es el techo del sistema (se elimina o se hace por-proveedor).

S6 — Corrección de los bugs críticos del relevamiento.
Fuente verbatim (29/10): "Realiza un análisis detallado del proyecto y releva estos detalles."
Aceptación (cada punto debe tener prueba):
a) `cleanupOrphanAudio()` no borra archivos referenciados por notas: la query de referencia lista TODOS los `audio_path` (sin filtro `user_id = NULL`). Test: crear nota con audio → correr cleanup → el archivo sigue.
b) Auth fail-open: con `NODE_ENV=production` y `SUPABASE_URL` vacía el proceso NO arranca (error claro); en dev sigue comportándose como hoy.
c) CORS acepta `PATCH` (preflight del renombrar web).
d) `GET /files/:name` valida ownership (404 para audio de otra cuenta).
e) Upload valida tamaño/tipo de audio con mensaje claro (rechaza > límite del pipeline con 413/400 en vez de fallar después).

S7 — Cuotas y cola robustas (multiusuario real).
Aceptación: la cuota de S1 se chequea en servidor (no solo UI); los jobs de resumen/transcripción viven en DB (no en el `Set` en memoria), sobreviven reinicios y no se pisan entre instancias; `resetInterrupted` solo toca jobs de la instancia que arranca. Rate limiting básico por usuario en los endpoints de IA (transcribe/summarize/ask).

S8 — Fuera de esta ronda (quedan para post-beta): organización de clases con materias/tags (Fase 5) y migración del flujo de YouTube.
Fuente verbatim (29/10): "Fase 5 — Organización de clases (post-beta)".
Aceptación: no se implementa en esta feature; queda registrado en ## Log.

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S6a | inline | ✅ hecho | commit `8188f32`: RED reproducido (audio referenciado borrado, ENOENT) → GREEN 39/39 con Postgres Docker efímero; `cleanup.js` extraído, `closePool()` agregado |
| T2 | S6b, S6c, S6d, S6e | inline | ✅ hecho | commit `c370d78`: 8 tests API nuevos (JWKS local + JWT ES256 firmado); RED verificado rompiendo cada fix por separado (CORS, fail-open, ownership, validación); 48/48 backend; tsc+vite OK; compileDebugKotlin OK |
| T3 | S2 | inline | ✅ hecho (plan B) | Oracle agotado (~66 intentos sin capacidad A1, tope 1 región `TenantCapacityExceeded` #772); plan B Hetzner activado por el usuario (L11): VM `CAX11` 2.31.197.193 creada 10/11, Docker 29.9.3 instalado |
| T4 | S4 | inline | ✅ hecho | commit `dc4706b`: worker Python completo + 11 tests locales; **deployado en la VM Hetzner 10/11**: imagen `lecmap-worker` (arm64) build OK, `/health` 200 desde el backend, auth 401 sin token / 400 con token verificada en red compose |
| T5 | S4, S7 | inline | ✅ hecho | commit `b7da6dc`: jobs table (migración 002), runner con SKIP LOCKED+heartbeat, transcribe 202+cola con fallback Groq honesto, clientes poll (web 90 min / Android); 6 tests cola; 54/54 backend, tsc+vite OK, compileDebugKotlin OK |
| T6 | S5 | inline | ✅ hecho | commit `2deea2e`: adaptador `llm.js` (gemini free sin pacer / groq con TPM_BUDGET 7000 preservado), auto-detección por env, endpoints y /health actualizados; 9 tests RED→GREEN; 63/63 backend |
| T7 | S1, S7 | delegated (gentle-ai-worker) | ✅ hecho | commits `1ace095` + corrección `cb46907`: migración 003 (duration_seconds + profiles.quota_seconds_per_day), quota.js (ffprobe async→cliente→bytes con guard de spoof, QUOTA_TZ, exclude en re-upload, withQuotaLock), ratelimit.js (sliding window por usuario), 429 con used/quota/remaining, clientes mandan duration; RED doble verificado; 76/72 backend (63 baseline preservados), tsc+vite OK, compileDebugKotlin OK; fix colateral aprobado: DEV_USER_ID uuid reemplaza a 'dev-user'; **RDD cerrado: `approved` + authority burned** (lineage review-8b9f1570b153f021, 3 lenses, refuter corroboró R1-001/R4-1/R4-2 → corrección acotada 200/200 líneas, validator admitió; 10 advisory findings no bloqueantes) |
| T8 | S3 | inline | ✅ hecho | commit `05511f6`: `displaySpeakers()` agrupa IDs crudos del worker (S0/S1) → "Hablante N" por primera aparición (sin paridad i%2, sin fugas de IDs crudos); guards de rol en prompts summary/CHUNK/MERGE/mindmap ("labels arbitrarios, no roles"); fix preexistente: transcribeHandler usaba `r.userId` (undefined — toRecording no lo expone) y ready/duration/audioPath matcheaban 0 filas → ahora `job.user_id`; test end-to-end con worker stub (grupos no alternantes 1,1,2,2); 79/79 backend; RDD assess `under_budget` (sin review) |
| T9 | S3 | inline | ✅ hecho | commit `2c3d2bc`: migración 004 `speaker_labels` jsonb (overlay {original→visible}; `segments.speaker` intacto = diarización original sin alterar), `PATCH /recordings/:id/speakers` {from,to} con revert por `to` vacío y 400 por label desconocido/duplicado, overlay aplicado al leer (prompts/exports ven nombres reales), web con edición inline (Enter/Esc), Android con diálogo + `renameSpeaker` en el VM; 2 tests nuevos (persistencia sin tocar segments + revert/aislamiento/400s); 81/81 backend, tsc+vite OK, compileDebugKotlin OK |
| T10 | S2 | inline | 🔄 en curso | **10/11**: `deploy/` (docker-compose: db+backend+worker+caddy, Caddyfile, README) + fixes RED→GREEN (SSL `DATABASE_SSL=disable` en `db.js` con test `dbssl.test.js`; worker `HOST=0.0.0.0` con test `bind_host`) — 84/84 backend, 12/12 worker; stack **arriba y sano** en la VM (4 contenedores, `/health` `stt:worker` `auth:supabase`); esquema BASE_SCHEMA+migraciones 002-004 aplicado (001 es Supabase-only, salteada). **RDD cerrado: `approved` + authority burned** (lineage `review-8e03545db674bbb1`, 4/4 lentes admitidos tras varios reintentos por finish=length; refuter refutó el único CRITICAL R2-002 — 31 advisory no bloqueantes, R1-001 SSL cleartext en compose y R3-*/R4-* de concurrencia en `renameSpeaker` entre ellos). **Pendiente**: ~~DNS~~ ✓ (cert LE emitido, E2E 200), ~~key LLM~~ ✓ (Gemini key en `.env`, `LLM_MODEL=gemini-3.8-flash` — 2.5 deprecado para cuentas nuevas; 503 Google transitorio), ~~decisión de datos~~ ✓ (**DB nueva en cero**, decisión del usuario 10/11 — sin pg_dump de Render), app Android actualizada en el dispositivo (APK debug instalado vía adb wireless, `server_url=https://api.lecmap.app/` verificado). Falta E2E funcional T11 |
| T11 | S1, S2 | inline | ⬜ pendiente | E2E beta: 10 usuarios sintéticos × 2 h, cuota y cola verificadas |

## Log

L1 (2026-10-29, usuario, verbatim): "quiero que analicemos el tema de los límites de groq, ya que no podemos ni siquiera hacer una pruba beta con esa infraestructura. Necesito que la app no tenga una limitación tan baja, la idea es que la puedan utilizar los alumnos de universidades y escuelas para poder organizar sus clases. Cómo podemos hacer para tener límites más holgados, al menos para poder hacer alguna prueba beta de unos 10 a 20 usuarios y que no se muera la app antes de arrancar?"

L2 (2026-10-29, usuario, verbatim): "lamentablemente necesito que sea una alternativa gratuita pero que funcione bien, no puede hacer cualquier cosa la app. Hay posibilidades? o es inviable?"

L3 (2026-10-29, usuario, verbatim): "Creo que es mejor tener una beta de 10 usuarios con una cuota de uso de 2 horas por día, ya que una clase de universidad al menos dura esas 2 horas, que dices? estamos muy al borde?"

L4 (2026-10-29, usuario, verbatim): "la app como está ya no es viable, sólo serviría si la uso yo para mis clases y eso implica que sólo la testearía yo. Lo que me gustaría es abrir 10 cupos sin problemas con 2 horas de grabación por usuario por día. Podemos armar un plan para cumplir con esas condiciones? Por otro lado, hay que cubrir algunas otras cosas que son de sistema y no de análisis de los LLM, en un análisis detallado que hiciste en algún momento me mencionaste que los 'speakers' que aparecen en la transcripción de las notas son aleatorios y coincido con eso, ahora que la app está un poco más desarrollada, podemos ver ese tipo de detalles? Realiza un análisis detallado del proyecto y releva estos detalles. Pregunta todo lo que necesites para arrancar"

L5 (2026-10-29, usuario, decisiones a las 4 preguntas del plan, verbatim): "1. Necesito que me recomiendes algo, pero debe ser real, no me sirve que siempre diga 'docente' porque cuando hay una pregunta de algún alumno no sería fiable. 2. Ya tenemos cuenta en Oracle Cloud! revisa en la carpeta 'StudyDev/ArSoftME' 3. Dime qué conviene a nivel desarrollo? 4. Por mí movamos todo y mantenemos todo en el mismo lugar, no?"

L6 (2026-10-29, usuario, verbatim): "el plan me parece perfecto. Antes de implementarlo vamos a configurar CLI de oracle así podés tener acceso a lo que necesites, dime cómo hacerlo"

L7 (2026-10-29, cierre de infraestructura de acceso): OCI CLI 3.95.1 instalado y autenticado (region sa-santiago-1, tenancy/OCIDs en ~/.oci/config, fingerprint e8:37:21:32:4c:29:1f:c3:51:b1:3c:11:17:77:4e:02). Hallazgo clave: ArSoftME corre en `VM.Standard.E2.1.Micro` (x86), por lo que el cupo Always Free de ARM (4 OCPU/24 GB, `VM.Standard.A1.Flex`) está entero para LecMap. Plan de fases aprobado por el usuario ("el plan me parece perfecto" + "arranca!").

L8 (2026-10-29, usuario, verbatim): "arranca!" — autorización para iniciar la implementación (creación de VM + fases del plan).

L9 (2026-10-30, usuario, verbatim): "dale! y actualiza el ToDo list que sigue mostrando 'RDD T7' como no terminado" — confirma: 5 intentos de Oracle mañana a la mañana + contingencia VPS/Hetzner preparada en paralelo.

L10 (2026-10-30, usuario, verbatim): "vamos a darle una oportunidad más a oracle, deja Hetzner como plan B y ya todo listo para mañana" — decisión: última tanda de intentos A1 en home region (31/10 ~08:30, shape 1 OCPU/6 GB); Hetzner (~US$5/mes, ~2 vCPU/4 GB, preferentemente US Ashburn por latencia) queda como plan B activable si Oracle no cede. Si se activa Hetzner, implica revisar S2 ("alternativa 100% gratuita") — el costo queda registrado aquí.

L11 (2026-11-01, usuario, verbatim): "voy a cerrar y reiniciar sesión guarda todo esto en memoria y cuando vuelva continuamos con el Pipeline que queda desplegando en Hetzner" — **activación del plan B**: desplegar el pipeline (T10+T4) en Hetzner al volver. 10/11: el usuario creó la instancia y autorizó explícitamente SSH ("si, autorizo" a root@2.31.197.193 con clave `~/.ssh/oracle_lecmap` para instalar Docker y desplegar el pipeline). Instancia real: `CAX11` (2 vCPU Ampere / 4 GB / 40 GB SSD), Falkenstein, Ubuntu 24.04, **US$7.59/mo** (server $6.99 + IPv4 $0.60) — revisión de S2 registrada: la meta $0/mes queda como costo fijo bajo.

Contexto de análisis (2026-10-29): relevamiento completo del proyecto (backend, frontends, docs). Speakers = `SPEAKER_${i % 2}` en `backend/src/index.js:420` (paridad de índice, sin diarización). Bugs críticos: `cleanupOrphanAudio()` borra todo `uploads/` (query con `user_id=NULL`), auth fail-open sin SUPABASE_URL, `/files/:name` público, CORS sin PATCH, 200 MB multipart vs 512 MB de Render, límite 25 MB de Groq sin validar (2 h a 32 kbps ≈ 28 MB lo excede), jobs en memoria, sin cuotas. Límites Groq free: 8K TPM, 1000 req/día, 8 h audio/día Whisper — insuficiente para 10×2 h. Decisión: STT+diarización propios en Oracle ARM con faster-whisper+`diarize`, LLM en Gemini free, backend migrado de Render a la misma VM.
