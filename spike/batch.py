"""Traitement par lot + évaluation automatique (sans afficher les paroles).

Fichiers attendus dans songs/ : « FILM - Titre.mp3 ». Artiste LRCLIB par défaut : « Disney ».
  python batch.py [--artist Disney] [--only "Roi Lion"] [--redo]
Pour chaque titre : pipeline.py, puis choix auto de 2 trous (phrases de 5 à 12 mots sans mot incertain,
précédées d'une respiration), coupure au creux d'énergie, mesure de l'écart d'onset et du résidu vocal,
extraits d'écoute dans out/ECOUTE/. Synthèse : out/batch_summary.json + tableau Markdown affiché.
"""
from __future__ import annotations

import argparse
import difflib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

from common import OUT, ROOT, dump, ffmpeg, slugify, tokenize
from gap import envelope_db, valley_cut

SEP = "bs_roformer"
EXT = {".mp3", ".m4a", ".flac", ".wav", ".mp4", ".webm", ".mkv", ".ogg"}


def phrases(words: list[dict], pause: float = 0.35) -> list[list[int]]:
    out, cur = [], [0]
    for i in range(1, len(words)):
        if words[i]["start"] - words[i - 1]["end"] > pause or words[i - 1]["text"].rstrip()[-1:] in ".?!,":
            out.append(cur)
            cur = []
        cur.append(i)
    out.append(cur)
    return out


def ranked_gaps(words: list[dict]) -> list[tuple[int, int]]:
    """Tous les trous candidats, classés par proximité avec le tiers puis le 2/3 du morceau (alternance)."""
    cands = []
    dur = words[-1]["end"] if words else 0
    for p in phrases(words):
        if not 4 <= len(p) <= 14 or p[0] == 0:
            continue
        ws = [words[i] for i in p]
        if sum(w["uncertain"] for w in ws) > 1 or ws[0]["start"] < 8:
            continue
        span = ws[-1]["end"] - ws[0]["start"]
        if not 1.5 <= span <= 12 or max(w["end"] - w["start"] for w in ws) > 4:
            continue
        cands.append((p[0], p[-1], ws[0]["start"]))
    queues = [sorted(cands, key=lambda c: abs(c[2] - t)) for t in (dur / 3, 2 * dur / 3)]
    out, seen = [], set()
    for k in range(max((len(q) for q in queues), default=0)):
        for q in queues:
            if k < len(q) and q[k][:2] not in seen:
                seen.add(q[k][:2])
                out.append(q[k][:2])
    return out


SILENCE_DB = -40.0  # au point de coupure, la voix isolée doit être sous ce niveau, sinon on change de trou
PAUSE_S = 0.1       # option A : silence réel d'au moins 0,1 s juste avant le premier mot du trou
PAUSE_DB = 0.0      # test de pause désactivé (0 dB = toujours vrai) : la garantie est la voix < SILENCE_DB à la coupure


def real_pause_before(vocals: Path, t: float) -> bool:
    """Vrai si la voix isolée est sous SILENCE_DB pendant PAUSE_S secondes juste avant t."""
    if t < PAUSE_S + 0.1:
        return False
    db, _ = envelope_db(vocals, t - PAUSE_S - 0.1, t - 0.05)
    return bool(db.max() < PAUSE_DB)


def measure_gap(d: Path, words: list[dict], first: int, last: int) -> dict:
    vocals, instr, orig = d / f"vocals_{SEP}.flac", d / f"instrumental_{SEP}.flac", d / "audio.wav"
    fw, lw, pw = words[first], words[last], words[first - 1]
    naive = min(pw["end"] + 0.05, fw["start"] - 0.02)
    cut = valley_cut(vocals, pw["start"], fw["start"], naive)
    # onset réel du chant après la coupure (> -35 dBFS)
    env, hop = envelope_db(vocals, cut, min(cut + 3, lw["end"] + 1))
    above = np.where(env > -35)[0]
    onset = cut + float(above[0]) * hop if len(above) else None
    lvl_cut = float(envelope_db(vocals, cut - 0.01, cut + 0.03)[0].max())
    # fuite : la voix dépasse-t-elle -35 dBFS dans les 40 ms avant le début aligné, alors que la coupure est avant ?
    # résidu : énergie dans l'instrumental vs voix, fenêtre [cut-50ms, cut+2s] (proxy rapide, sans re-séparation)
    win_v = envelope_db(vocals, cut - 0.05, cut + 2)[0]
    margin_ms = round((onset - cut) * 1000) if onset is not None else None
    # extrait d'écoute
    t0, t1, x = max(0.0, cut - 8), lw["end"] + 3, 0.04
    listen = OUT / "ECOUTE" / f"{d.name}__{first}-{last}.wav"
    listen.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg("-i", str(orig), "-i", str(instr), "-filter_complex",
           f"[0:a]atrim=start={t0}:end={cut + x},asetpts=PTS-STARTPTS[a];"
           f"[1:a]aresample=44100,atrim=start={cut - x}:end={t1},asetpts=PTS-STARTPTS[b];"
           f"[a][b]acrossfade=d={2 * x}[o]", "-map", "[o]", str(listen))
    return {"first": first, "last": last, "words": last - first + 1, "at": f"{int(fw['start'] // 60)}:{int(fw['start'] % 60):02d}",
            "cut_s": round(cut, 3), "aligned_start_s": fw["start"],
            "onset_err_ms": round((onset - fw["start"]) * 1000) if onset is not None else None,
            "margin_cut_to_voice_ms": margin_ms, "voice_at_cut_db": round(lvl_cut, 1),
            "voice_peak_window_db": round(float(win_v.max()), 1), "listen": listen.name}


def agreement(d: Path) -> dict:
    al = json.loads((d / f"words_aligned_{SEP}.json").read_text(encoding="utf-8"))
    asr = json.loads((d / f"words_asr_{SEP}.json").read_text(encoding="utf-8"))
    a = [(tokenize(x["text"]) or [""])[0] for x in al]
    b = [(tokenize(x["text"]) or [""])[0] for x in asr]
    sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
    errs = sorted(abs(al[blk.a + k]["start"] - asr[blk.b + k]["start"]) * 1000
                  for blk in sm.get_matching_blocks() for k in range(blk.size))
    return {"wer_proxy_pct": round(100 * (1 - sm.ratio())),
            "agree_median_ms": round(errs[len(errs) // 2]) if errs else None,
            "agree_p90_ms": round(errs[int(0.9 * (len(errs) - 1))]) if errs else None}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--artist", default="Disney")
    ap.add_argument("--only")
    ap.add_argument("--redo", action="store_true")
    a = ap.parse_args()
    import csv
    entries = []
    if (ROOT / "songs.csv").exists():
        for r in csv.reader(open(ROOT / "songs.csv", encoding="utf-8"), delimiter=";"):
            if r and not r[0].startswith("#") and (ROOT / "songs" / r[0]).exists():
                entries.append((ROOT / "songs" / r[0], r[1].strip(), r[2].strip(),
                                (r[3].strip() if len(r) > 3 and r[3].strip() else a.artist)))
    else:
        for f in sorted((ROOT / "songs").iterdir()):
            if f.suffix.lower() in EXT and " - " in f.stem:
                film, title = f.stem.split(" - ", 1)
                entries.append((f, film, title, a.artist))
    if a.only:
        entries = [e for e in entries if a.only.lower() in (e[1] + e[2]).lower()]
    summary = []
    for f, film, title, artist in entries:
        slug = slugify(f"{film}-{title}")
        d = OUT / slug
        print(f"\n=== {film} – {title} ===", flush=True)
        if a.redo or not (d / f"report_{SEP}.json").exists():
            r = subprocess.run([sys.executable, "-W", "ignore", "pipeline.py", str(f), "--artist", artist,
                                "--film", film, "--title", title, "--slug", slug], cwd=ROOT,
                               capture_output=True, text=True, encoding="utf-8", errors="replace")
            if r.returncode:
                print("ÉCHEC pipeline :", r.stderr.strip().splitlines()[-1] if r.stderr else "?")
                summary.append({"film": film, "title": title, "error": (r.stderr or "")[-400:]})
                continue
        rep = json.loads((d / f"report_{SEP}.json").read_text(encoding="utf-8"))
        row = {"film": film, "title": title, "slug": slug, "duration_s": rep["duration_s"],
               "lyrics": rep["lyrics_source"], "lrclib_delta_s": rep.get("lrclib_duration_delta_s"),
               "total_s": rep["total_s"], "halluc": rep["asr_hallucinations"]}
        if (d / f"words_aligned_{SEP}.json").exists():
            words = json.loads((d / f"words_aligned_{SEP}.json").read_text(encoding="utf-8"))
            row["uncertain_pct"] = round(100 * rep["aligned_uncertain"] / max(1, rep["aligned_words"]))
            row.update(agreement(d))
            accepted, tried = [], 0
            vocals_path = d / f"vocals_{SEP}.flac"
            for i, j in ranked_gaps(words):
                if len(accepted) == 2 or tried >= 25:
                    break
                if not real_pause_before(vocals_path, words[i]["start"]):
                    continue  # pas de vraie pause avant ce trou : on passe au suivant
                tried += 1
                g = measure_gap(d, words, i, j)
                if g["voice_at_cut_db"] <= SILENCE_DB:
                    accepted.append(g)
                else:
                    print(f"  trou {i}-{j} rejeté : voix à la coupure {g['voice_at_cut_db']} dB", flush=True)
            row["gaps"] = accepted
            row["gaps_tried"] = tried
        summary.append(row)
        dump(OUT / "batch_summary.json", summary)
        print(json.dumps({k: v for k, v in row.items() if k != "gaps"}, ensure_ascii=False))
        for g in row.get("gaps", []):
            print("  trou", g)

    print("\n| Film | LRCLIB Δ | Temps | Incertains | Accord ASR (méd/p90) | Trous : écart onset / marge coupure→voix / voix à la coupure |")
    print("|---|---|---|---|---|---|")
    for r in summary:
        if "error" in r:
            print(f"| {r['film']} | ÉCHEC | | | | |")
            continue
        gaps = " ; ".join(f"{g['at']} {g['words']} mots : {g['onset_err_ms']} ms / {g['margin_cut_to_voice_ms']} ms / {g['voice_at_cut_db']} dB"
                          for g in r.get("gaps", [])) or "aucun candidat"
        print(f"| {r['film']} | {r['lyrics'].split(':')[0]} {r['lrclib_delta_s']} s | {r['total_s']} s | "
              f"{r.get('uncertain_pct')} % | {r.get('agree_median_ms')}/{r.get('agree_p90_ms')} ms | {gaps} |")


if __name__ == "__main__":
    main()
