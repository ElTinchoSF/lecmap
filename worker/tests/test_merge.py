# Tests del merge: transcripción de whisper + turnos de diarización →
# segmentos con speaker real. Lógica pura, sin modelos (se corre local).
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from worker.merge import merge_speakers  # noqa: E402


def seg(start, end, text):
    return {"start": start, "end": end, "text": text}


def turn(start, end, speaker):
    return {"start": start, "end": end, "speaker": speaker}


def test_segmento_cae_en_un_solo_turno():
    segments = [seg(0.0, 4.0, "Buenos días clase")]
    turns = [turn(0.0, 5.0, "S0")]
    out = merge_speakers(segments, turns)
    assert out[0]["speaker"] == "S0"


def test_overlap_mayoritario_determina_speaker():
    # Segmento que cruza dos turnos: 2 s con S0, 1 s con S1 → S0 gana.
    segments = [seg(0.0, 3.0, "texto cruzado")]
    turns = [turn(0.0, 2.0, "S0"), turn(2.0, 4.0, "S1")]
    out = merge_speakers(segments, turns)
    assert out[0]["speaker"] == "S0"


def test_dos_hablantes_alternan():
    segments = [seg(0.0, 2.0, "una pregunta"), seg(2.0, 4.0, "buena pregunta")]
    turns = [turn(0.0, 2.0, "S1"), turn(2.0, 4.0, "S0")]
    out = merge_speakers(segments, turns)
    assert out[0]["speaker"] == "S1"
    assert out[1]["speaker"] == "S0"


def test_segmento_sin_overlap_usa_turno_mas_cercano():
    # Whisper a veces genera segmentos ligeramente desfasados.
    segments = [seg(5.0, 7.0, "suelto")]
    turns = [turn(0.0, 4.0, "S0"), turn(8.0, 10.0, "S1")]
    out = merge_speakers(segments, turns)
    assert out[0]["speaker"] == "S0"  # fin del segmento más cerca de S0


def test_sin_turnos_fallback_un_speaker():
    segments = [seg(0.0, 1.0, "solo")]
    out = merge_speakers(segments, [])
    assert out[0]["speaker"] == "SPEAKER_00"


def test_campos_preservados():
    segments = [seg(1.25, 3.5, " hola ")]
    turns = [turn(1.0, 4.0, "S0")]
    out = merge_speakers(segments, turns)
    assert out[0]["start"] == 1.25
    assert out[0]["end"] == 3.5
    assert out[0]["text"] == "hola"  # trim aplicado
