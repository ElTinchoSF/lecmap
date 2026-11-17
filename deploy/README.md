# LecMap deploy — Hetzner (T10)

Stack completo en la VM: **Postgres + backend Node + worker STT (faster-whisper + diarize) + Caddy (HTTPS)**.

## Estructura

```
deploy/
├── docker-compose.yml   # servicios: db, backend, worker, caddy
├── Caddyfile            # reverse proxy HTTPS → backend:3001
└── README.md            # este archivo
```

El build del backend usa `../backend/Dockerfile`; el del worker, `../worker/Dockerfile` (multi-arch: amd64 + arm64).

## Variables de entorno (`.env`)

Crear `.env` en este directorio (no se commitea). Generar secrets con `openssl rand -hex 32`.

| Variable | Obligatoria | Descripción |
|---|---|---|
| `POSTGRES_PASSWORD` | sí | Password del usuario `lecmap` de Postgres |
| `WORKER_TOKEN` | sí | Token compartido backend ↔ worker |
| `SUPABASE_URL` | sí | `https://<proyecto>.supabase.co` — solo Auth (JWT ES256 vía JWKS); en `NODE_ENV=production` sin ella el proceso no arranca |
| `GEMINI_API_KEY` | opcional* | Con esta presente el backend usa **gemini** (free tier, S5) |
| `OPENAI_API_KEY` | opcional* | Clave **Groq** (compatible OpenAI) — proveedor LLM actual en Render |
| `OPENAI_BASE_URL` | no | Default `https://api.groq.com/openai/v1` |
| `CHAT_MODEL` / `LLM_MODEL` | no | Modelo LLM (groq); default `openai/gpt-oss-120b`. Con gemini es la base de ambos tiers |
| `LLM_MODEL_MAIN` | no | Modelo del tier **calidad**: sólo el call final del resumen |
| `LLM_MODEL_BULK` | no | Modelo del tier **volumen**: chunks, condensado, mindmap y preguntas |
| `LLM_PROVIDER` | no | Override explícito: `gemini` \| `groq` |
| `WHISPER_MODEL` | no | Default `small` (S4). Si la VM se queda sin RAM, bajar a `base` |
| `CORS_ORIGINS` | no | Default: `https://lecmap.app,https://www.lecmap.app,https://eltinchosf.github.io` |
| `QUOTA_AUDIO_SECONDS_PER_DAY` | no | Default `7200` (2 h, S1) |
| `SUPABASE_SERVICE_ROLE_KEY` | no | **Secret key** de Supabase (Dashboard → Settings → API). Habilita la Admin API del gestor de usuarios (`/admin/*`): sin ella esos endpoints responden 503. Solo en el `.env` de la VM — nunca en el repo, el frontend ni respuestas HTTP |

\* Hace falta al menos uno de los dos para Resumen / Mapa / ApIA.

### Enrutamiento LLM por cuota (tier main / bulk)

La cuota **free tier de Gemini es por modelo, no global**: `gemini-3.6-flash`
tiene ~20 req/día y `gemini-3.5-flash-lite` ~500 req/día, en buckets separados.
Por eso el pipeline reparte los calls:

| Tier | Modelo (`.env` actual) | Calls | Por qué |
|---|---|---|---|
| `main` | `gemini-3.6-flash` | resumen final | La longitud del resumen depende de la calidad |
| `default` (bulk) | `gemini-3.5-flash-lite` | chunks, condensado, mindmap, ApIA | Volumen; 5–21× más rápido y misma calidad de prosa |

Si no se setean `LLM_MODEL_MAIN` / `LLM_MODEL_BULK`, ambos tiers usan
`LLM_MODEL` (comportamiento anterior). Verificado en `GET /health`:
`llm.model` = tier bulk, `llm.modelMain` = tier main (sólo aparece si difiere).

## DNS

`api.lecmap.app` → **A** `2.31.197.193` (Cloudflare, modo **DNS only**, sin proxy), para que Caddy emita el certificado Let's Encrypt por HTTP-01.

## Puesta en marcha

```bash
cd deploy
# .env ya creado
docker compose up -d --build
docker compose ps          # db healthy, backend healthy, worker/caddy running
# Migraciones (una vez, contra el esquema inicial):
docker compose exec -T db psql -U lecmap -d lecmap < ../backend/supabase/migrations/001_auth_multiuser.sql
# ... repetir con 002, 003, 004
curl -s https://api.lecmap.app/health
```

## Operación

```bash
docker compose logs -f backend      # logs
docker compose restart backend      # reinicio
docker compose pull && docker compose up -d --build   # actualización desde repo
```

Los volúmenes `pgdata` (datos), `models` (caché de modelos whisper/diarize) y `uploads` (audios en tránsito) persisten reinicios.
