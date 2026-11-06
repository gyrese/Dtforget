"""Utilitaires partagés du spike (normalisation, LRCLIB, ffmpeg, chrono)."""
from __future__ import annotations

import json
import re
import subprocess
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
UA = "DtForget-spike/0.0.1 (prototype prive)"

# Hallucinations Whisper connues (textes générés sur silence / instrumental)
HALLUCINATIONS = [
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st' 501",
    "sous-titrage société radio-canada",
    "merci d'avoir regardé",
    "abonnez-vous",
    "thanks for watching",
    "subtitles by the amara.org community",
]


def slugify(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", s).strip("-").lower()[:60] or "song"


# ---------- Normalisation mot par mot (D9 du plan) ----------
_NUM = {"0": "zero", "1": "un", "2": "deux", "3": "trois", "4": "quatre", "5": "cinq",
        "6": "six", "7": "sept", "8": "huit", "9": "neuf", "10": "dix"}


def tokenize(text: str) -> list[str]:
    """Découpe en mots PUIS normalise chaque mot. Les élisions sont séparées : j'ai -> j + ai."""
    t = text.replace("’", "'").replace("`", "'").replace("œ", "oe").replace("Œ", "oe")
    t = t.replace("æ", "ae").replace("Æ", "ae")
    t = re.sub(r"\(.*?\)", " ", t)  # texte entre parenthèses = chœurs
    t = re.sub(r"[-'‐-―]", " ", t)
    out: list[str] = []
    for raw in t.split():
        w = unicodedata.normalize("NFD", raw.lower())
        w = "".join(c for c in w if unicodedata.category(c) != "Mn")
        w = re.sub(r"[^a-z0-9]", "", w)
        if not w:
            continue
        out.append(_NUM.get(w, w))
    return out


# ---------- LRCLIB ----------
def lrclib_lookup(artist: str, title: str, duration_s: float | None = None) -> dict:
    """get (avec durée) -> search. Retourne {source, synced, plain, id} ou {source: None}."""
    s = requests.Session()
    s.headers["User-Agent"] = UA
    base = "https://lrclib.net/api"
    if duration_s:
        r = s.get(f"{base}/get", params={"artist_name": artist, "track_name": title,
                                          "duration": round(duration_s)}, timeout=15)
        if r.ok:
            d = r.json()
            return {"source": "get", "id": d.get("id"), "synced": d.get("syncedLyrics"),
                    "plain": d.get("plainLyrics"), "duration": d.get("duration")}
    r = s.get(f"{base}/search", params={"artist_name": artist, "track_name": title}, timeout=15)
    if r.ok and r.json():
        hits = r.json()
        if duration_s:
            hits.sort(key=lambda h: abs((h.get("duration") or 0) - duration_s))
        hits.sort(key=lambda h: h.get("syncedLyrics") is None)
        d = hits[0]
        return {"source": "search", "id": d.get("id"), "synced": d.get("syncedLyrics"),
                "plain": d.get("plainLyrics"), "duration": d.get("duration")}
    return {"source": None}


def lrclib_candidates(title: str, duration_s: float, artists: list[str], max_delta: float = 5.0,
                      extra_queries: list[str] | None = None) -> list[dict]:
    """Tous les résultats LRCLIB (plusieurs requêtes) dont la durée est à ±max_delta s, du plus proche au plus loin.

    extra_queries : textes libres supplémentaires (ex. « nom du film + titre »)."""
    s = requests.Session()
    s.headers["User-Agent"] = UA
    hits: dict = {}
    queries = [{"artist_name": a, "track_name": title} for a in artists if a] + [{"track_name": title}, {"q": title}]
    queries += [{"q": x} for x in (extra_queries or []) if x]
    for q in queries:
        try:
            r = s.get("https://lrclib.net/api/search", params=q, timeout=15)
        except requests.RequestException:
            continue
        if r.ok:
            for h in r.json():
                if h.get("duration") and (h.get("syncedLyrics") or h.get("plainLyrics")) and not h.get("instrumental"):
                    hits[h["id"]] = h
    c = [h for h in hits.values() if abs(h["duration"] - duration_s) <= max_delta]
    if not c:  # aucune version à la bonne durée : on garde les autres, le contrôle de correspondance tranchera
        c = list(hits.values())[:15]
    return sorted(c, key=lambda h: abs(h["duration"] - duration_s))


def text_similarity(a: str, b: str) -> float:
    """Jaccard sur les mots de plus de 2 lettres (robuste aux répétitions de refrain et à l'ordre)."""
    sa = {w for w in tokenize(a) if len(w) > 2}
    sb = {w for w in tokenize(b) if len(w) > 2}
    return len(sa & sb) / max(1, len(sa | sb))


def lrclib_best(title: str, duration_s: float, artists: list[str], max_delta: float = 5.0) -> dict:
    """Interroge plusieurs variantes (artistes, titre seul, q libre), garde la version la plus proche en durée.

    Rejette au-delà de max_delta secondes (autre version → alignement faux). Préfère synced à durée égale (±1 s).
    """
    s = requests.Session()
    s.headers["User-Agent"] = UA
    base, hits = "https://lrclib.net/api/search", {}
    queries = [{"artist_name": a, "track_name": title} for a in artists if a] + \
              [{"track_name": title}, {"q": title}]
    for q in queries:
        try:
            r = s.get(base, params=q, timeout=15)
        except requests.RequestException:
            continue
        if r.ok:
            for h in r.json():
                if h.get("duration") and (h.get("syncedLyrics") or h.get("plainLyrics")) and not h.get("instrumental"):
                    hits[h["id"]] = h
    if not hits:
        return {"source": None, "candidates": 0}
    ranked = sorted(hits.values(), key=lambda h: (round(abs(h["duration"] - duration_s)), h.get("syncedLyrics") is None))
    d = ranked[0]
    delta = d["duration"] - duration_s
    if abs(delta) > max_delta:
        return {"source": None, "candidates": len(hits), "closest_delta": round(delta, 1)}
    return {"source": "search+", "id": d["id"], "synced": d.get("syncedLyrics"), "plain": d.get("plainLyrics"),
            "duration": d["duration"], "artist": d.get("artistName"), "candidates": len(hits)}


def lrc_to_text(lrc: str) -> str:
    return "\n".join(re.sub(r"^\s*(\[[^\]]*\])+", "", ln).strip() for ln in lrc.splitlines()).strip()


# ---------- ffmpeg ----------
def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def probe_duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                          "-of", "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


# ---------- chrono / VRAM ----------
class Timings(dict):
    @contextmanager
    def step(self, name: str):
        t0 = time.perf_counter()
        print(f"▶ {name}…", flush=True)
        try:
            yield
        finally:
            self[name] = round(time.perf_counter() - t0, 2)
            print(f"  ✓ {name} : {self[name]} s", flush=True)


def vram_peak_mb() -> float | None:
    try:
        import torch
        if torch.cuda.is_available():
            return round(torch.cuda.max_memory_allocated() / 2**20, 1)
    except Exception:
        pass
    return None


def free_gpu() -> None:
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def dump(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def lrc_lines(lrc: str) -> list[tuple[float, str]]:
    """Lignes LRC -> [(temps en secondes, texte)]. Ignore les lignes sans horodatage."""
    out = []
    for ln in lrc.splitlines():
        m = re.match(r"^\s*\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$", ln)
        if m:
            out.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3).strip()))
    return out


def containment(asr_text: str, ref_text: str) -> float:
    """Part des mots (>2 lettres) entendus par Whisper présents dans la référence. Adapté aux extraits."""
    a = {w for w in tokenize(asr_text) if len(w) > 2}
    b = {w for w in tokenize(ref_text) if len(w) > 2}
    return len(a & b) / max(1, len(a))
