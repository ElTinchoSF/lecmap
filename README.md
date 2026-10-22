# Lecmap — web + Android (implementación propia)

Grabá una clase, transcribila, resumila y convertí el contenido en un mapa de ideas. Implementación propia; no usa código ni assets de HiNoter.

## Nombre

- **Lecmap**: la app.
- **ApIA**: el asistente de IA que responde preguntas dentro de cada nota.

## Estructura

- `backend/` Node + Fastify + SQLite (`node:sqlite`). API compartida web/Android. STT/LLM vía Groq (API compatible OpenAI).
- `web/` React + Vite + TS. Grabación con MediaRecorder, upload, transcripción, resumen, Q&A, búsqueda.
- `android/` Kotlin nativo con Jetpack Compose. Grabación con MediaRecorder, subida al backend con Retrofit, lista, detalle, resumen, Q&A y los mismos 7 diseños de mapa de ideas que la web.
- `docs/API.md` contrato compartido.

## Web publicada

- Repo: <https://github.com/ElTinchoSF/lecmap>
- Web: <https://lecmap.app> (también <https://www.lecmap.app> y <https://eltinchosf.github.io/lecmap/>)
- API: <https://api.lecmap.app>
- El workflow `.github/workflows/deploy-web.yml` compila `web/` y publica `dist/` en cada push a `main`.
- La URL del backend se configura en la variable de repositorio `VITE_API_URL=https://api.lecmap.app`; hay que volver a desplegar si cambia.
- `lecmap.app` es el dominio personalizado de GitHub Pages (DNS en Cloudflare, registros A a GitHub Pages y CNAME `www`). `api.lecmap.app` es un túnel nombrado de Cloudflare hacia `http://127.0.0.1:3001`.

## MVP v1

1. Crear grabación (audio o URL YouTube) -> `POST /recordings`
2. Transcribir (Whisper + diarización básica) -> `POST /recordings/:id/transcribe`
3. Resumir + mapa de ideas adaptativo -> `POST /recordings/:id/summarize`. La IA elige el diseño según el contenido: mapa de temas (`topics`), tabla comparativa (`comparison`), pasos (`steps`), línea de tiempo (`timeline`), glosario (`glossary`), causa-efecto (`cause`) o problema-solución (`solution`). Sin límite de ramas. En clases largas el resumen corre en segundo plano y por bloques para respetar el límite gratuito de Groq (8.000 tokens/minuto); la nota queda en `summarizing` hasta que termina (puede tardar unos minutos).
4. Preguntar a ApIA -> `POST /recordings/:id/ask`
5. Buscar por keyword -> `GET /recordings?q=`
6. Exportar la transcripción a CSV (tiempo + texto) o TXT (solo texto), desde la web o Android
7. Compartir por link firmado (v1 simple)

Fuera de v1: auto-join calendario, Wear OS, cifrado E2E.

## Arranque

```bash
# backend
cd backend
npm install
copy .env.example .env  # OPENAI_API_KEY=gsk_... (Groq), OPENAI_BASE_URL=https://api.groq.com/openai/v1, API_TOKEN=... (opcional)
npm run dev  # :3001

# web
cd web
npm install
npm run dev  # :5173, VITE_API_URL=http://localhost:3001
```

## Almacenamiento local-first

- **El audio vive en el dispositivo.** La web lo guarda en IndexedDB y Android en `filesDir` (`.m4a`). Grabar **no sube nada**.
- Al tocar **Analizar**, el cliente sube el audio una sola vez para transcribir. Cuando STT termina bien, el backend guarda la transcripción, **borra su copia del audio** y deja `audioPath: null`.
- La reproducción usa la copia local. Si una nota antigua todavía tiene audio en el servidor, se reproduce por `/files/:name`.
- **Eliminar nota** borra la nota del servidor (si existe), el audio local y la fila local. **Liberar audio** borra solo el audio local y conserva transcripción, resumen y mapa.
- Un limpiador del backend borra audios huérfanos al arrancar y cada 6 horas. También se puede ejecutar a mano:

```bash
cd backend
npm run cleanup
```

- `backend/samples/` contiene los audios de demostración (TTS), separados de las grabaciones reales.
- En Android, si no hay red al tocar **Analizar**, la nota y su `.m4a` quedan guardados; se puede reintentar más tarde.

## APK Android

Toolchain portátil instalado en `%LOCALAPPDATA%\AndroidDev` (JDK 17 + Gradle 8.9) y SDK en `%LOCALAPPDATA%\Android\Sdk` (platform 34, build-tools 34.0.0).

```powershell
cd android
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1
# APK: android\app\build\outputs\apk\debug\app-debug.apk
# Copia lista para instalar: android\Lecmap-debug.apk
```

La app tiene un selector de servidor (tocar "Cambiar servidor" arriba): acepta `192.168.x.x:3001` o una URL completa y la recuerda. Emulador: `http://10.0.2.2:3001/`. Teléfono en la misma red: `http://IP_DE_LA_PC:3001/`.

### Usar sin USB (Wi-Fi de otra red o datos móviles)

El backend ya está publicado en **`https://api.lecmap.app`** mediante un túnel **nombrado** de Cloudflare (no cambia de URL). En la app, **Cambiar servidor** debe apuntar a `https://api.lecmap.app/`.

Para levantarlo en la PC:

```powershell
# 1) backend con reinicio automático
cd backend
powershell -ExecutionPolicy Bypass -File .\start-backend.ps1

# 2) túnel nombrado (en otra consola)
& "$env:LOCALAPPDATA\AndroidDev\cloudflared.exe" tunnel run lecmap
```

Dejá ambas ventanas abiertas. El túnel usa `%USERPROFILE%\.cloudflared\config.yml` y enruta `api.lecmap.app` a `http://127.0.0.1:3001`.

- La PC tiene que quedar encendida con el backend y el túnel corriendo.
- Si el túnel se reinicia, la URL sigue siendo `https://api.lecmap.app`.
- El túnel no tiene login propio. Si el backend define `API_TOKEN`, todas las rutas menos `/health` y `/files` exigen `Authorization: Bearer <token>`. En la web se pega en **Ajustes (⚙)** y en Android en **Cambiar servidor**; el token queda guardado en cada dispositivo.
- Para la misma red se puede usar directamente `http://IP_DE_LA_PC:3001/` (más rápido y sin límite de tiempo del túnel).

Para la misma red, el puerto 3001 debe estar permitido en el firewall de Windows. En una consola **como administrador**:

```powershell
New-NetFirewallRule -DisplayName "Lecmap backend 3001" -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow
```

### Grabar en segundo plano

La grabación corre en un **servicio en primer plano** (`microphone`): sigue activa con la pantalla apagada, el teléfono bloqueado o al cambiar de app. Aparece una notificación con la acción **Detener**.

### Analizar

El análisis **no es automático**. En la lista, las notas pendientes muestran **Analizar** (transcribe + resume en un solo paso); las que ya tienen transcripción pero no resumen muestran **Resumir**. En el detalle siguen los botones separados **Transcribir** y **Resumir**.

- En TECNO/Transsion conviene dejar la app sin restricciones de batería: **Ajustes → Apps → Lecmap → Batería → Sin restricciones**. También se puede exceptuar por ADB: `adb shell cmd deviceidle whitelist +com.notasia.clone`.

> El `applicationId` de Android sigue siendo `com.notasia.clone` para no perder la instalación ni los datos existentes. Se cambiará recién para una publicación nueva en la tienda.
- El audio se graba en AAC mono a 32 kbps (~14 MB por hora), debajo del límite de 25 MB por archivo de Groq.
- El título de la nota usa la hora en que empezó la grabación.
- Si al detener no hay internet, la grabación **no se pierde**: queda guardada en el teléfono y se reintenta al abrir o volver a la app (también reintenta unos segundos al detener).

Mapa de ideas: el backend elige el layout según la clase y la app lo renderiza igual que la web (`topics`, `comparison`, `steps`, `timeline`, `glossary`, `cause`, `solution`).
