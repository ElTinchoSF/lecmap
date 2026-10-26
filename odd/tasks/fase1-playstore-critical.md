# Fase 1 — Quick wins críticos para Play Store

Objetivo: eliminar riesgo activo antes de publicar en Play Store (dependencia fantasma, errores ocultos, timeouts ausentes, pérdida de grabaciones en Android, tipado estricto y validación de URL de servidor).
Rama: `fase1-playstore-critical` · Estrategia de entrega: commits por unidad de trabajo · Prueba de ejecución: backend `npm run dev` (:3001) + probes con curl, web `npx tsc --noEmit`, Android `gradle assembleDebug` + instalación USB con `adb`.
Forecast de líneas autorizadas: ~150 (additions + deletions). Ruta de cada tarea: **inline** (sin trigger de writer: unidades secuenciales, no paralelas, y ninguna supera el costo de arrancar un subagente).

## Specs

S1 — Eliminar dependencia fantasma `dotv`.
Fuente verbatim (propuesta aprobada): "`dotv@^0.0.1` en `backend/package.json:14` ... lo verifiqué: está en package.json pero **ningún archivo lo importa** (el código usa `dotenv`). Un paquete fantasma ... **Borrarlo hoy.**"
Aceptación: `"dotv"` no figura en `backend/package.json` ni en `backend/package-lock.json`; `npm install` no lo reintegra; `npm ls dotv` no lo muestra.

S2 — Errores de transcripción con status 5xx (hoy devuelve 200).
Fuente verbatim (propuesta aprobada): "**Transcripción devuelve HTTP 200 en error** (`backend/src/index.js:556-559`) — el `catch` devuelve `setStatus(... 'error' ...)` con status 200. Tus clientes chequean `if (!r.ok)` (App.tsx:953) → **el fallo pasa silencioso**". Propuesta: "devolver 5xx en errores de transcribe".
Aceptación: cuando la transcripción falla (Groq responde error, audio ilegible, etc.), `POST /recordings/:id/transcribe` responde status 5xx (no 200) con cuerpo `status:'error'` y `error`; el caso exitoso responde 2xx y el cuerpo no cambia. `POST` a un id inexistente responde 404.

S3 — Timeouts en todos los fetch a Groq.
Fuente verbatim (propuesta aprobada): "**Sin timeout en ningún fetch a Groq** (`index.js:191, :214`) — un Whisper colgado deja la request abierta indefinidamente". Propuesta: "`AbortSignal.timeout()` en los fetch a Groq".
Aceptación: cada `fetch` hacia Groq envía `signal` con `AbortSignal.timeout(...)`; el timeout es configurable por variables de entorno con default razonable (`STT_TIMEOUT_MS`, `LLM_TIMEOUT_MS`); al agotarse, el handler responde 5xx con mensaje claro y el estado de la nota queda en `error` (no en `transcribing`/`summarizing` colgado). Documentado en README/.env.example.

S4 — Android: no perder la grabación en curso al morir el proceso.
Fuente verbatim (propuesta aprobada): "**Android borra la grabación en curso en `onDestroy`** (`RecordingService.kt:251`) + `START_NOT_STICKY` (`:85`) — si el sistema mata el proceso mientras grabás, **perdés la toma**. Para una app de grabación, eso es el bug más caro que podés tener."
Aceptación: si el servicio/proceso se destruye sin la acción de parada explícita (matado por el sistema), el archivo parcial `.m4a` **se conserva** y la nota queda recuperable (aparece como pendiente/reanudable, no se pierde). La parada explícita con la acción **Detener** conserva el comportamiento actual de guardado.

S5 — Habilitar TypeScript `strict` en web.
Fuente verbatim (propuesta aprobada): "**`strict: true` NO está** en `web/tsconfig.app.json` (verificado) — `mindmap: any` en `:65` anula el tipado". Propuesta: "`strict: true` + tipar `mindmap`".
Aceptación: `web/tsconfig.app.json` tiene `"strict": true`; `npx tsc --noEmit` termina sin errores; los `any` abiertos del flujo de mindmap (`mindmap: any`, `str(v: any)` en App.tsx) quedan tipados o, donde el shape sea genuinamente dinámico, tipados con un tipo explícito documentado (`unknown` + narrowers), no `any` crudo.

S6 — Validación de la URL de servidor en Android.
Fuente verbatim (propuesta aprobada en la pregunta "¿arranco con la Fase 1 ... y validación de URL?"): "la app no valida la URL — `Net.normalize()` solo agrega `http://` y el slash final, así que guardó cualquier cosa" y "**validar la URL con `HttpUrl` de OkHttp y rechazarla con un mensaje claro** ('URL inválida: falta el puerto') en vez de fallar misteriosamente después".
Aceptación: `Net.normalize`/`updateServerUrl` rechazan (a) cualquier string que no parsee como URL http(s) válida, y (b) el typo observado hoy `http://127.0.0.1/3001/` (puerto ausente con primer segmento de ruta puramente numérico), mostrando un mensaje de error visible en el diálogo del servidor y **sin persistir** el valor inválido. Una URL válida (con puerto o sin él, ej. `https://api.lecmap.app/`) sigue funcionando igual. El rechazo no silencia el valor que el usuario ya tenía guardado.

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S1 | inline | ✅ hecho | evidencia: `npm ls dotv` vacío, lock 0 ocurrencias, `dotenv` import OK |
| T2 | S2 | inline | ✅ hecho | RED: HTTP 200+status:error reproducido → GREEN: 500+body JSON (local), 404 preservado, éxito 200 con transcript real (audio `say`) |
| T3 | S3 | inline | pendiente | — |
| T4 | S4 | inline | pendiente | — |
| T5 | S5 | inline | pendiente | — |
| T6 | S6 | inline | pendiente | — |

## Log

L1 (2026-10-25, usuario, verbatim): "si, arranca" — confirmando la propuesta: "¿arranco con la Fase 1 — los quick wins de Play Store (dotv, errores 5xx, timeouts, grabación de Android, strict, validación de URL)? Son cambios acotados, verificables en el celular con el mismo flujo que acabamos de probar, y te dejan la base sana para las fases que siguen."

L1-contexto (2026-10-25, usuario, verbatim): "Contesto tu pregunta y luego agrego otras cosas más: 1. La idea apunta a publicar en Play Store con usuarios reales".

Contexto de análisis (2026-10-25): objetivo Play Store con usuarios reales confirmado; roadmap aprobado en 3 fases (1 = quick wins, 2 = infra/eficiencia, 3 = transcripción en vivo). Depuración Android por USB operativa en la Mac (toolchain instalado, `adb reverse tcp:3001 tcp:3001`, backend local en :3001); el flujo grabar → analizar → resumen funcionó end-to-end en el celular. Bug hallado y corregido en el camino: `server_url` se guardó como `http://127.0.0.1/3001/` (sin validar) → origen del S6.
