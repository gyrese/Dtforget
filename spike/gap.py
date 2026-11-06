"""Choix d'un trou + extrait d'écoute + mesure de résidu vocal + score de timing.

Lister les mots alignés (index, temps) :
  python gap.py list <slug> [--sep bs_roformer] [--from 60 --to 90]
Fabriquer l'aperçu « troué » (original jusqu'à t_cut puis instrumental, fondu 80 ms) :
  python gap.py preview <slug> --first 120 --last 131 [--sep bs_roformer] [--margin 0.05]
     -> out/<slug>/preview_<first>-<last>_<sep>.wav  (8 s avant la coupure, 3 s après le trou)
     -> mesure du résidu vocal dans [t_cut-50ms, t_cut+2s] (re-séparation de la fenêtre)
Évaluer le timing contre une annotation Audacity (Fichier > Exporter les labels) :
  python gap.py eval <slug> annotations/<slug>.txt [--sep bs_roformer]
"""
from __future__ import annotations

import argparse
import difflib
import json
import statistics
from pathlib import Path

import numpy as np
import soundfile as sf

from common import OUT, dump, ffmpeg, tokenize


def load_words(slug: str, sep: str) -> list[dict]:
    d = OUT / slug
    for name in (f"words_aligned_{sep}.json", f"words_asr_{sep}.json"):
        if (d / name).exists():
            return json.loads((d / name).read_text(encoding="utf-8"))
    raise SystemExit(f"Aucun fichier de mots dans {d} (lancer pipeline.py d'abord)")


def cmd_list(a) -> None:
    for i, w in enumerate(load_words(a.slug, a.sep)):
        if a.frm <= w["start"] <= a.to:
            flag = " ?" if w["uncertain"] else ""
            print(f"{i:4d}  {w['start']:7.2f}–{w['end']:7.2f}  {w['text']}{flag}")


def envelope_db(path: Path, a: float, b: float, hop_s: float = 0.01) -> tuple[np.ndarray, float]:
    info = sf.info(path)
    x = sf.read(path, start=int(a * info.samplerate), frames=int((b - a) * info.samplerate))[0]
    x = x.mean(1) if x.ndim > 1 else x
    hop = int(info.samplerate * hop_s)
    env = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2)) for i in range(0, max(1, len(x) - hop), hop)])
    env = np.convolve(env, np.ones(5) / 5, mode="same")  # lissage 50 ms
    return 20 * np.log10(env + 1e-9), hop_s


def valley_cut(vocals: Path, prev_start: float, gap_start: float, naive: float) -> float:
    """Point de voix le plus faible dans [max(prev_start+0.15, naive-0.1), gap_start-0.03]."""
    lo, hi = max(prev_start + 0.15, naive - 0.1), gap_start - 0.03
    if hi - lo < 0.06:
        return naive
    db, hop = envelope_db(vocals, lo, hi)
    if not len(db):
        return naive
    # dernier point proche du minimum (≤ min + 3 dB) : laisse finir la note précédente au maximum
    near = np.where(db <= db.min() + 3)[0]
    return round(lo + float(near[-1]) * hop, 3)


def rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(np.square(x))) + 1e-9))


def cmd_preview(a) -> None:
    d = OUT / a.slug
    words = load_words(a.slug, a.sep)
    first, last = words[a.first], words[a.last]
    prev_end = words[a.first - 1]["end"] if a.first > 0 else max(0.0, first["start"] - 0.3)
    # t_cut (D4) : creux d'énergie de la voix isolée entre le début du mot précédent et le début du trou.
    # wav2vec2 sous-estime la fin des notes tenues : la "fin du mot précédent" seule coupe la note.
    naive_cut = min(prev_end + a.margin, first["start"] - 0.02)
    cut = valley_cut(d / f"vocals_{a.sep}.flac", words[a.first - 1]["start"] if a.first > 0 else 0.0,
                     first["start"], naive_cut)
    t0, t1 = max(0.0, cut - 8), last["end"] + 3
    orig, instr = d / "audio.wav", d / f"instrumental_{a.sep}.flac"
    out = d / f"preview_{a.first}-{a.last}_{a.sep}.wav"
    x = 0.04
    ffmpeg("-i", str(orig), "-i", str(instr), "-filter_complex",
           f"[0:a]atrim=start={t0}:end={cut + x},asetpts=PTS-STARTPTS[a];"
           f"[1:a]aresample=44100,atrim=start={cut - x}:end={t1},asetpts=PTS-STARTPTS[b];"
           f"[a][b]acrossfade=d={2 * x}[o]", "-map", "[o]", str(out))
    print(f"t_cut = {cut:.3f} s (naïf {naive_cut:.3f}, fin mot précédent {prev_end:.3f}, début trou {first['start']:.3f})")
    vdb, _ = envelope_db(d / f"vocals_{a.sep}.flac", cut - 0.01, cut + 0.03)
    print(f"Niveau voix au point de coupure : {vdb.max():.1f} dBFS")
    print(f"Trou : {a.last - a.first + 1} mots, {first['start']:.2f}–{last['end']:.2f} s")
    print(f"Extrait d'écoute : {out}  (coupure à {cut - t0:.2f} s dans l'extrait)")

    # Résidu vocal : re-séparer la fenêtre de l'instrumental et comparer à la voix d'origine
    win = d / "residue_window.wav"
    ffmpeg("-i", str(instr), "-ss", f"{max(0, cut - 0.05)}", "-t", "2.05", str(win))
    from pipeline import separate
    v_res, _ = separate(win, d / "residue", a.sep, device_cpu=False)
    res = sf.read(v_res)[0]
    vo = sf.read(d / f"vocals_{a.sep}.flac", start=int((cut - 0.05) * 44100), frames=int(2.05 * 44100))[0]
    residue_db, vocal_db = rms_db(res), rms_db(vo)
    delta = residue_db - vocal_db
    verdict = "OK (inaudible probable)" if delta < -30 else ("LIMITE" if delta < -20 else "RÉSIDU AUDIBLE")
    print(f"Résidu vocal : {residue_db:.1f} dBFS vs voix originale {vocal_db:.1f} dBFS → Δ {delta:.1f} dB : {verdict}")
    dump(d / f"gap_{a.first}-{a.last}_{a.sep}.json", {
        "first": a.first, "last": a.last, "cut_s": round(cut, 3), "gap_start_s": first["start"],
        "gap_end_s": last["end"], "residue_db": round(residue_db, 1), "vocal_db": round(vocal_db, 1),
        "residue_delta_db": round(delta, 1), "verdict": verdict})


def read_audacity(path: Path) -> list[dict]:
    out = []
    for ln in path.read_text(encoding="utf-8").splitlines():
        p = ln.split("\t")
        if len(p) >= 3 and p[0].strip() and not ln.startswith("\\"):
            out.append({"start": float(p[0]), "end": float(p[1]), "text": p[2].strip()})
    return out


def cmd_eval(a) -> None:
    truth = read_audacity(Path(a.labels))
    pred = load_words(a.slug, a.sep)
    tt = [(tokenize(w["text"]) or [""])[0] for w in truth]
    pt = [(tokenize(w["text"]) or [""])[0] for w in pred]
    sm = difflib.SequenceMatcher(a=tt, b=pt, autojunk=False)
    errs_start, errs_end, matched = [], [], 0
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            tw, pw = truth[blk.a + k], pred[blk.b + k]
            if abs(tw["start"] - pw["start"]) > 5:
                continue
            matched += 1
            errs_start.append(abs(tw["start"] - pw["start"]) * 1000)
            errs_end.append(abs(tw["end"] - pw["end"]) * 1000)
    if not errs_start:
        raise SystemExit("Aucun mot apparié : vérifier l'annotation")
    med = statistics.median(errs_start)
    p90 = sorted(errs_start)[int(0.9 * (len(errs_start) - 1))]
    r = {"truth_words": len(truth), "matched": matched, "match_pct": round(100 * matched / len(truth)),
         "start_err_median_ms": round(med), "start_err_p90_ms": round(p90),
         "end_err_median_ms": round(statistics.median(errs_end)),
         "go_timing": med <= 150}
    print(json.dumps(r, indent=2, ensure_ascii=False))
    print("Critère (a) ≤ 150 ms :", "GO" if r["go_timing"] else "NO-GO")
    dump(OUT / a.slug / f"eval_{a.sep}.json", r)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list"); p.add_argument("slug"); p.add_argument("--sep", default="bs_roformer")
    p.add_argument("--from", dest="frm", type=float, default=0); p.add_argument("--to", type=float, default=1e9)
    p = sub.add_parser("preview"); p.add_argument("slug"); p.add_argument("--first", type=int, required=True)
    p.add_argument("--last", type=int, required=True); p.add_argument("--sep", default="bs_roformer")
    p.add_argument("--margin", type=float, default=0.05)
    p = sub.add_parser("eval"); p.add_argument("slug"); p.add_argument("labels")
    p.add_argument("--sep", default="bs_roformer")
    a = ap.parse_args()
    {"list": cmd_list, "preview": cmd_preview, "eval": cmd_eval}[a.cmd](a)


if __name__ == "__main__":
    main()
