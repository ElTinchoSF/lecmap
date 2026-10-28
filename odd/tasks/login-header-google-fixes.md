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
| T3 | S2 (web) | inline | ✅ done | d2ba938 + 352b148 (fila 3) |
| T4 | S3 (código Android) | inline | ✅ done | b671992 + a17d3b3 (fix pkce) |
| T5 | S3 (config usuario — guía) | inline | 📤 guía entregada — blocked: config del usuario | |
| T6 | builds + E2E + doc/assess | inline | ✅ done | f509f05 |

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

L5 (2026-10-28, cierre T6):
- Fix commiteado `f2ff98f` (JSON refresh + coalescing + logs) y doc `f509f05`.
- E2E de login con credenciales tras logout: formulario completo + "Iniciar sesión" → app ✓ (fresh sign-in, sin refresh en vuelo).
- Limpieza del device: nota de prueba `local_1793157922018` borrada de `local_notes` (DB local vía run-as cat/push, integrity_check OK), audio `nota_1793157922018.m4a` y `notas_ia.xml.bak` eliminados; el server nunca la tuvo (verificado con GET /recordings con el token del device: sólo `caku8ctm` + `dakauszz`).
- Cold start final: splash → app directo (sesión válida), lista con sólo las 2 notas reales del usuario.
- Asses sobre `cc9b8bc..f509f05`: `risk: medium`, `review_due: false` (`under_budget`, reason `executable_change` en AndroidManifest) → sin review ceremony; registrar tier medium/under_budget.
- Guía de config (T5) entregada al usuario en el chat: Google Cloud OAuth Client + provider Google en Supabase + Redirect URLs (`https://lecmap.app`, `com.notasia.clone://login-callback`, callback `https://wglycndzgxgjtplwrcyq.supabase.co/auth/v1/callback`).

L6 (2026-10-28, verificador independiente + corrección de bloqueadores):
- Verifier (gentle-ai-verify, scratch fresh, cc9b8bc..da08cd1) → **2 BLOCKERS**:
  - **B1**: `SupabaseAuth.kt` usaba `grant_type=pkce_exchange`; GoTrue sólo acepta `password|refresh_token|id_token|pkce|web3` → el intercambio del código de Google habría fallado con 400 `unsupported_grant_type` (RED verificado EN VIVO contra `wglycndzgxgjtplwrcyq.supabase.co`: `pkce_exchange` → `unsupported_grant_type`; `pkce` → `flow_state_not_found`).
  - **B2**: S2 acepta "Fila 1 y fila 3 … en ambas plataformas", pero el header web sólo tenía 2 filas; `showSettings` era dead code (useState sin setter).
- Corrección (una sola tanda):
  - B1: `grant_type=pkce` + `SupabaseAuthContractTest.kt` (4 tests: JSON body del refresh, campo `refresh_token`, mapeo de errores GoTrue, grant pkce). **RED observado** (`expected …pkce but was …pkce_exchange`, 4 tests/1 failure) → fix → **GREEN** (4/0). Nota: los métodos `suspend` de Kotlin llevan `Continuation` extra → buscar por `declaredMethods`, no `getMethod` con la firma Kotlin.
  - B2: fila 3 web (`header-meta`: email/servidor + "Cambiar servidor" que abre el panel settings), panel con input editable de API persistido en `localStorage('lecmap_api_url')` (prioridad sobre `VITE_API_URL`) + Guardar/Restablecer con reload.
- Verificación: gradle `testDebugUnitTest` GREEN (4/0), `assembleDebug` OK, `tsc --noEmit` = 0, `vite build` OK; APK reinstalado en device → smoke: sesión activa, header 3 filas, notas reales.
- Advisories del verifier (sin corrección, aceptadas): A) cualquier app puede inyectar `?error=` al callback (no roba sesión por PKCE); B) doble tap Google pisa el verifier (limitación documentada del SDK); C) signOut vs refresh en vuelo (pre-existente); D) tokens/verifier en prefs con auto-backup; E) `singleTask` no afecta `RecordingService`.
- Commits: `a17d3b3` (fix pkce + tests), `352b148` (web fila 3).

L7 (2026-10-28, pedidos post-cierre + T5 del usuario):
- Usuario: "Listo lo que me pediste, creo" (config Google Cloud + Supabase) + 2 pedidos nuevos: (1) "Quiero que espejes en web el flash arreglado en android", (2) "Podemos reutilizar el splash de carga que usamos para cubrir el flash de pantalla de login para cubrir el delay en la carga de las RecordingCards? y agrandemos un poco el tamaño de 'Lecmap' en el splash, que se vea bien."
- **T5 verificado (parcial)**: curl authorize → HTTP 302 a `accounts.google.com/o/oauth2/v2/auth` con `client_id=495221402598-…` y `redirect_uri=https://wglycndzgxgjtplwrcyq.supabase.co/auth/v1/callback` → provider Google HABILITADO ✓. E2E completo (consent de Google + intercambio) pendiente de device.
- **"RecordingCards" = Android** (grep: componente `RecordingCard` en `MainActivity.kt:620`; en web es `rec-item`) — sin pregunta al usuario.
- Diagnóstico del delay: cold start medido en device (capturas 0.45s) → splash nativo → AuthSplash (~1.4s) → lista con cards (~1.8s) — **el cold start ya estaba cubierto**. Delay real = **tras login**: `persistAuth()` (signIn/signUp/OAuth) no seteaba `initialSessionCheck`, así que la app se pintaba con la lista vacía hasta el fetch. El gate (MainActivity:201) se pinta ANTES... no: el `LaunchedEffect(refresh)` (195) va ANTES del gate (201), y `persistAuth` dispara `refresh()` directo → sin riesgo de splash pegado.
- Implementación: `84fc59a` fix(web): `AuthSplash` exportado en `Login.tsx` + gate `supabase && auth.loading` en `App.tsx` + CSS `.auth-splash` (Lecmap 3rem). `7b823e0` feat(android): `initialSessionCheck = true` en `persistAuth()` + AuthSplash 32sp→40sp.
- Verificación: tsc=0, vite build OK, gradle test+assembleDebug OK. **RED→GREEN no aplicable** a los dos pedidos (sin test runner web; gate Compose sin test JVM factible) → excepción documentada; **E2E device PENDIENTE: se cayó la conexión adb WiFi** (`adb mdns services` no descubre el device).
- ⏳ Pendientes: reconexión del device → E2E (a) splash post-login con RecordingCards, (b) título 40sp, (c) tap Google → consent de Google (T5).

L8 (2026-10-28, E2E completado + skill de login):
- Usuario: "no puedes hacer esto cada vez que inicias sesión, tienes una skill para eso… por favor úsa la skill-registry". Se corrigió el flujo: `gentle-ai skill-registry refresh` (cache-hit, `.atl/skill-registry.md`) → skill **`skills/lecmap-android-login/SKILL.md`**. Sus hard rules explicaban los fallos previos (bounds capturados ANTES de abrir el teclado se corren al enfocar; clear con `input keycombination 113 29` antes de escribir; re-dump tras CADA tap). Ejecutada 2 veces con `login: ok` y cero retries — obligatoria en todo futuro E2E de login por adb.
- **T5 device ✅**: tap "Continuar con Google" → Chrome en `accounts.google.com` con "Selecciona una cuenta — Ir a `wglycndzgxgjtplwrcyq.supabase.co`" + cuentas del device. El paso de elegir cuenta/consent NO se ejecuta (identidad del usuario). Loop completo pendiente sólo de su click.
- **Punto 2 ✅**: capturas densas post-submit (0.12s = Login "…", **0.27s y 0.42s = AuthSplash "Lecmap" 40sp**, luego app con ambas RecordingCards) → el splash cubre el delay; cero frame con header y lista vacía.
- **Título 40sp ✅** (splash40b.png: "Lecmap" gradiente grande + tagline + spinner, bien proporcionado).
- Punto 1 (web) verificado por tsc+vite build; E2E visual web no automatizado (sin browser en el entorno) — queda a criterio del usuario con `vite dev`.
- Asses `867b8f4..7b823e0`: `medium` / `under_budget` (reason `executable_change` AppViewModel) → sin review ceremony.
