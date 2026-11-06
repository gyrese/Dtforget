"""Vérité terrain du morceau synthétique : débuts/fins de phrases mesurés par silencedetect sur la voix seule.

Compare le premier mot / dernier mot aligné de chaque phrase aux frontières réelles (voix décalée de 4 s).
"""
import json
import re
import statistics
import subprocess

from common import OUT

DELAY = 4.0
out = subprocess.run(["ffmpeg", "-hide_banner", "-i", "songs/voice.wav", "-af", "silencedetect=n=-40dB:d=0.25",
                      "-f", "null", "-"], capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"silence_start: ([\d.]+)", out)]
ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", out)]
onsets = [0.0] + ends            # début de chaque phrase (voix)
offsets = starts                 # fin de chaque phrase (voix)
lines = [ln for ln in open("songs/synthetic_lyrics.txt", encoding="utf-8-sig").read().splitlines() if ln.strip()]
words = json.load(open(OUT / "test-synthetique" / "words_aligned_bs_roformer.json", encoding="utf-8"))

errs, i = [], 0
for k, ln in enumerate(lines):
    n = len(ln.split())
    seg = words[i:i + n]
    i += n
    if k < len(onsets) and seg:
        e_on = (seg[0]["start"] - (onsets[k] + DELAY)) * 1000
        e_off = (seg[-1]["end"] - (offsets[k] + DELAY)) * 1000 if k < len(offsets) else None
        errs.append(abs(e_on))
        print(f"phrase {k + 1}: début {e_on:+.0f} ms" + (f", fin {e_off:+.0f} ms" if e_off is not None else ""))
print(f"Erreur médiane début de phrase : {statistics.median(errs):.0f} ms (max {max(errs):.0f} ms)")
