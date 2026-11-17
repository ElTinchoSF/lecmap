"""Pipeline de transcripción: faster-whisper (texto) + diarize (hablantes).

Los modelos se cargan perezosamente al primer uso y se cachean: la VM free
tiene poca RAM, así que no cargamos nada hasta que llegue un pedido.
"""

import os
import subprocess

from .merge import merge_speakers

WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
# En la VM el CPU es limitado: int8 reduce mucho la memoria y va más rápido
# con calidad suficiente para clases en español.
WHISPER_COMPUTE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "es")

_faster_whisper = None
_diarize = None


def _to_wav(audio_path):
    """Normaliza a WAV 16 kHz mono para diarize/VAD.

    libsndfile (que usan diarize y silero VAD) no lee AAC/m4a y falla con
    "Format not recognised" aunque el archivo sea válido. WAV y FLAC pasan
    sin conversión; el resto se convierte con ffmpeg (instalado en la imagen).

    Devuelve (ruta_a_usar, derived_o_None): derived es la ruta a borrar
    cuando nosotros la creamos.
    """
    if audio_path.lower().endswith((".wav", ".flac")):
        return audio_path, None
    wav_path = audio_path + ".wav"
    proc = subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", audio_path,
         "-ar", "16000", "-ac", "1", wav_path],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffmpeg no pudo convertir el audio: {proc.stderr.strip()[:200]}"
        )
    return wav_path, wav_path


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
    audio_path, derived_wav = _to_wav(audio_path)
    try:
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
    finally:
        if derived_wav and os.path.exists(derived_wav):
            try:
                os.unlink(derived_wav)
            except OSError:
                pass
