"""Pipeline phase 0 : extrait d'une chanson -> stems -> paroles -> mots horodatés.

Usage :
  python pipeline.py songs/mon_titre.mp3 --artist "Zaz" --title "Je veux" [--window 60] [--film ...]
         [--sep bs_roformer|mel_roformer|htdemucs_ft] [--asr large-v3|large-v3-turbo]
         [--lyrics paroles.txt] [--no-lrclib] [--cpu]

--window N : ne traite qu'un extrait de N secondes (défaut 60). Le début est choisi sur les
             horodatages LRCLIB (première ligne après 20 % du morceau). 0 = morceau entier.
Sorties dans out/<slug>/ : audio.wav (= extrait), vocals/instrumental, lyrics_ref.txt, words_*.json,
report_<sep>.json.
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from common import (HALLUCINATIONS, OUT, Timings, containment, dump, ffmpeg, free_gpu, lrc_lines,
                    lrc_to_text, lrclib_candidates, probe_duration, slugify, vram_peak_mb)

SEP_MODELS = {
    "bs_roformer": "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "mel_roformer": "vocals_mel_band_roformer.ckpt",
    "htdemucs_ft": "htdemucs_ft.yaml",
}
MIN_CONTAINMENT = 0.40
MODELS_DIR = Path(__file__).resolve().parent / "models"


def separate(wav: Path, out_dir: Path, model_key: str, device_cpu: bool) -> tuple[Path, Path]:
    import os

    from audio_separator.separator import Separator

    tmp = out_dir / f"sep_{model_key}"
    tmp.mkdir(parents=True, exist_ok=True)
    overlap = int(os.environ.get("SEP_OVERLAP", "2"))
    sep = Separator(output_dir=str(tmp), output_format="FLAC", model_file_dir=str(MODELS_DIR),
                    use_autocast=not device_cpu,
                    mdxc_params={"segment_size": 256, "override_model_segment_size": False,
                                 "batch_size": 1, "overlap": overlap, "pitch_shift": 0},
                    demucs_params={"segment_size": "Default", "shifts": 1, "overlap": 0.25,
                                   "segments_enabled": True})
    sep.load_model(model_filename=SEP_MODELS[model_key])
    files = [tmp / Path(f).name for f in sep.separate(str(wav))]
    vocals = next(f for f in files if "(Vocals)" in f.name)
    instr = [f for f in files if "(Instrumental)" in f.name]
    if instr:
        instrumental = instr[0]
    else:
        others = [f for f in files if f != vocals]
        instrumental = tmp / "instrumental_sum.flac"
        ins = sum((["-i", str(f)] for f in others), [])
        ffmpeg(*ins, "-filter_complex", f"amix=inputs={len(others)}:normalize=0", str(instrumental))
    v_out, i_out = out_dir / f"vocals_{model_key}.flac", out_dir / f"instrumental_{model_key}.flac"
    shutil.copy(vocals, v_out)
    shutil.copy(instrumental, i_out)
    del sep
    free_gpu()
    return v_out, i_out


def load_16k(path: Path):
    """Décode en mono 16 kHz float32 via ffmpeg (évite l'incompatibilité PyAV de faster-whisper)."""
    import subprocess

    import numpy as np
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le",
                          "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def words_from_result(result) -> list[dict]:
    words = []
    for seg in result.segments:
        seg_text = seg.text.strip().lower()
        halluc = any(h in seg_text for h in HALLUCINATIONS)
        bad = (getattr(seg, "avg_logprob", 0) or 0) < -1.0 or (getattr(seg, "compression_ratio", 0) or 0) > 2.4
        for w in seg.words or []:
            prob = float(getattr(w, "probability", 1.0) or 0.0)
            words.append({
                "text": w.word.strip(), "start": round(float(w.start), 3), "end": round(float(w.end), 3),
                "prob": round(prob, 3), "uncertain": bool(halluc or bad or prob < 0.45),
                "hallucination": halluc,
            })
    return words


def choose_window(src: Path, full_dur: float, synced_lrc: str | None, window: float) -> tuple[float, float, str]:
    """Début de l'extrait : première ligne LRC après 20 % du morceau (sinon 20 % fixe)."""
    start, source = 0.2 * full_dur, "fixed"
    if synced_lrc:
        lines = lrc_lines(synced_lrc)
        starts = [t for t, txt in lines if txt and t >= max(15.0, 0.2 * full_dur) and t + window <= full_dur]
        if starts:
            start, source = max(0.0, starts[0] - 0.3), "lrc"
    end = min(full_dur, start + window)
    return round(start, 2), round(end, 2), source


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("--artist", required=True)
    ap.add_argument("--title", required=True)
    ap.add_argument("--film", default="")
    ap.add_argument("--slug")
    ap.add_argument("--window", type=float, default=60.0, help="durée de l'extrait en s (0 = morceau entier)")
    ap.add_argument("--lang", default="fr")
    ap.add_argument("--sep", default="bs_roformer", choices=list(SEP_MODELS))
    ap.add_argument("--asr", default="large-v3")
    ap.add_argument("--lyrics", help="fichier texte de paroles (remplace LRCLIB)")
    ap.add_argument("--no-lrclib", action="store_true")
    ap.add_argument("--cpu", action="store_true")
    a = ap.parse_args()

    src = Path(a.input)
    slug = a.slug or slugify(f"{a.artist}-{a.title}")
    out = OUT / slug
    out.mkdir(parents=True, exist_ok=True)
    t = Timings()
    device = "cpu" if a.cpu else "cuda"
    report: dict = {"input": src.name, "artist": a.artist, "title": a.title, "sep": a.sep, "asr": a.asr,
                    "device": device}

    # 0. Durée source + candidats LRCLIB (avant séparation, pour choisir l'extrait)
    full_dur = probe_duration(src)
    report["full_duration_s"] = round(full_dur, 2)
    cands = []
    if not a.lyrics and not a.no_lrclib:
        with t.step("0 candidats LRCLIB"):
            extra = [f"{a.film} {a.title}"] if a.film else []
            cands = lrclib_candidates(a.title, full_dur, [a.artist, a.film], extra_queries=extra)
    report["lrclib_candidates"] = len(cands)
    synced_first = next((c["syncedLyrics"] for c in cands if c.get("syncedLyrics")), None)

    # 1. Extrait audio
    if a.window and full_dur > a.window + 5:
        start_t, end_t, win_src = choose_window(src, full_dur, synced_first, a.window)
    else:
        start_t, end_t, win_src = 0.0, full_dur, "full"
    report.update({"excerpt_start_s": start_t, "excerpt_end_s": end_t, "window_source": win_src})
    wav = out / "audio.wav"
    with t.step(f"1 extraction ffmpeg ({start_t}-{end_t} s)"):
        ffmpeg("-ss", f"{start_t:.3f}", "-t", f"{end_t - start_t:.3f}", "-i", str(src),
               "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", str(wav))
    duration = probe_duration(wav)
    report["duration_s"] = round(duration, 2)

    # 2. Séparation (sur l'extrait uniquement)
    v_path, i_path = out / f"vocals_{a.sep}.flac", out / f"instrumental_{a.sep}.flac"
    with t.step(f"2 séparation {a.sep}"):
        v_path, i_path = separate(wav, out, a.sep, a.cpu)
    report["vram_sep_mb"] = vram_peak_mb()

    # 3. Transcription libre
    import stable_whisper

    with t.step(f"3 chargement {a.asr}"):
        model = stable_whisper.load_faster_whisper(
            a.asr, device=device, compute_type="int8" if a.cpu else "int8_float16")
    vocals16k = load_16k(v_path)
    with t.step("3 transcription libre (voix isolée)"):
        res = model.transcribe(vocals16k, language=a.lang, word_timestamps=True, vad=True,
                               condition_on_previous_text=False, beam_size=5)
        words_asr = words_from_result(res)
        dump(out / f"words_asr_{a.sep}.json", words_asr)
    report["asr_words"] = len(words_asr)
    report["asr_uncertain"] = sum(w["uncertain"] for w in words_asr)
    report["asr_hallucinations"] = sum(w["hallucination"] for w in words_asr)

    # 4. Paroles de référence : candidat dont le texte est le plus présent dans ce que Whisper entend
    ref_text, ref_src = None, None
    if a.lyrics:
        ref_text, ref_src = Path(a.lyrics).read_text(encoding="utf-8-sig"), "pasted"
    elif cands:
        asr_text = " ".join(w["text"] for w in words_asr if not w["hallucination"])
        scored = []
        for c in cands:
            if c.get("syncedLyrics"):
                if win_src == "full":
                    ref = lrc_to_text(c["syncedLyrics"])
                else:
                    ref = "\n".join(txt for ti, txt in lrc_lines(c["syncedLyrics"]) if start_t <= ti < end_t and txt)
            else:
                ref = c.get("plainLyrics") if win_src == "full" else None  # texte brut inutilisable sur extrait
            scored.append((containment(asr_text, ref) if ref else 0.0, c, ref))
        scored.sort(key=lambda x: -x[0])
        report["lrclib_containment"] = [round(s, 2) for s, _, _ in scored[:5]]
        best, c, ref = scored[0]
        far = abs(c["duration"] - full_dur) > 5  # autre version probable : exiger une correspondance plus forte
        if far and best < 0.6:
            best = 0.0
        if best >= MIN_CONTAINMENT and ref:
            ref_text = ref
            ref_src = f"lrclib:{c['id']}:{'synced' if c.get('syncedLyrics') else 'plain'}"
            report["lrclib_duration_delta_s"] = round(c["duration"] - full_dur, 1)
            report["lrclib_containment_best"] = round(best, 2)
            if c.get("syncedLyrics"):
                (out / "lyrics_ref.lrc").write_text(c["syncedLyrics"], encoding="utf-8")
        else:
            report["lrclib_rejected"] = f"meilleure présence {best:.2f} < {MIN_CONTAINMENT} (ou pas de texte sur extrait)"
    if ref_text:
        (out / "lyrics_ref.txt").write_text(ref_text, encoding="utf-8")
    report["lyrics_source"] = ref_src or "asr"

    # 5. Alignement forcé mot par mot, ou repli ASR seul
    if ref_text:
        with t.step("4 alignement forcé sur paroles de référence"):
            aligned = model.align(vocals16k, ref_text, language=a.lang)
            words_al = words_from_result(aligned)
    else:
        words_al = words_asr
    dump(out / f"words_aligned_{a.sep}.json", words_al)
    report["aligned_words"] = len(words_al)
    report["aligned_uncertain"] = sum(w["uncertain"] for w in words_al)

    report["vram_peak_mb"] = vram_peak_mb()
    report["timings_s"] = dict(t)
    report["total_s"] = round(sum(t.values()), 1)
    report["realtime_factor"] = round(report["total_s"] / duration, 2)
    dump(out / f"report_{a.sep}.json", report)
    print(f"\nTerminé en {report['total_s']} s (extrait {start_t}-{end_t} s) → {out}")


if __name__ == "__main__":
    main()
