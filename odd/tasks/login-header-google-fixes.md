# Feature: login-header-google-fixes

Objetivo: que el Login se vea SIEMPRE primero sin parpadeo de la app (y sin cerrar sesión en grabación), header en 3 filas con pausa sólo ícono (Android + web), y 'Continuar con Google' funcionando (código Android + guía de config para Supabase/Google Cloud).
Rama: `feat/login-header-google` desde `cc9b8bc` (main). Delivery: commits por unidad; push/PR sólo si el usuario lo pide.
Checks: Android `gradle assembleDebug` + E2E en device; web `npx tsc --noEmit && npx vite build` (sin test runner en el repo).

## Specs

### S1 — Login siempre primero, sin parpadeo, y sin cerrar sesión durante grabación (Android)
Cita del usuario (verbatim): "Es necesario que SIEMPRE se vea primero la pantalla de Login antes que la app al entrar a la app, siempre que NO esté activa o abierta la sesión, por otro lado, mientras se está grabando la sesión no debe cerrarse automáticamente."

Síntoma confirmado por el usuario (2026-10-28, respuesta a diagnóstico): "Sólo el parpadeo" — observa que la app principal se pinta un instante antes del login al abrir; NUNCA observó una caída a login en medio de grabación. El guard de grabación se implementa igual, por exigencia explícita del punto ("mientras se está grabando la sesión no debe cerrarse automáticamente").

Aceptación:
- Arranque sin sesión activa: nunca se pinta la lista principal antes que Login. Un splash de carga (logo + spinner) cubre el resolución de sesión (`authLoading`) y recién después se muestra Login.
- Arranque con sesión válida: splash → app, sin parpadeo del contenido principal.
- Durante `RecordingState.isRecording` o `RecordingState.isPaused`: el auth gate NO muestra Login aunque `refresh()` reciba 401 no refresqueable.
- Al terminar la grabación con la sesión todavía inválida: aparece Login (correcto — la sesión murió).

### S2 — Header en 3 filas, 'Salir' oculto grabando, pausa sólo ícono (Android + web)
Cita del usuario (verbatim): "Al presionar grabar, el botón de 'Salir' debería hacerse no visible, ya que no tendría sentido salir en medio de una grabación. En su lugar debería aparecer el botón de pausar/reanudar grabación sin texto, sólo con el ícono de pausa/play respectivamente. De esa manera solventamos el desplazamiento del Layout del header, por otro lado sería bueno analizar la posibilidad de tener en la primera fila el nombre de la app y la frase y los botones en segunda linea, también ayudaría a la organización visual."

Diseño confirmado por el usuario (2026-10-28): alcance "Android y web" con esta distribución:
- Fila 1: `Lecmap` + `Tus clases, en un mapa`.
- Fila 2 (botones): `Salir` oculto mientras graba · pausa/reanudar **sólo ícono** ▶/⏸ (sin texto) · `Grabar`/`Detener`.
- Fila 3: email/servidor + `Cambiar servidor` (la que ya existe).

Aceptación:
- Mientras graba: `Salir` no visible; pausa/reanudar visible sólo con ícono; el ancho de la fila 2 es estable entre estados (sin desplazamiento del header).
- Sin grabación: `Salir` visible, sin botón de pausa, `Grabar` visible.
- Fila 1 y fila 3 como se describen, en ambas plataformas.

### S3 — 'Continuar con Google'
Cita del usuario (verbatim): "Es crítico fixear 'Continuar con Google' y agregar el ícono de google en el botón."

Alcance acordado (2026-10-28): guía de config paso a paso para el usuario (proveedor Google en Supabase + OAuth Client ID/Secret en Google Cloud) y código de mi lado. Estado actual verificado:
- Web: botón + ícono SVG + `signInWithOAuth` ya completos (`web/src/Login.tsx:52`, `web/src/auth.ts:46`) — sólo falta la config externa.
- Android: botón **comentado** (`android/.../LoginScreen.kt:101-104`), pendiente de esa config; a implementar con redirect `com.notasia.clone://login-callback` (applicationId verificado en `android/app/build.gradle:14`) e intent-filter en el manifest.

Aceptación:
- Android: botón visible con ícono de Google; click abre el flujo OAuth con el redirect correcto (E2E final requiere la config del usuario).
- Web: click funciona tras habilitar el provider (verificación post-config del usuario).
- Guía exacta entregada al usuario con ambos flujos (web `https://lecmap.app`, Android `com.notasia.clone://login-callback`, callback `https://<proyecto>.supabase.co/auth/v1/callback`).

## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T1 | S1 | inline | ✅ done | dbc0c9a |
| T2 | S2 (Android) | inline | ✅ done | (junto con T3) |
| T3 | S2 (web) | inline | ✅ done | feat(ui): three-row header… |
| T4 | S3 (código Android) | inline | ✅ done | feat(android): Continue with Google… |
| T5 | S3 (config usuario — guía) | inline | blocked: usuario | |
| T6 | builds + E2E + doc/assess | inline | pending | |

## Log

L1 (2026-10-28, verbatim — pedido original): "bien, vamos a ver algunas cosas:
1. Es necesario que SIEMPRE se vea primero la pantalla de Login antes que la app al entrar a la app, siempre que NO esté activa o abierta la sesión, por otro lado, mientras se está grabando la sesión no debe cerrarse automáticamente.
2. Al presionar grabar, el botón de 'Salir' debería hacerse no visible, ya que no tendría sentido salir en medio de una grabación. En su lugar debería aparecer el botón de pausar/reanudar grabación sin texto, sólo con el ícono de pausa/play respectivamente. De esa manera solventamos el desplazamiento del Layout del header, por otro lado sería bueno analizar la posibilidad de tener en la primera fila el nombre de la app y la frase y los botones en segunda linea, también ayudaría a la organización visual. Pregunta lo que necesites antes de tocar nada.
3. Es crítico fixear 'Continuar con Google' y agregar el ícono de google en el botón.
Empecemos por esas cosas, siempre pregunta lo que necesites antes de realizar cambios, y en el caso de que no tengas preguntas, informa que no las tienes y pide confirmación para proseguir. Toma esto como metodología de trabajo global y anótalo en memoria persistente."

L2 (2026-10-28, confirmaciones vía question): Item 1 = "Sólo el parpadeo" (diagnóstico (b) no observado; guard preventivo por exigencia del punto); Item 2 = "Android y web" con diseño de 3 filas propuesto; Item 3 = "Guío paso a paso". Luego: "perfecto, seguimos ese orden".

L3 (2026-10-28, causa raíz del parpadeo — verificada en código y device):
- GoTrue sólo acepta **JSON** en `POST /auth/v1/token?grant_type=refresh_token`; la app mandaba form-urlencoded (`@FormUrlEncoded`) → 400 `bad_json` → el refresh NUNCA funcionaba → 401 no refresqueable → logout con parpadeo. Fix: `RefreshReq` + `@Body` en `SupabaseAuth.kt`.
- Race de refresh doble: `refresh()` corría 2 veces (LaunchedEffect + ON_RESUME) con refresh token rotativo → el segundo refresh invalidaba el primero → sesión muerta al abrir. Fix: anti-reentrancia con coalescing (`refreshInFlight`/`refreshQueued`) en `AppViewModel.kt`.
- `AuthError` ahora mapea `msg`/`error_code` (GoTrue devuelve `{code,error_code,msg}`); antes mostraba "Error de autenticación" sin diagnóstico.
- init ya no lanza `tryRefreshToken()` paralelo: un SOLO camino de validación (`refresh()`), con logs `SessionFlow` en los 8 puntos del flujo.

L4 (2026-10-28, evidencia E2E en device — WiFi adb-130303752L001050):
- ✅ Recovery 401 → refresh OK → app sin Login: logs `init: stored tokens → validation via refresh()` → `refresh(): 401 from list → tryRefreshToken…` → `tryRefreshToken OK`, UN solo refresh.
- ✅ Header: marca en [48,156] idle y grabando en la MISMA posición (cero desplazamiento); `Salir` ausente grabando; desc=`Pausar grabación` en [611,393][683,465].
- ✅ Pausa↔reanudar alterna `Reanudar grabación`↔`Pausar grabación`; diálogo S2 "Guardar grabación" ("Nota 28/10 00:25", Cancelar/Guardar) → Cancelar → `Salir` vuelve.
- ✅ Logout con diálogo "Cerrar sesión/Está seguro que desea salir?" → Login.
- ✅ T4: ícono G multicolor renderizado; click en "Continuar con Google" abre Chrome en `…wglycndzgxgjtplwrcyq.supabase.co` con `{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}` → wiring app→navegador→authorize verificado; el único bloqueo es la config externa (T5).
- ⚠️ Web observado: el auth gate de `web/src/App.tsx:1302` tiene el mismo patrón de flash que Android (fuera de alcance de S1, que es Android) — reportar al usuario.
