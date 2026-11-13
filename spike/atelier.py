"""Worker de l'atelier d'ajout de média (lancé par app/workshop.js).

  python atelier.py analyze <dossier> --title T --artist A   source.* -> audio, stems, paroles LRCLIB, mots alignés
  python atelier.py align   <dossier> [--lrclib ID]          réaligne sur lyrics.txt (ou sur une fiche LRCLIB)
  python atelier.py build   <dossier> --first I --last J     fabrique clip.mp3 + clip.json pour le trou choisi

Progression sur stdout : lignes « @@{json} ». Les paroles ne sont jamais écrites sur stdout, seulement
dans les fichiers du dossier (words.json, lyrics.txt, clip.json).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import requests
import soundfile as sf

from common import UA, containment, dump, ffmpeg, lrc_to_text, lrclib_candidates, probe_duration
from gap import valley_cut
from pipeline import MIN_CONTAINMENT, load_16k, separate, words_from_result

SEP = "bs_roformer"
ASR = "large-v3"
MAX_DURATION = 600.0  # 10 min
TOTAL = 60.0          # durée de l'extrait
TAIL = 5.0            # l'extrait s'arrête 5 s après la fin du passage à deviner
FADE = 0.04


def emit(**data) -> None:
    print("@@" + json.dumps(data, ensure_ascii=False), flush=True)


def clean_lyrics(text: str) -> str:
    return "\n".join(ln.strip() for ln in text.replace("\r", "").split("\n") if ln.strip())


def load_model():
    import stable_whisper
    return stable_whisper.load_faster_whisper(ASR, device="cuda", compute_type="int8_float16")


def align_and_save(d: Path, model, vocals16k, text: str, lang: str) -> int:
    """Alignement forcé ; chaque mot garde l'indice de sa ligne de paroles."""
    result = model.align(vocals16k, text, language=lang, original_split=True)
    words = []
    for li, seg in enumerate(result.segments):
        for w in seg.words or []:
            x = w.word.strip()
            if not x:
                continue
            prob = float(getattr(w, "probability", 1.0) or 0.0)
            words.append({"text": x, "start": round(float(w.start), 3), "end": round(float(w.end), 3),
                          "line": li, "uncertain": bool(prob < 0.45)})
    dump(d / "words.json", words)
    (d / "lyrics.txt").write_text(text, encoding="utf-8")
    return len(words)


def cmd_analyze(a) -> None:
    d = Path(a.dir)
    src = next(p for p in d.iterdir() if p.stem == "source")
    emit(step="audio")
    wav = d / "audio.wav"
    ffmpeg("-i", str(src), "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(wav))
    dur = probe_duration(wav)
    if dur > MAX_DURATION:
        raise SystemExit("Ce média dépasse 10 minutes.")
    if dur < 20:
        raise SystemExit("Ce média est trop court.")

    emit(step="lyrics_search")
    cands = lrclib_candidates(a.title, dur, [a.artist], extra_queries=[f"{a.artist} {a.title}".strip()])

    emit(step="separate")
    v_path, _ = separate(wav, d, SEP, False)
    shutil.rmtree(d / f"sep_{SEP}", ignore_errors=True)

    emit(step="listen")
    model = load_model()
    vocals16k = load_16k(v_path)
    res = model.transcribe(vocals16k, language=None, word_timestamps=True, vad=True,
                           condition_on_previous_text=False, beam_size=5)
    lang = getattr(res, "language", None) or "fr"
    if len(lang) > 3:  # « french » -> « fr »
        from whisper.tokenizer import TO_LANGUAGE_CODE
        lang = TO_LANGUAGE_CODE.get(lang.lower(), "fr")
    words_asr = words_from_result(res)
    dump(d / "words_asr.json", words_asr)
    asr_text = " ".join(w["text"] for w in words_asr if not w["hallucination"])

    # Meilleure fiche LRCLIB : celle dont le texte recouvre le mieux ce que Whisper entend
    best, best_c, best_ref = 0.0, None, None
    for c in cands:
        ref = lrc_to_text(c["syncedLyrics"]) if c.get("syncedLyrics") else c.get("plainLyrics")
        if not ref:
            continue
        score = containment(asr_text, ref)
        if abs(c["duration"] - dur) > 5 and score < 0.5:  # autre version : l'atelier affiche les paroles, on vérifie à l'œil
            continue
        if score > best:
            best, best_c, best_ref = score, c, ref
    info = {"duration": round(dur, 2), "language": lang, "lyrics": None, "candidates": len(cands)}
    if best_c and best >= MIN_CONTAINMENT:
        emit(step="align")
        n = align_and_save(d, model, vocals16k, clean_lyrics(best_ref), lang)
        info["lyrics"] = {"source": "lrclib", "id": best_c["id"], "match": round(best, 2), "words": n,
                          "track": best_c.get("trackName"), "artist": best_c.get("artistName")}
    dump(d / "info.json", info)
    emit(done=True, lyrics=bool(info["lyrics"]))


def cmd_align(a) -> None:
    d = Path(a.dir)
    info = json.loads((d / "info.json").read_text(encoding="utf-8"))
    if a.lrclib:
        emit(step="lyrics_search")
        r = requests.get(f"https://lrclib.net/api/get/{int(a.lrclib)}", headers={"User-Agent": UA}, timeout=20)
        r.raise_for_status()
        c = r.json()
        text = lrc_to_text(c["syncedLyrics"]) if c.get("syncedLyrics") else (c.get("plainLyrics") or "")
        source = {"source": "lrclib", "id": c["id"], "track": c.get("trackName"), "artist": c.get("artistName")}
    else:
        text = (d / "lyrics_input.txt").read_text(encoding="utf-8-sig")
        source = {"source": "pasted"}
    text = clean_lyrics(text)
    if len(text.split()) < 5:
        raise SystemExit("Ces paroles sont vides ou trop courtes.")
    emit(step="align")
    model = load_model()
    n = align_and_save(d, model, load_16k(d / f"vocals_{SEP}.flac"), text, info.get("language") or "fr")
    info["lyrics"] = {**source, "words": n}
    dump(d / "info.json", info)
    emit(done=True, lyrics=True)


def cmd_build(a) -> None:
    d = Path(a.dir)
    emit(step="build")
    words = json.loads((d / "words.json").read_text(encoding="utf-8"))
    first, last = a.first, a.last
    if not 0 <= first <= last < len(words):
        raise SystemExit("Passage invalide.")
    vocals = d / f"vocals_{SEP}.flac"
    fw, lw = words[first], words[last]
    pw = words[first - 1] if first > 0 else None
    prev_end = pw["end"] if pw else max(0.0, fw["start"] - 0.3)
    naive = max(0.0, min(prev_end + 0.05, fw["start"] - 0.02))
    # coupure au creux d'énergie de la voix isolée, juste avant le premier mot à deviner
    cut = valley_cut(vocals, pw["start"] if pw else max(0.0, fw["start"] - 1.0), fw["start"], naive)

    orig, sr = sf.read(d / "audio.wav", dtype="float32")
    instr, sr2 = sf.read(d / f"instrumental_{SEP}.flac", dtype="float32")
    if sr != sr2:
        raise SystemExit("Fréquences d'échantillonnage différentes.")
    n = min(len(orig), len(instr))
    orig, instr = orig[:n], instr[:n]
    total = n / sr

    # la voix reste coupée jusqu'au mot suivant (les notes tenues dépassent la fin alignée)
    nxt = words[last + 1]["start"] if last + 1 < len(words) else total
    hole_end = max(lw["end"] + 0.05, min(nxt - 0.05, lw["end"] + 3.0))
    t1 = min(total, lw["end"] + TAIL)
    hole_end = min(hole_end, t1)
    # l'extrait dure TOTAL secondes et finit TAIL secondes après le passage ; le début se cale
    # sur un début de ligne s'il y en a un à moins de 4 s
    t0 = max(0.0, t1 - TOTAL)
    starts = [w["start"] for i, w in enumerate(words)
              if (i == 0 or words[i - 1]["line"] != w["line"]) and abs(w["start"] - 1.5 - t0) <= 4]
    if starts and t0 > 0:
        t0 = max(0.0, min(starts, key=lambda x: abs(x - 1.5 - t0)) - 1.5)

    i0, i1 = int(t0 * sr), int(t1 * sr)
    t = np.arange(i0, i1) / sr
    mask = np.minimum(np.clip((t - (cut - FADE)) / FADE, 0, 1), np.clip(((hole_end + FADE) - t) / FADE, 0, 1))
    gain = np.minimum(np.clip((t - t0) / 0.3, 0, 1) if t0 > 0 else 1.0, np.clip((t1 - t) / 0.6, 0, 1))
    if orig.ndim == 2:
        mask, gain = mask[:, None], (gain[:, None] if isinstance(gain, np.ndarray) else gain)
    out = (orig[i0:i1] * (1 - mask) + instr[i0:i1] * mask) * gain
    tmp = d / "clip_tmp.wav"
    sf.write(tmp, out, sr, subtype="PCM_16")
    ffmpeg("-i", str(tmp), "-c:a", "libmp3lame", "-b:a", "192k", str(d / a.out))
    tmp.unlink()

    sel = [(i, w) for i, w in enumerate(words) if t0 - 0.2 <= w["start"] <= t1]
    dump(d / "clip.json", {
        "cutAt": round(cut - t0, 3),
        "words": [{"t": round(max(0.0, w["start"] - t0), 3), "e": round(w["end"] - t0, 3), "x": w["text"],
                   "gap": first <= i <= last} for i, w in sel],
        "answer": " ".join(w["text"] for w in words[first:last + 1]),
    })
    emit(done=True, cutAt=round(cut - t0, 3), duration=round(t1 - t0, 2))


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze"); p.add_argument("dir"); p.add_argument("--title", default="")
    p.add_argument("--artist", default="")
    p = sub.add_parser("align"); p.add_argument("dir"); p.add_argument("--lrclib")
    p = sub.add_parser("build"); p.add_argument("dir"); p.add_argument("--first", type=int, required=True)
    p.add_argument("--last", type=int, required=True); p.add_argument("--out", default="clip.mp3")
    a = ap.parse_args()
    try:
        {"analyze": cmd_analyze, "align": cmd_align, "build": cmd_build}[a.cmd](a)
    except SystemExit as e:
        if isinstance(e.code, str):
            emit(error=e.code)
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
