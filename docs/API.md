# Contrato API de Lecmap v1

Base pública: `https://api.lecmap.app` (local: `http://localhost:3001`, Android emulador: `http://10.0.2.2:3001`, dispositivo: IP LAN).

## Modelos

Recording: `{ id, title, status: queued|transcribing|ready|error, audioPath?, youtubeUrl?, transcript?: Segment[], summary?, mindmap?, error?, createdAt }`
Segment: `{ start, end, speaker, text }`
Mindmap: `{ title, layout, topics?, dimensions?, items?, steps?, events?, terms?, causes?, problems? }`

`layout` lo elige la IA según lo que escucha. Los diseños especiales se usan **solo si el contenido realmente se ajusta**; si no, cae en `topics`.

- `topics` (uso general): `topics: [{ title, branches: [{ label, detail?, points?, branches? }] }]`. Cada topic es un tema central; `branches` puede anidar sub-ramas en su propio campo `branches`. Sin límite de temas, ramas, sub-ramas ni puntos.
- `comparison` (varios elementos con dimensiones comunes): `dimensions: [string]` y `items: [{ name, values: [string] }]`, donde `values` va en el mismo orden que `dimensions`. Ideal para comparar teorías, modelos o autores.
- `steps` (procesos, métodos o secuencias): `steps: [{ label, detail?, points? }]`.
- `timeline` (evolución o sucesión histórica): `events: [{ date?, label, detail?, points? }]`.
- `glossary` (clase de definiciones): `terms: [{ term, definition, points? }]`.
- `cause` (causas y consecuencias): `causes: [{ label, detail?, effects: [string] }]`.
- `solution` (problemas y soluciones): `problems: [{ label, detail?, solutions: [string] }]`.

Solo `timeline` y `steps` son cronológicos. El backend normaliza los formatos viejos (`{ branches }`, `{ nodes }` o `{ root, children }`) a `layout: topics` con un único topic, y si el layout pedido no trae datos válidos prueba los demás antes de caer a `topics`.

## Endpoints

- `POST /recordings` multipart `audio` o json `{ title, youtubeUrl }` -> Recording queued. Es el **único** momento en que el cliente sube audio, y solo al tocar **Analizar**.
- `POST /recordings/:id/audio` multipart `audio` -> vuelve a subir el audio de una nota existente (reanálisis). Reemplaza el archivo anterior.
- `GET /recordings?q=` lista + búsqueda keyword en transcript (`title` y `segments.text`)
- `GET /recordings/:id` detalle
- `DELETE /recordings/:id` borra registro, segmentos y archivo de audio
- `GET /files/:name` sirve el audio subido (para el reproductor web/Android; las notas analizadas ya no tienen audio en el servidor)
- `POST /recordings/:id/transcribe` lanza STT (Groq `whisper-large-v3`). Si termina bien, guarda la transcripción, **borra el archivo de audio del servidor** y deja `audioPath: null`.
- `POST /recordings/:id/summarize` `{ template?: general|meeting|class }` -> Recording con `{ summary, mindmap }`
- `POST /recordings/:id/ask` `{ question }` -> `{ answer, citations: [{start,end}] }` (lo usa **ApIA**)
- `GET /health` -> `{ ok: true, openai: boolean, stt, chat }`

## Persistencia

SQLite nativo (`node:sqlite`) en `backend/data/notas.db`. Tablas `recordings` y `segments`.
Los audios se guardan en `backend/uploads/` solo hasta que la transcripción termina; después se borran y la nota queda con `audioPath: null`. El cliente conserva su copia local (IndexedDB en web, archivo `.m4a` en Android). Al borrar una grabación (`DELETE /recordings/:id`) también se elimina el archivo si todavía existe. Un limpiador al arrancar y cada 6 horas borra archivos de `uploads/` que ninguna fila de SQLite referencia. Los audios de demostración (TTS) están en `backend/samples/` y no se sirven por la API.

CORS: por defecto acepta `https://lecmap.app`, `https://www.lecmap.app`, el Pages de GitHub y `localhost:5173`; se puede ajustar con `CORS_ORIGINS` (lista separada por comas). Los clientes nativos sin `Origin` también se aceptan.

Errores: `{ error: string }` con 4xx/5xx. Todo en JSON UTF-8.
