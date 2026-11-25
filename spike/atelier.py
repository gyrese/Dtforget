"""Worker de l'atelier d'ajout de média (lancé par app/workshop.js).

  python atelier.py analyze <dossier> --title T --artist A   source.* -> audio, stems, paroles LRCLIB, mots alignés
  python atelier.py align   <dossier> [--lrclib ID]          réaligne sur lyrics.txt (ou sur une fiche LRCLIB)
  python atelier.py build   <dossier> --first I --last J [--start S --end E --cut C]  fabrique clip.mp3 + clip.json pour le trou choisi
                            [--anchor-word K --anchor-at T]  réaligne d'abord les paroles : la ligne du mot K commence à T s
  python atelier.py repair  <dossier>                       répare words.json (sans carte graphique) à l'aide de words_asr.json

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
from repair import norm, repair

SEP = "bs_roformer"
ASR = "large-v3"
MAX_DURATION = 600.0  # 10 min
TOTAL = 60.0          # durée de l'extrait
TAIL = 5.0            # le début de l'extrait se cale comme si celui-ci finissait 5 s après le passage
FADE = 0.04
ANSWER_TAIL = 5.0     # après la coupure : instrumental seul jusqu'à 5 s après la fin du passage, puis le chrono
REVEAL_LEAD = 10.0    # révélation : on reprend 10 s avant le passage à deviner…
REVEAL_TAIL = 10.0    # … et on chante le passage puis 10 s de la suite
GAP = 1.0             # silence entre la partie jeu et la partie révélation (même fichier)
MAX_INTRO = 15.0      # l'extrait commence au plus 15 s avant les premières paroles affichées


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
    dump(d / "words_forced.json", words)
    (d / "lyrics.txt").write_text(text, encoding="utf-8")
    fix_alignment(d, words)
    return len(words)


def fix_alignment(d: Path, words: list[dict], anchors: dict[int, float] | None = None) -> None:
    """Recale les paroles sur ce que Whisper entend (words.json) et garde à part le chant hors paroles (heard.json)."""
    asr_file = d / "words_asr.json"
    asr = json.loads(asr_file.read_text(encoding="utf-8")) if asr_file.exists() else []
    fixed, heard, stats = repair(words, asr, anchors, probe_duration(d / "audio.wav"))
    dump(d / "words.json", fixed)
    dump(d / "heard.json", heard)
    emit(repair=stats)


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
    if a.anchor_word is not None:
        if not 0 <= a.anchor_word < len(words) or a.anchor_at is None or a.anchor_at < 0:
            raise SystemExit("Calage de la première ligne invalide.")
        words = realign_from(d, words, a.anchor_word, a.anchor_at)
    if a.word_times:
        # lignes recalées à la main en tapant pendant l'écoute : [indice, début, fin] dans la chanson ;
        # gardées dans words.json pour que les autres passages de la chanson en profitent
        for i, start, end in json.loads(Path(a.word_times).read_text(encoding="utf-8")):
            if 0 <= int(i) < len(words) and 0 <= float(start) <= float(end):
                words[int(i)] = {**words[int(i)], "start": round(float(start), 3), "end": round(float(end), 3), "uncertain": False}
        dump(d / "words.json", words)
    orig, sr = sf.read(d / "audio.wav", dtype="float32")
    instr, sr2 = sf.read(d / f"instrumental_{SEP}.flac", dtype="float32")
    if sr != sr2:
        raise SystemExit("Fréquences d'échantillonnage différentes.")
    n = min(len(orig), len(instr))
    orig, instr = orig[:n], instr[:n]
    total = n / sr

    offset = a.lyrics_offset or 0.0
    if not -total <= offset <= total:
        raise SystemExit("Le passage à deviner doit rester dans la chanson.")
    if offset:
        if words[first]["start"] + offset < 0 or words[last]["end"] + offset > max(total, words[last]["end"]) + 0.01:
            raise SystemExit("Le passage à deviner doit rester dans la chanson.")
        words = [{**w, "start": w["start"] + offset, "end": w["end"] + offset} for w in words]
    fw, lw = words[first], words[last]
    if a.cut is not None and a.lyrics_offset is not None:
        cut = max(0.0, min(a.cut, total, lw["end"]))
    else:
        pw = words[first - 1] if first > 0 else None
        prev_start = max(0.0, pw["start"] if pw else fw["start"] - 1.0)
        prev_end = pw["end"] if pw else max(0.0, fw["start"] - 0.3)
        naive = max(0.0, min(prev_end + 0.05, fw["start"] - 0.02))
        # Coupure au creux d'énergie de la voix isolée, juste avant le premier mot à deviner.
        cut = valley_cut(d / f"vocals_{SEP}.flac", prev_start, fw["start"], naive)
        if a.cut is not None:
            cut = round(min(max(0.0, cut - 3.0, a.cut), cut + 3.0, lw["end"]), 3)

    t1 = min(total, lw["end"] + TAIL)
    # l'extrait dure TOTAL secondes et finit TAIL secondes après le passage ; le début se cale
    # sur un début de ligne s'il y en a un à moins de 4 s
    t0 = max(0.0, t1 - TOTAL)
    starts = [w["start"] for i, w in enumerate(words)
              if (i == 0 or words[i - 1]["line"] != w["line"]) and abs(w["start"] - 1.5 - t0) <= 4]
    if starts and t0 > 0:
        t0 = max(0.0, min(starts, key=lambda x: abs(x - 1.5 - t0)) - 1.5)
    if a.start is not None:  # début choisi à la main : au moins 2 s avant la coupure
        t0 = min(max(0.0, a.start), max(0.0, cut - 2.0))
    t0 = min(t0, max(0.0, fw["start"]))
    # chant entendu hors des paroles (intro parlée, couplet absent de la fiche) : affiché aussi, jamais à deviner
    heard_file = d / "heard.json"
    heard = json.loads(heard_file.read_text(encoding="utf-8")) if heard_file.exists() else []
    extra = [(f"h{k}-{j}", {**h, "start": h["start"] + offset, "end": h["end"] + offset})
             for k, g in enumerate(heard) for j, h in enumerate(g)]
    # pas de longue intro muette : au plus MAX_INTRO secondes de musique avant le premier mot affiché
    shown = [w["start"] for w in words[:last + 1] if w["start"] >= t0 - 0.2]
    shown += [h["start"] for _, h in extra if t0 - 0.2 <= h["start"] < fw["start"]]
    if shown and min(shown) - t0 > MAX_INTRO:
        t0 = round(min(shown) - MAX_INTRO, 3)

    def col(x):
        return x[:, None] if orig.ndim == 2 else x

    # partie jeu : chant original jusqu'à la coupure, puis l'instrumental seul (la voix ne revient pas)
    b1 = min(total, lw["end"] + ANSWER_TAIL)
    if a.end is not None:  # fin choisie à la main : jamais avant la fin du passage à deviner
        b1 = min(total, max(cut + 1.0, lw["end"] + 0.5, a.end))
    i0, i1 = int(t0 * sr), int(b1 * sr)
    t = np.arange(i0, i1) / sr
    mask = np.clip((t - (cut - FADE)) / FADE, 0, 1)
    gain = np.minimum(np.clip((t - t0) / 0.3, 0, 1) if t0 > 0 else 1.0, np.clip((b1 - t) / 1.5, 0, 1))
    play = (orig[i0:i1] * col(1 - mask) + instr[i0:i1] * col(mask)) * col(gain)

    # partie révélation : chant original de 10 s avant le passage jusqu'à 10 s après
    r0, r1 = max(0.0, cut - REVEAL_LEAD), min(total, lw["end"] + REVEAL_TAIL)
    j0, j1 = int(r0 * sr), int(r1 * sr)
    t = np.arange(j0, j1) / sr
    gain = np.minimum(np.clip((t - r0) / 0.3, 0, 1) if r0 > 0 else 1.0, np.clip((r1 - t) / 1.0, 0, 1))
    rev = orig[j0:j1] * col(gain)

    silence = np.zeros((int(GAP * sr),) + orig.shape[1:], dtype=orig.dtype)
    out = np.concatenate([play, silence, rev])
    reveal_at = round((len(play) + len(silence)) / sr, 3)
    tmp = d / "clip_tmp.wav"
    sf.write(tmp, out, sr, subtype="PCM_16")
    ffmpeg("-i", str(tmp), "-c:a", "libmp3lame", "-b:a", "192k", str(d / a.out))
    tmp.unlink()

    # à l'écran : les paroles jusqu'au trou, rien après (la suite n'est plus chantée)
    sel = [(i, w) for i, w in enumerate(words[:last + 1]) if t0 - 0.2 <= w["start"] and w["end"] >= t0]
    sel += [(key, h) for key, h in extra if t0 - 0.2 <= h["start"] and h["end"] <= fw["start"] - 0.05]
    sel.sort(key=lambda x: x[1]["start"])
    dump(d / "clip.json", {
        "cutAt": round(cut - t0, 3),
        "revealAt": reveal_at,
        "bedEnd": round(b1 - t0, 3),
        "sourceEnd": round(b1, 3),
        "sourceStart": round(t0, 3),
        "sourceRevealStart": round(r0, 3),
        "lyricsOffset": offset,
        "revealDur": round(r1 - r0, 3),
        "words": [{"t": round(max(0.0, w["start"] - t0), 3), "e": round(w["end"] - t0, 3), "x": w["text"], "sourceIndex": i,
                   "gap": isinstance(i, int) and first <= i <= last, **({"heard": True} if isinstance(i, str) else {})}
                  for i, w in sel],
        "answer": " ".join(w["text"] for w in words[first:last + 1]),
    })
    emit(done=True, cutAt=round(cut - t0, 3), duration=round(len(out) / sr, 2))


def realign_from(d: Path, words: list[dict], k: int, at: float) -> list[dict]:
    """La ligne du mot k commence à « at » (tapé à l'oreille) : on réaligne les paroles de part et d'autre
    de ce repère, puis on répare comme d'habitude. Mêmes mots, mêmes indices ; words.json est mis à jour."""
    from difflib import SequenceMatcher
    emit(step="align")
    info = json.loads((d / "info.json").read_text(encoding="utf-8"))
    lang = info.get("language") or "fr"
    k0 = next(i for i, w in enumerate(words) if w["line"] == words[k]["line"])  # premier mot de la ligne
    model = load_model()
    vocals = load_16k(d / f"vocals_{SEP}.flac")
    sr = 16000
    out = [dict(w, uncertain=True) for w in words]

    def align_part(idx: list[int], t0: float, t1: float) -> None:
        if not idx or t1 - t0 < 0.5:
            return
        lines: dict[int, list[int]] = {}
        for i in idx:
            lines.setdefault(words[i]["line"], []).append(i)
        text = "\n".join(" ".join(words[i]["text"] for i in ix) for ix in lines.values())
        res = model.align(vocals[int(t0 * sr):int(t1 * sr)], text, language=lang, original_split=True)
        got = [(w.word.strip(), float(w.start) + t0, float(w.end) + t0, float(getattr(w, "probability", 1.0) or 0.0))
               for seg in res.segments for w in (seg.words or []) if w.word.strip()]
        sm = SequenceMatcher(None, [norm(words[i]["text"]) for i in idx], [norm(g[0]) for g in got], autojunk=False)
        for blk in sm.get_matching_blocks():
            for j in range(blk.size):
                i, (_, s, e, p) = idx[blk.a + j], got[blk.b + j]
                out[i] = {**words[i], "start": round(s, 3), "end": round(e, 3), "uncertain": p < 0.45}

    total = len(vocals) / sr
    align_part(list(range(0, k0)), 0.0, at)
    align_part(list(range(k0, len(words))), max(0.0, at - 0.15), total)
    out[k0] = {**out[k0], "start": round(at, 3), "end": round(max(at + 0.1, out[k0]["end"]), 3), "uncertain": False}
    fix_alignment(d, out, anchors={k0: at})
    return json.loads((d / "words.json").read_text(encoding="utf-8"))


def cmd_repair(a) -> None:
    d = Path(a.dir)
    src = d / "words_forced.json"
    if not src.exists():  # chanson analysée avant la réparation : l'alignement d'origine est gardé à côté
        shutil.copyfile(d / "words.json", src)
    fix_alignment(d, json.loads(src.read_text(encoding="utf-8")))
    emit(done=True)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze"); p.add_argument("dir"); p.add_argument("--title", default="")
    p.add_argument("--artist", default="")
    p = sub.add_parser("align"); p.add_argument("dir"); p.add_argument("--lrclib")
    p = sub.add_parser("build"); p.add_argument("dir"); p.add_argument("--first", type=int, required=True)
    p.add_argument("--last", type=int, required=True); p.add_argument("--out", default="clip.mp3")
    p.add_argument("--start", type=float); p.add_argument("--end", type=float); p.add_argument("--cut", type=float)
    p.add_argument("--lyrics-offset", type=float); p.add_argument("--word-times")
    p.add_argument("--anchor-word", type=int); p.add_argument("--anchor-at", type=float)
    p = sub.add_parser("repair"); p.add_argument("dir")
    a = ap.parse_args()
    try:
        {"analyze": cmd_analyze, "align": cmd_align, "build": cmd_build, "repair": cmd_repair}[a.cmd](a)
    except SystemExit as e:
        if isinstance(e.code, str):
            emit(error=e.code)
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
