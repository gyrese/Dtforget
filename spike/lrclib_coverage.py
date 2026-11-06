"""Critère (c) : taux de réussite LRCLIB sur une liste de titres (CSV artist;title[;duration_s]).

Usage : python lrclib_coverage.py titles_fr.csv
N'affiche JAMAIS les paroles : seulement la présence synced/plain et le nombre de lignes.
"""
import csv
import sys
import time

from common import OUT, dump, lrclib_lookup


def main(path: str) -> None:
    rows = [r for r in csv.reader(open(path, encoding="utf-8"), delimiter=";") if r and not r[0].startswith("#")]
    results, synced, plain = [], 0, 0
    for r in rows:
        artist, title = r[0].strip(), r[1].strip()
        dur = float(r[2]) if len(r) > 2 and r[2].strip() else None
        try:
            d = lrclib_lookup(artist, title, dur)
        except Exception as e:  # réseau
            d = {"source": None, "error": str(e)}
        has_s, has_p = bool(d.get("synced")), bool(d.get("plain"))
        synced += has_s
        plain += has_p or has_s
        n = len((d.get("synced") or d.get("plain") or "").splitlines())
        print(f"{'S' if has_s else ('P' if has_p else '-')}  {artist} – {title}  ({d.get('source')}, {n} lignes)")
        results.append({"artist": artist, "title": title, "via": d.get("source"),
                        "synced": has_s, "plain": has_p, "lines": n, "id": d.get("id")})
        time.sleep(0.3)
    total = len(rows) or 1
    summary = {"total": len(rows), "synced_pct": round(100 * synced / total), "any_pct": round(100 * plain / total)}
    print(f"\nSynchronisées : {summary['synced_pct']} %   Au moins texte brut : {summary['any_pct']} %")
    print("Go/no-go (c) : ", "OK (≥ 50 %)" if summary["any_pct"] >= 50 else "NO-GO → paroles collées par défaut")
    dump(OUT / "lrclib_coverage.json", {"summary": summary, "results": results})


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "titles_fr.csv")
