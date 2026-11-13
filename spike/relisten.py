"""Regenere les extraits d'écoute (ECOUTE/) pour le jeu.

Principe : la ligne de temps reste celle du morceau original. Seul le trou
(du premier au dernier mot à deviner) est remplacé par l'instrumental ; avant et
après, c'est la voix originale. Ainsi les paroles qui suivent le trou reprennent
au bon moment, avec la chanson.
  - début : PRE secondes avant la coupure (ou 0)
  - fin   : au moins TAIL secondes après la coupure, et au moins MIN_TOTAL au total
Lit out/batch_summary.json (cut_s des trous validés) et words_aligned pour la fin du trou.
Écrit out/ECOUTE/<slug>__<first>-<last>.wav.
Usage : python relisten.py
"""
import json

import numpy as np
import soundfile as sf

from common import OUT

PRE = 40.0        # secondes de chant original avant la coupure
TAIL = 15.0       # temps minimum après la coupure (= temps de réponse du jeu)
MIN_TOTAL = 45.0  # durée minimale de l'extrait
FADE = 0.04       # fondu voix -> instrumental -> voix (s)
SEP = "bs_roformer"


def main() -> None:
    summary = json.loads((OUT / "batch_summary.json").read_text(encoding="utf-8"))
    for song in summary:
        if song.get("error") or not song.get("gaps"):
            continue
        d = OUT / song["slug"]
        words = json.loads((d / f"words_aligned_{SEP}.json").read_text(encoding="utf-8"))
        orig_data, sr = sf.read(d / "audio.wav", dtype="float32")
        instr_data, sr2 = sf.read(d / f"instrumental_{SEP}.flac", dtype="float32")
        assert sr == sr2, f"fréquences différentes pour {song['slug']}"
        n = min(len(orig_data), len(instr_data))
        orig_data, instr_data = orig_data[:n], instr_data[:n]
        for g in song["gaps"]:
            cut = float(g["cut_s"])
            hole_end = float(words[g["last"]]["end"]) + 0.05
            t0 = max(0.0, cut - PRE)
            t1 = min(n / sr, max(cut + TAIL, t0 + MIN_TOTAL))
            a, b = int(t0 * sr), int(t1 * sr)
            # masque 0 -> 1 -> 0 : 1 sur le trou (instrumental), 0 ailleurs (voix), fondus de FADE s
            t = np.arange(a, b) / sr
            ramp_in = np.clip((t - (cut - FADE)) / FADE, 0, 1)
            ramp_out = np.clip(((hole_end + FADE) - t) / FADE, 0, 1)
            mask = np.minimum(ramp_in, ramp_out)
            if orig_data.ndim == 2:
                mask = mask[:, None]
            out = orig_data[a:b] * (1 - mask) + instr_data[a:b] * mask
            path = OUT / "ECOUTE" / f"{song['slug']}__{g['first']}-{g['last']}.wav"
            path.parent.mkdir(parents=True, exist_ok=True)
            sf.write(path, out, sr, subtype="PCM_16")
            print(f"{path.name}: coupure {cut:.2f}s, trou jusqu'à {hole_end:.2f}s, extrait {t1 - t0:.1f}s")


if __name__ == "__main__":
    main()
