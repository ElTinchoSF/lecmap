# Worker de transcripción LecMap — faster-whisper + diarize (CPU).
# Base Ubuntu arm64/amd64 con Python 3.12 (la de Ubuntu 24.04 de la VM).
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Descarga perezosa de modelos: los caches viven en el volumen montado.
ENV HF_HOME=/models \
    XDG_CACHE_HOME=/models

COPY src/worker ./worker

# El worker corre detrás del backend (127.0.0.1:8080 en la VM).
EXPOSE 8080
ENV PORT=8080
CMD ["python", "-m", "worker.app"]
