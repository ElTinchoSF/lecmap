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

## MVP v1

1. Crear grabación (audio o URL YouTube) -> `POST /recordings`
2. Transcribir (Whisper + diarización básica) -> `POST /recordings/:id/transcribe`
3. Resumir + mapa de ideas adaptativo -> `POST /recordings/:id/summarize`. La IA elige el diseño según el contenido: mapa de temas (`topics`), tabla comparativa (`comparison`), pasos (`steps`), línea de tiempo (`timeline`), glosario (`glossary`), causa–efecto (`cause`) o problema–solución (`solution`). Sin límite de ramas.
4. Preguntar a ApIA -> `POST /recordings/:id/ask`
5. Buscar por keyword -> `GET /recordings?q=`
6. Compartir por link firmado (v1 simple)

Fuera de v1: auto-join calendario, Wear OS, cifrado E2E.

## Arranque

```bash
# backend
cd backend
npm install
copy .env.example .env  # OPENAI_API_KEY=gsk_... (Groq), OPENAI_BASE_URL=https://api.groq.com/openai/v1
npm run dev  # :3001

# web
cd web
npm install
npm run dev  # :5173, VITE_API_URL=http://localhost:3001
```

## Almacenamiento

- Las grabaciones subidas quedan en `backend/uploads/`. Al eliminar una nota desde la app se borra la fila de SQLite **y** su archivo de audio.
- `backend/samples/` contiene los audios de demostración (TTS), separados de las grabaciones reales.
- Para limpiar archivos huérfanos (por ejemplo, si Windows bloqueó un archivo al borrar):

```bash
cd backend
npm run cleanup
```

- En Android, el `.m4a` local se borra después de subirlo. Si no hay red al detener, queda guardado y se reintenta al abrir la app.

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

Si el teléfono no está en la misma red que la PC, se expone el backend con un túnel HTTPS de Cloudflare (gratis, sin cuenta):

```powershell
cd android
powershell -ExecutionPolicy Bypass -File .\iniciar-tunel.ps1
```

Dejá esa ventana abierta. Copiá la URL `https://....trycloudflare.com` que aparece y pegala en la app con **Cambiar servidor**. Funciona con cualquier Wi-Fi y con datos móviles.

- La URL es **temporal**: cambia cada vez que se reinicia el túnel. Si cambia, actualizala en la app.
- La PC tiene que quedar encendida con el backend y el túnel corriendo.
- La URL es pública (sin login): no la compartas y cortá el túnel (Ctrl+C) al terminar.
- Cloudflare corta respuestas de más de ~100 s. Para clases muy largas, conviene dividir la grabación o usar la PC en la misma red.

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
