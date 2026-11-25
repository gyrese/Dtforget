"""Réparation de l'alignement forcé des paroles à l'aide de la transcription Whisper.

L'alignement forcé (stable-ts) place toutes les paroles quelque part, même quand la fiche LRCLIB
ne correspond pas tout à fait à la version écoutée : des lignes se retrouvent tassées dans une
intro parlée, et des couplets réellement chantés restent sans paroles. La transcription Whisper
(words_asr.json) dit, elle, où la voix chante vraiment. On s'en sert ainsi :

1. ancres : mots des paroles retrouvés dans la transcription (même mot, dans le même ordre),
   plus les mots de l'alignement forcé jugés sûrs qui restent cohérents avec elles ;
2. les autres mots sont replacés entre ces ancres, ligne par ligne, au rythme du chant ;
3. un passage chanté que la transcription entend mais qui n'est dans aucune ligne des paroles
   devient une ligne « entendue » (heard), pour que l'écran n'ait jamais de couplet muet.

Aucun texte n'est imprimé : seulement des mesures.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher


def norm(text: str) -> str:
    t = unicodedata.normalize("NFD", text.lower())
    t = "".join(c for c in t if unicodedata.category(c) != "Mn")
    return re.sub(r"[^a-z0-9]", "", t)


def sing_time(words: list[dict]) -> float:
    """Durée probable pour chanter ces mots."""
    return sum(len(w["text"]) * 0.065 + 0.12 for w in words)


def _asr_matches(words: list[dict], asr: list[dict]) -> dict[int, dict]:
    """Mots des paroles retrouvés dans la transcription, dans le même ordre."""
    a = [norm(w["text"]) for w in words]
    b = [norm(w["text"]) for w in asr]
    sm = SequenceMatcher(None, a, b, autojunk=False)
    out = {}
    for blk in sm.get_matching_blocks():
        for k in range(blk.size):
            i, j = blk.a + k, blk.b + k
            # un mot isolé et court (« de », « la ») peut correspondre n'importe où : on l'ignore
            if blk.size < 2 and len(a[i]) < 5:
                continue
            if a[i]:
                out[i] = asr[j]
    return out


def _monotone(cands: list[tuple[int, float, float, float]]) -> list[tuple[int, float, float]]:
    """Plus lourde suite d'ancres dont les temps avancent avec l'ordre des mots."""
    cands = sorted(cands)
    n = len(cands)
    best = [c[3] for c in cands]
    prev = [-1] * n
    for k in range(n):
        for m in range(k):
            if cands[m][2] <= cands[k][1] + 0.05 and best[m] + cands[k][3] > best[k]:
                best[k], prev[k] = best[m] + cands[k][3], m
    if not n:
        return []
    k = max(range(n), key=lambda x: best[x])
    out = []
    while k >= 0:
        out.append(cands[k][:3])
        k = prev[k]
    return out[::-1]


def _place(words: list[dict], start: float, end: float) -> list[tuple[float, float]]:
    """Mots chantés d'affilée à partir de start, à leur rythme (resserrés si la place manque)."""
    need = sing_time(words)
    scale = min(1.0, max(0.05, end - start) / need) if need else 1.0
    out, t = [], start
    for w in words:
        d = (len(w["text"]) * 0.065 + 0.12) * scale
        out.append((round(t, 3), round(t + d - 0.02 * scale, 3)))
        t += d
    return out


def repair(words: list[dict], asr: list[dict], anchors: dict[int, float] | None = None,
           duration: float | None = None) -> tuple[list[dict], list[list[dict]], dict]:
    """Paroles recalées (mêmes mots, mêmes indices), lignes entendues hors paroles, mesures.

    anchors : début imposé de certains mots (calage à la main), prioritaire sur tout le reste.
    duration : durée de la chanson ; les paroles qui n'y tiennent pas restent à la toute fin.
    """
    asr = [w for w in asr if not w.get("hallucination") and w["end"] > w["start"] - 0.01]
    n = len(words)
    found = _asr_matches(words, asr)
    cands = []
    for i, w in enumerate(words):
        if anchors and i in anchors:
            continue
        if i in found:
            h = found[i]
            cands.append((i, h["start"], h["end"], 3.0 if h.get("prob", 1) >= 0.45 else 2.0))
        elif not w.get("uncertain") and w["end"] - w["start"] >= 0.05:
            cands.append((i, w["start"], w["end"], 1.0))
    if anchors:
        # une ancre imposée l'emporte : on retire ce qui la contredit, puis on la garde à coup sûr
        for i, t in anchors.items():
            cands = [c for c in cands if (c[0] < i and c[2] <= t + 0.05) or (c[0] > i and c[1] >= t)]
            cands.append((i, t, t + sing_time([words[i]]), 1000.0))
    keep = {i: (s, e) for i, s, e in _monotone(cands)}

    # les mots sans ancre, par tronçons entre deux ancres
    times: dict[int, tuple[float, float]] = dict(keep)
    idx = sorted(keep)
    bounds = [-1] + idx + [n]
    for a, b in zip(bounds, bounds[1:]):
        run = list(range(a + 1, b))
        if not run:
            continue
        lo = keep[a][1] + 0.02 if a >= 0 else max(0.0, (keep[b][0] if b < n else words[0]["start"]) - sing_time([words[i] for i in run]) - 0.3)
        hi = keep[b][0] - 0.02 if b < n else max(lo + sing_time([words[i] for i in run]), words[-1]["end"])
        # chaque ligne commence à son tour : la fin de la ligne de l'ancre d'avant la suit aussitôt,
        # le début de la ligne de l'ancre d'après la précède aussitôt, les lignes entières se répartissent entre
        line_a = words[a]["line"] if a >= 0 else None
        line_b = words[b]["line"] if b < n else None
        head = [i for i in run if words[i]["line"] == line_a]
        tail = [i for i in run if words[i]["line"] == line_b and words[i]["line"] != line_a]
        mid = [i for i in run if i not in head and i not in tail]
        if head:
            for i, t in zip(head, _place([words[i] for i in head], lo, hi)):
                times[i] = t
            lo = times[head[-1]][1] + 0.02
        if tail:
            need = sing_time([words[i] for i in tail])
            s0 = max(lo, hi - need)
            for i, t in zip(tail, _place([words[i] for i in tail], s0, hi)):
                times[i] = t
            hi = times[tail[0]][0] - 0.02
        if mid:
            lines: list[list[int]] = []
            for i in mid:
                if lines and words[lines[-1][-1]]["line"] == words[i]["line"]:
                    lines[-1].append(i)
                else:
                    lines.append([i])
            # l'alignement forcé sait souvent où commence une ligne même incertaine : on le garde s'il tombe dans la place libre
            need = [sing_time([words[i] for i in ln]) for ln in lines]
            free = max(0.0, (hi - lo) - sum(need))
            t = lo
            for ln, nd in zip(lines, need):
                s = words[ln[0]]["start"]
                start = s if t <= s <= hi - nd else t + free / (len(lines) + 1)
                for i, tt in zip(ln, _place([words[i] for i in ln], start, min(hi, start + nd))):
                    times[i] = tt
                t = times[ln[-1]][1] + 0.02
    out = [{**w, "start": times[i][0], "end": max(times[i][0], times[i][1]), "uncertain": i not in keep}
           for i, w in enumerate(words)]
    for i in range(1, n):  # jamais en arrière
        if out[i]["start"] < out[i - 1]["start"]:
            out[i]["start"] = out[i - 1]["start"]
            out[i]["end"] = max(out[i]["end"], out[i]["start"])
    if duration:  # paroles pas chantées dans cette version : rangées à la fin, hors de tout extrait
        for w in out:
            w["start"], w["end"] = min(w["start"], duration), min(w["end"], duration)

    # passages chantés sans paroles : ce que la transcription entend devient une ligne « entendue »
    used = set()
    for h in found.values():
        used.add(id(h))
    spans = [(w["start"], w["end"]) for w in out]

    def covered(t0: float, t1: float) -> bool:
        return any(s < t1 + 0.6 and e > t0 - 0.6 for s, e in spans)

    heard: list[list[dict]] = []
    for h in asr:
        if id(h) in used or h.get("uncertain") or covered(h["start"], h["end"]):
            if heard and heard[-1]:
                heard.append([])
            continue
        if heard and heard[-1] and h["start"] - heard[-1][-1]["end"] > 1.5:
            heard.append([])
        if not heard:
            heard.append([])
        heard[-1].append(h)
    heard = [g for g in heard if len(g) >= 3 and g[-1]["end"] - g[0]["start"] >= 1.5]
    # une ligne entendue par groupe ; gardées à part pour que les indices des paroles ne bougent jamais
    lines = [[{"text": h["text"], "start": h["start"], "end": h["end"]} for h in g] for g in heard]
    stats = {
        "words": n, "asr_matched": len(found), "anchors": len(keep),
        "heard_lines": len(lines), "heard_words": sum(len(g) for g in lines),
    }
    return out, lines, stats
