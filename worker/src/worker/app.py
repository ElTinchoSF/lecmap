"""API interna del worker de transcripción.

No expone auth propia: corre en la red interna de la VM y solo la llama el
backend de LecMap (se valida con WORKER_TOKEN compartido por env).
"""

import os

from flask import Flask, jsonify, request

from .pipeline import transcribe_audio

app = Flask(__name__)
# Límite de subida: 2 h de clase a 32 kbps ≈ 28 MB; margen para webm opus.
app.config["MAX_CONTENT_LENGTH"] = int(os.environ.get("WORKER_MAX_MB", "100")) * 1024 * 1024

WORKER_TOKEN = os.environ.get("WORKER_TOKEN", "")


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "lecmap-worker"})


def _authorized():
    if not WORKER_TOKEN:
        return True  # sin token configurado (dev local)
    return request.headers.get("X-Worker-Token", "") == WORKER_TOKEN


@app.post("/transcribe")
def transcribe():
    if not _authorized():
        return jsonify({"error": "token inválido"}), 401

    if "audio" not in request.files:
        return jsonify({"error": "falta el campo audio"}), 400
    f = request.files["audio"]
    if not f.filename:
        return jsonify({"error": "archivo vacío"}), 400

    suffix = os.path.splitext(f.filename)[1] or ".webm"
    tmp = None
    try:
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            f.save(tmp.name)
            tmp_path = tmp.name
        result = transcribe_audio(tmp_path)
        return jsonify(result)
    except Exception as e:  # noqa: BLE001 — el error viaja al backend para el estado error
        return jsonify({"error": str(e)}), 500
    finally:
        if tmp is not None and os.path.exists(tmp.name):
            try:
                os.unlink(tmp.name)
            except OSError:
                pass


def bind_host() -> str:
    """Interfaz de escucha: 127.0.0.1 por defecto (VM de máquina única);
    en Compose se setea HOST=0.0.0.0 para que el backend alcance al worker."""
    return os.environ.get("HOST", "127.0.0.1")


if __name__ == "__main__":
    app.run(host=bind_host(), port=int(os.environ.get("PORT", "8080")))
