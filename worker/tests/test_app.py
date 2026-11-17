# Tests de la API del worker con el pipeline mockeado (sin modelos).
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker import app as app_module  # noqa: E402

client = app_module.app.test_client()


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.get_json() == {"ok": True, "service": "lecmap-worker"}


def test_transcribe_sin_audio_devuelve_400():
    res = client.post("/transcribe")
    assert res.status_code == 400
    assert "audio" in res.get_json()["error"]


def test_transcribe_ok(monkeypatch):
    def fake_pipeline(path):
        assert os.path.exists(path)
        return {
            "segments": [{"start": 0.0, "end": 1.0, "speaker": "S0", "text": "hola"}],
            "language": "es",
            "duration": 1.0,
            "num_speakers": 1,
        }

    monkeypatch.setattr(app_module, "transcribe_audio", fake_pipeline)
    res = client.post(
        "/transcribe",
        data={"audio": (open(__file__, "rb"), "clase.webm")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 200
    body = res.get_json()
    assert body["segments"][0]["speaker"] == "S0"
    assert body["num_speakers"] == 1


def test_transcribe_error_pipeline_devuelve_500(monkeypatch):
    def boom(path):
        raise RuntimeError("modelo caído")

    monkeypatch.setattr(app_module, "transcribe_audio", boom)
    res = client.post(
        "/transcribe",
        data={"audio": (open(__file__, "rb"), "x.webm")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 500
    assert "modelo caído" in res.get_json()["error"]


def test_auth_token_requerido_si_configurado(monkeypatch):
    monkeypatch.setattr(app_module, "WORKER_TOKEN", "secreto")
    res = client.post(
        "/transcribe",
        data={"audio": (open(__file__, "rb"), "x.webm")},
        content_type="multipart/form-data",
    )
    assert res.status_code == 401

    res_ok = client.post(
        "/transcribe",
        headers={"X-Worker-Token": "secreto"},
        data={"audio": (open(__file__, "rb"), "x.webm")},
        content_type="multipart/form-data",
    )
    # Pasó la auth (500 por el pipeline real, no 401) — la auth es lo que testeamos.
    assert res_ok.status_code != 401


def test_bind_host_default_y_override(monkeypatch):
    """HOST controla la interfaz de escucha (T10: en Compose debe ser 0.0.0.0)."""
    from worker.app import bind_host

    monkeypatch.delenv("HOST", raising=False)
    assert bind_host() == "127.0.0.1"
    monkeypatch.setenv("HOST", "0.0.0.0")
    assert bind_host() == "0.0.0.0"
