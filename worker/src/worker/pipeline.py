"""Pipeline de transcripción: faster-whisper (texto) + diarize (hablantes).

Los modelos se cargan perezosamente al primer uso y se cachean: la VM free
tiene poca RAM, así que no cargamos nada hasta que llegue un pedido.
"""

import os
import tempfile

from .merge import merge_speakers

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
# En la VM el CPU es limitado: int8 reduce mucho la memoria y va más rápido
# con calidad suficiente para clases en español.
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "es")

_faster_whisper = None
_diarize = None


def _load_faster_whisper():
    global _faster_whisper
    if _faster_whisper is None:
        from faster_whisper import WhisperModel

        _faster_whisper = WhisperModel(
            WHISPER_MODEL, device="cpu", compute_type=WHISPER_COMPUTE,
        )
    return _faster_whisper


def _load_diarize():
    global _diarize
    if _diarize is None:
        from diarize import diarize as diarize_fn

        _diarize = diarize_fn
    return _diarize


def transcribe_audio(audio_path):
    """audio_path → lista de segmentos {start, end, speaker, text}.

    Primero diariza (necesita el audio completo), luego transcribe con
    timestamps y mergea por solape temporal.
    """
    diarize_fn = _load_diarize()
    result = diarize_fn(audio_path)
    turns = [
        {"start": s.start, "end": s.end, "speaker": str(s.speaker)}
        for s in result.segments
    ]

    model = _load_faster_whisper()
    whisper_segments, info = model.transcribe(
        audio_path, language=WHISPER_LANGUAGE, vad_filter=True,
    )
    segments = [
        {"start": s.start, "end": s.end, "text": s.text}
        for s in whisper_segments
    ]

    return {
        "segments": merge_speakers(segments, turns),
        "language": getattr(info, "language", WHISPER_LANGUAGE),
        "duration": getattr(info, "duration", None),
        "num_speakers": len({t["speaker"] for t in turns}),
    }
