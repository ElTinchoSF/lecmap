"""Merge de transcripción (whisper) + turnos de diarización → speaker real.

whisper devuelve segmentos con texto/tiempo pero sin hablante; `diarize`
devuelve turnos (start, end, speaker) sin texto. A cada segmento se le asigna
el speaker con mayor solapamiento temporal; si no hay solape (desfases típicos
de whisper), el turno cuyo fin/inicio más cerca esté.
"""

def _overlap(a_start, a_end, b_start, b_end):
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def merge_speakers(segments, turns):
    out = []
    for seg in segments:
        start = float(seg["start"])
        end = float(seg["end"])
        text = str(seg.get("text", "")).strip()
        speaker = _assign_speaker(start, end, turns)
        out.append({"start": start, "end": end, "speaker": speaker, "text": text})
    return out


def _assign_speaker(start, end, turns):
    if not turns:
        return "SPEAKER_00"

    best_speaker = None
    best_overlap = 0.0
    for t in turns:
        ov = _overlap(start, end, float(t["start"]), float(t["end"]))
        if ov > best_overlap:
            best_overlap = ov
            best_speaker = t["speaker"]

    if best_speaker is not None:
        return best_speaker

    # Sin solape: turno más cercano (por distancia del segmento al turno).
    def distance(t):
        t_start, t_end = float(t["start"]), float(t["end"])
        if end < t_start:
            return t_start - end
        if start > t_end:
            return start - t_end
        return 0.0

    return min(turns, key=distance)["speaker"]
