# Contrato API de Lecmap v1

Base: `http://localhost:3001` (Android emulador: `http://10.0.2.2:3001`, dispositivo: IP LAN)

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

- `POST /recordings` multipart `audio` o json `{ title, youtubeUrl }` -> Recording queued
- `GET /recordings?q=` lista + búsqueda keyword en transcript (`title` y `segments.text`)
- `GET /recordings/:id` detalle
- `DELETE /recordings/:id` borra registro, segmentos y archivo de audio
- `GET /files/:name` sirve el audio subido (para el reproductor web/Android)
- `POST /recordings/:id/transcribe` lanza STT (Groq `whisper-large-v3`)
- `POST /recordings/:id/summarize` `{ template?: general|meeting|class }` -> Recording con `{ summary, mindmap }`
- `POST /recordings/:id/ask` `{ question }` -> `{ answer, citations: [{start,end}] }` (lo usa **ApIA**)
- `GET /health` -> `{ ok: true, openai: boolean, stt, chat }`

## Persistencia

SQLite nativo (`node:sqlite`) en `backend/data/notas.db`. Tablas `recordings` y `segments`.
Los audios de las grabaciones se guardan en `backend/uploads/`. Al borrar una grabación (`DELETE /recordings/:id`) se elimina también su archivo de audio. Los audios de demostración (TTS) están en `backend/samples/` y no se sirven por la API.

Errores: `{ error: string }` con 4xx/5xx. Todo en JSON UTF-8.
