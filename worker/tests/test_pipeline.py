# Tests de normalización de audio (_to_wav): libsndfile no lee AAC/m4a.
import shutil
import subprocess
import wave

import pytest

from worker.pipeline import _to_wav


def test_to_wav_wav_pasa_sin_conversion(tmp_path):
    p = tmp_path / "clase.wav"
    p.write_bytes(b"RIFF....")
    ruta, derived = _to_wav(str(p))
    assert ruta == str(p)
    assert derived is None


def test_to_wav_flac_pasa_sin_conversion(tmp_path):
    p = tmp_path / "clase.flac"
    p.write_bytes(b"fLaC")
    ruta, derived = _to_wav(str(p))
    assert ruta == str(p)
    assert derived is None


def _escribir_sine_wav(path, segundos=1, sr=16000):
    import math
    import struct

    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        frames = b"".join(
            struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
            for i in range(sr * segundos)
        )
        w.writeframes(frames)


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg no está en el host")
def test_to_wav_convierte_m4a_y_resultado_es_legible(tmp_path):
    import soundfile as sf

    wav_orig = tmp_path / "orig.wav"
    _escribir_sine_wav(wav_orig)
    m4a = tmp_path / "clase.m4a"
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(wav_orig), str(m4a)],
        check=True,
    )
    # El m4a NO es legible para soundfile (la causa del bug original):
    with pytest.raises(Exception):
        sf.read(str(m4a))

    ruta, derived = _to_wav(str(m4a))
    assert derived == ruta and ruta.endswith(".wav")
    data, sr = sf.read(ruta)
    assert sr == 16000 and len(data) > 0
    # el wav derivado se limpia con el finally de transcribe_audio; acá lo
    # borramos nosotros para no dejar residuos en el tmp del test.
    import os
    os.unlink(derived)
