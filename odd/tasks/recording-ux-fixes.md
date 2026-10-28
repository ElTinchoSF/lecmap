# Fixes de grabación y UX (9 reportes) + ícono Google

Objetivo: resolver los 9 problemas reportados por el usuario el 27/10/2026 sobre grabación/guardado/labels/botones en Android y web, y agregar el ícono de Google al botón de login web.
Rama: `feat/recording-ux-fixes` · Estrategia: commits por unidad de trabajo · Prueba: Android `gradle assembleDebug` + USB (`adb`), web `npx tsc --noEmit` + `vite build`, backend `npm run dev` + probes curl.
Forecast: ~500 líneas (additions + deletions). Ruta: **inline** (unidades secuenciales en cada superficie; ninguna por sí sola supera el costo de arrancar un subagente de escritura).

## Specs

S1 — Grabación guardada dos veces (nota fantasma antes de "Detener").
Fuente verbatim: "Grabé una clase hoy y por alguna razón la guardó dos veces." + aclaración del usuario: "la nota ya figuraba guardada antes de que presione 'Detener', luego de presionar detener al finalizar la clase apareció la que realmente yo pude detener."
Diagnóstico verificado en el dispositivo `130303752L001050`: dos filas en `lecmap_local.db` apuntando al mismo `.m4a` — `local_1793122061670` (localId derivado del **nombre de archivo**, creada por `LocalStore.recoverOrphans()` a mitad de grabación) y `local_1793122062040` (localId derivado de `startedAt`, creada al Detener). Difieren en 370 ms porque `MediaRecorder.prepare()` corre entre la creación del nombre de archivo y la asignación de `startedAt`, así que nunca colisionan en la PRIMARY KEY.
Aceptación: durante una grabación en curso ningún `refresh()` crea una nota por el archivo en curso; al Detener queda **exactamente una** fila local por grabación (el barrido de huérfanos y `stopAndSave` usan el mismo `localId`); `recoverOrphans` sigue recuperando huérfanos reales (proceso muerto a mitad de toma). Verificado en el dispositivo consultando la DB.

S2 — Pedir el nombre al guardar la grabación.
Fuente verbatim: "Ninguna de las veces me pidió el nombre para guardar la grabación."
Aceptación: al detener la grabación (Android) o al terminar la toma (web) se muestra un diálogo con el título sugerido editable, y el nombre elegido queda como título de la nota en local y servidor. Cerrar el diálogo sin guardar conserva el nombre sugerido (la grabación no se pierde).

S3 — Botón de pausa durante la grabación.
Fuente verbatim: "Al hacer click en grabar no aparece más el botón de pausa (sí el de detener)."
Aceptación: mientras la grabación está activa hay botones "Pausar" y "Detener" (Android y web); "Pausar" pausa y "Reanudar" reanuda (`MediaRecorder.pause()`/`resume()`); al detener después de una pausa se guarda **una sola** nota con todo el audio. El estado (grabando / en pausa) se refleja en la UI (y en la notificación de Android).

S4 — Botón "Renombrar" la grabación.
Fuente verbatim: "Desapareció el botón de Renombrar la grabación."
Aceptación: en el detalle de la nota existe "Renombrar": abre un diálogo con el título actual editable; el nuevo nombre se guarda en el servidor (ruta nueva `PATCH /recordings/:id` con `{title}` — el backend no tiene hoy ninguna ruta de renombrado: solo GET/POST/DELETE) y en la copia local; la lista muestra el nombre nuevo en web y Android.

S5 — "Analizar" debe aplicar "Transcribir" + "Resumir".
Fuente verbatim: "Al hacer click en 'Analizar' solo transcribe, debería 'Transcribir'+'Resumir'."
Aceptación: al tocar "Analizar" (en la tarjeta) una sola vez y dejar terminar, la nota queda con transcripción **y** resumen (`ready` con `summary` no nulo); si el resumir falla se muestra un error visible (no pasa silencioso). Reproducir primero para confirmar el fallo antes de tocar código (el `analyze()` actual ya encadena ambos pasos en código — la falla puede estar en el backend o en la UI).

S6 — Dentro del detalle: botones "Transcribir" y "Resumir"; "Analizar" solo en la tarjeta.
Fuente verbatim: "Al tener desplegada alguna grabación está el botón de 'Analizar' y el de 'Resumir', dentro de la grabación debería estar el botón de 'Transcribir' y el de 'Resumir' (que está bien). Ya que la idea de que esté el 'Analizar' en la tarjeta de la grabación (no dentro) aplicaría las funciones de esos dos botones."
Aceptación: en el detalle los botones son "Transcribir" (solo transcribe) y "Resumir" (solo resume; deshabilitado sin transcript, como hoy); desaparecen "Analizar" y "Analizar de nuevo" del detalle; la tarjeta conserva "Analizar" que aplica ambas funciones.

S7 — Un solo label al resumir.
Fuente verbatim: "Cuando se hace click en 'Analizar' (desde fuera de la grabación) aparecen dos labels, uno 'sumarizing' y el otro 'Resumiendo.. esto puede llevar unos minutos'. Solo debe quedar el segundo."
Aceptación: mientras la nota está en `summarizing` solo se ve "Resumiendo… puede tardar unos minutos" (o el texto equivalente ya existente); no se muestra el estado crudo `summarizing` junto a ese label. Los otros estados crudos del badge no se tocan.

S8 — Label "Cargando nota…" al tocar una card.
Fuente verbatim: "Al hacer tap sobre alguna Card sería importante que si la nota debe cargar, así como cuando está resumiendo, aparezca un label que diga 'Cargando Nota..' o algo así."
Aceptación: al tocar una card cuyo detalle se está cargando del servidor aparece "Cargando nota…" hasta que el detalle se muestra (web y Android); si el detalle es local/corto el label no parpadea innecesariamente.

S9 — Diálogo de salida mínimo en Android.
Fuente verbatim: "En la app de Android al presionar 'Salir' en el diálogo de confirmación sólo debe decir 'Está seguro que desea salir?' el resto no debe decir nada con respecto al almacenamiento o no de las grabaciones. Eso no está definido todavía."
Aceptación: el texto del diálogo de salida en Android es exactamente "Está seguro que desea salir?" — sin ninguna mención a grabaciones, servidor, cuenta o almacenamiento. (Alcance: solo Android; la web no tiene diálogo de salida.)

S10 — Ícono de Google en el botón de login de la web.
Fuente verbatim: "Y me gustaría que tenga el icono de Google en el botón, como aparece en la mayoría de las apps"
Aceptación: el botón "Continuar con Google" de la web muestra el ícono multicolor de Google a la izquierda del texto (SVG inline, sin dependencias nuevas). El botón de Google de Android queda fuera de este feature (bloqueado en config del proveedor, ver L5).

## Tasks

| ID | Specs | Ruta | Estado | Commit / evidencia |
|----|-------|------|--------|--------------------|
| T1 | S1 | inline | ✅ hecho | E2E en dispositivo: refresh a mitad de grabación (HOME+relaunch) creó 0 filas fantasma; al Detener exactamente 1 fila nueva (`local_1793147898379`); build+tests gradle OK; duplicado histórico y nota de prueba limpiados en la DB |
| T2 | S9 | inline | ✅ hecho | Diálogo de salida en dispositivo: texto exacto "Está seguro que desea salir?" (uiautomator dump), sin mención a grabaciones/almacenamiento; título "Cerrar sesión" y botones Cancelar/Cerrar sesión conservados; `assembleDebug`+tests OK |
| T3 | S7 | inline | ✅ hecho | Card y badge web: se oculta el estado crudo `summarizing` mientras existe el label "Resumiendo…"; Android: mismo fix en RecordingCard. Build web+android OK. Live de `summarizing` queda pendiente de observación con una nota real (ambas existentes están `ready`) |
| T4 | S8 | inline | ✅ hecho | `loadingId`/`loadingNoteId` + label "Cargando nota…" en la card mientras fetch del detalle; tap E2E en dispositivo abrió el detalle del servidor correctamente. Label no observable en local (fetch <1s); su caso de uso es red lenta |
| T5 | S6 | inline | ⬜ pendiente | — |
| T6 | S5 | inline | ⬜ pendiente | — |
| T7 | S3 | inline | ⬜ pendiente | — |
| T8 | S2 | inline | ⬜ pendiente | — |
| T9 | S4 | inline | ⬜ pendiente | — |
| T10 | S10 | inline | ✅ hecho | `npx tsc --noEmit` + `vite build` OK; SVG inline de Google en `Login.tsx` + `login-google` flex con gap en `App.css` |

## Log

L1 (2026-10-27, usuario, verbatim): "1. Grabé una clase hoy y por alguna razón la guardó dos veces. 2. Ninguna de las veces me pidió el nombre para guardar la grabación. 3. Al hacer click en grabar no aparece más el botón de pausa (sí el de detener). 4. Desapareció el botón de Renombrar la grabación. 5. Al hacer click en 'Analizar' solo transcribe, debería 'Transcribir'+'Resumir'. 6. Al tener desplegada alguna grabación está el botón de 'Analizar' y el de 'Resumir', dentro de la grabación debería estar el botón de 'Transcribir' y el de 'Resumir' (que está bien). Ya que la idea de que esté el 'Analizar' en la tarjeta de la grabación (no dentro) aplicaría las funciones de esos dos botones. 7. Cuando se hace click en 'Analizar' (desde fuera de la grabación) aparecen dos labels, uno 'sumarizing' y el otro 'Resumiendo.. esto puede llevar unos minutos'. Solo debe quedar el segundo. 8. Al hacer tap sobre alguna Card sería importante que si la nota debe cargar, así como cuando está resumiendo, aparezca un label que diga 'Cargando Nota..' o algo así. 9. En la app de Android al presionar 'Salir' en el diálogo de confirmación sólo debe decir 'Está seguro que desea salir?' el resto no debe decir nada con respecto al almacenamiento o no de las grabaciones. Eso no está definido todavía."

L2 (2026-10-27, usuario, verbatim): "antes que nada una aclaración del problema 1, la nota ya figuraba guardada antes de que presione 'Detener', luego de presionar detener al finalizar la clase apareció la que realmente yo pude detener. Esta conectado el teléfono, puedes depurar a traves de usb para verlo y analizarlo a detalle. Y en cuanto a tu pregunta, iniciemos con el login de google y su ícono, puede ser?"

L3 (2026-10-27, diagnóstico S1 en dispositivo vía USB): `adb shell run-as com.notasia.clone cat databases/lecmap_local.db` muestra dos filas para un mismo `.m4a` (`nota_1793122061670.m4a`, 17 MB): `local_1793122061670` (status ready, server_id `caku8ctm` — la fila del huérfano) y `local_1793122062040` (status local — la fila de `stopAndSave`). Mecanismo: `recoverOrphans()` corre en cada `refresh()` (ON_RESUME al desbloquear/volver a la app) y ve el `.m4a` en curso sin fila (la fila recién se crea al Detener) → lo trata como huérfano y crea la nota antes de que el usuario pare la clase. El `localId` del huérfano usa el timestamp del nombre de archivo y el de `stopAndSave` usa `startedAt` (370 ms después por `prepare()`) → IDs distintos → dos filas. La web NO tiene este bug (guarda solo en `onstop` de MediaRecorder).

L4 (2026-10-27, verificación web de S3/S4): `git log -S "Pausar"` → el único hit es el botón de pausa del **reproductor de audio** (commit `5ae152f`), nunca existió un botón de pausa de grabación en el repo; `git log -S "Renombrar"` → sin hits, nunca existió. Ambos son funcionalidad a crear, no a restaurar.

L5 (2026-10-27, bloqueo del login Google — pendiente de decisión/config del usuario): `GET /auth/v1/settings` del proyecto `wglycndzgxgjtplwrcyq` devuelve `"google": false` — el proveedor Google está **deshabilitado** en Supabase; por eso "Continuar con Google" no funciona (no es bug de código: `auth.ts:46-52` hace `signInWithOAuth` correctamente). Para habilitarlo hace falta: (1) credencial OAuth Client ID en Google Cloud Console (redirect URI `https://wglycndzgxgjtplwrcyq.supabase.co/auth/v1/callback`), (2) habilitar el provider Google en Supabase Dashboard → Authentication → Providers con ese Client ID/Secret, (3) agregar `https://lecmap.app/**` en Authentication → URL Configuration → Redirect URLs y fijar Site URL `https://lecmap.app`. No hay `service_role` en el repo para hacerlo por API; es tarea del usuario en los dashboards. El ícono del botón (S10) se hace igualmente.

L6 (2026-10-27, T1 implementado y verificado en dispositivo): Fix en `RecordingService.kt` + `LocalStore.kt`: (1) un solo `start = System.currentTimeMillis()` alimenta el nombre del archivo Y `startedAt` (antes `prepare()` corría entre uno y otro y desfasaba 370 ms → dos localId); (2) `RecordingState.activeFile` marca el `.m4a` en curso y `recoverOrphans()` lo excluye. E2E: grabar → HOME → relaunch (dispara ON_RESUME→refresh) → DB sin filas nuevas; Detener → exactamente 1 fila nueva; UI sin duplicados. Hallazgo: el duplicado histórico se limpió a nivel DB porque **ambas filas referenciaban el MISMO `.m4a`** — borrar cualquiera de las dos desde la app habría borrado el audio que la otra referencia (se conservó la fila con análisis `caku8ctm`, se eliminó la vacía). Gotcha adb: `adb shell` re-parsea comillas — para escribir dentro del sandbox de la app el redirect va entero entre comillas dobles locales: `adb shell "run-as <pkg> sh -c 'cat > databases/x.db'" < local`. Nota de prueba (`local_1793147898379`) eliminada (fila + .m4a). Sin RED de unit test: `LocalStore` depende de Context/SQLite y el proyecto no tiene Robolectric — la verificación es la E2E en dispositivo (el RED quedó registrado por los datos reales duplicados en L3).

L7 (2026-10-27, S9+S7+S8 implementados): (1) **S9**: diálogo "Salir" de Android ahora dice exactamente "Está seguro que desea salir?" — se eliminó el párrafo sobre grabaciones/almacenamiento ("no está definido todavía"); verificado en dispositivo vía uiautomator dump. (2) **S7**: mientras `status == "summarizing"` se oculta el estado crudo en la card web, el badge del detalle web y el estado de la card Android — solo queda el label "Resumiendo… puede tardar unos minutos". Live de un estado `summarizing` real queda pendiente (ambas notas existentes están `ready` y sin botón Analizar visible). (3) **S8**: al tocar una card con `serverId`, la card muestra "Cargando nota…" hasta que el detalle llega (`loadingId` en web, `loadingNoteId` en AppViewModel); tap E2E abrió el detalle de "Clase de Fotosíntesis" correctamente. Gotchas: `setLoadingId(null)` debe quedar FUERA del try (dentro del try no se limpia en throw — se agregó al final del bloque `if`); el detalle del LazyColumn queda bajo el pliegue — para verlo en dumps hay que hacer scroll dentro de la app; una swipe desde el borde de la pantalla cierra/bloquea la app (usar swipes centrados). Builds: tsc+vite OK, gradle assembleDebug+testDebugUnitTest OK.
