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
Aceptación: `api.lecmap.app` resuelve al host del nuevo hosting; TLS válido — sin error 525/526; el proxy de Cloudflare sigue activo (no exponer el host crudo como única vía).

S3 — Verificación end-to-end en producción.
Aceptación: en `lecmap.app`, login → grabar → analizar → transcripción → resumen → mindmap → "Preguntar a ApIA" sin errores; en Android, login con la misma cuenta y la lista muestra las mismas notas del servidor; sin banner de error rojo en ninguna de las dos superficies.

S4 — Sin regresión en el flujo de audio durante la migración.
Aceptación: el flujo actual se mantiene sin cambios — el cliente sube el audio, el backend lo guarda en `uploads/`, lo manda a Groq y **lo borra apenas termina la transcripción** (`index.js:608`, `audioPath = null`); el disco efímero del nuevo hosting es aceptable *precisamente* porque el archivo solo vive entre la subida y la transcripción. Documentado en el Log por qué no hace falta disco persistente.

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S1 | inline | ⬜ pendiente | Registro del usuario en Render (OAuth con GitHub `ElTinchoSF`) — no lo puede hacer el agente |
| T2 | S1 | inline | ⬜ pendiente | Deploy del backend (Dockerfile existente) como Web Service en Render |
| T3 | S2 | inline | ⬜ pendiente | DNS `api.lecmap.app` → nuevo origen + verificación TLS |
| T4 | S3 | inline | ⬜ pendiente | E2E web (Chrome CDP) + Android (adb) contra producción |
| T5 | S4 | inline | ⬜ pendiente | Confirmar que subir→transcribir→borrar sigue intacto y limpiar `uploads/` huérfanos |

## Log

L1 (2026-10-27, usuario, verbatim): "desde el inicio quedamos en que no hay presupuesto, hay que optar por herramientas gratuitas al menos al principio, ten siempre en cuenta esto, no tenemos financiamiento disponible. Propón una solución que cumpla con lo ya establecido."

L2 (2026-10-27, usuario, verbatim): "Con respecto al punto 2, si tenemos almacenamiento en supabase y el audio no queda guardado en el servidor, no es posible hacer que se suba a supabase, desde ahí se analice y luego se borre como ya está haciendo? Dime lo que es mejor"

L3 (2026-10-27, diagnóstico del 525): `fly status` → "trial has ended, please add a credit card by visiting https://fly.io/trial". `curl https://lecmap-api.fly.dev/health` → TCP conecta pero el TLS handshake falla (`SSL_ERROR_SYSCALL`); `curl https://api.lecmap.app/health` → 525. Cloudflare está bien: el origen estaba caído. Fly.io queda descartado mientras no haya presupuesto.

L4 (2026-10-27, candidatos evaluados, sin tarjeta como requisito duro): **Render Hobby free → elegido** (512 MB RAM, 0.1 CPU, 750 instance-hours/mes, spin-down a los 15 min con cold start ~1 min, 5 GB de bandwidth, 500 build minutes, custom domain + TLS, requests HTTP de hasta 100 min — suficiente para transcribir, **no pide tarjeta**). Descartados: Koyeb (pide tarjeta desde feb 2026), Hugging Face Spaces (crear Docker/Gradio Space requiere PRO desde 2026), Railway ($5 de crédito + método de pago), Oracle/Cloud Run/AWS (siempre tarjeta), Fly.io (free allowances terminaron en oct 2024). Supabase free sigue siendo la base de datos: 500 MB DB, 1 GB file storage, 5 GB egress, 50k MAU, **pausa a los 7 días de inactividad**.

L5 (2026-10-27, seguimiento pendiente sobre L2 — NO es spec todavía): Groq acepta `url` además de `file` en `/audio/transcriptions` (docs oficiales: "Either a file or a URL must be provided"), así que el backend *podría* nunca guardar el audio: el cliente sube a Supabase Storage, el backend pasa una URL firmada a Groq y borra el objeto. Beneficios: desaparece la ventana donde un restart pierde el audio, el deja de transportar bytes de audio (libera los 5 GB de Render) y se borra código (`uploads/`, `removeAudioFile`, `cleanupOrphanAudio`, `GET /files/:name`). Pendiente de decisión del usuario: además, como el servidor ya borró su copia tras transcribir, **"Liberar audio" en Android hoy borra la última copia que existe** — conservar el objeto en Supabase (1 GB gratis ≈ 400 audios de 10 min) arreglaría eso. Costo: refactor cruzado en Android + web + backend + RLS. Va como tarea aparte, después de restaurar el servicio.
