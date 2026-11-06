"""Prototype du scoring (D10) : alignement à coût Needleman-Wunsch + pénalité des mots en trop."""
from __future__ import annotations

from rapidfuzz.distance import Levenshtein

from common import tokenize


def word_ok(ref: str, got: str, lenient: bool) -> bool:
    if ref == got:
        return True
    return lenient and len(ref) > 5 and Levenshtein.distance(ref, got) <= 1


def score(reference: str, answer: str, lenient: bool = True, extra_penalty: float = 0.5) -> dict:
    ref, got = tokenize(reference), tokenize(answer)
    got = got[: len(ref) + 2]  # troncature N+2
    n, m = len(ref), len(got)
    # coûts : match 0, substitution 1, omission 1, insertion 1
    INF = 10**9
    D = [[INF] * (m + 1) for _ in range(n + 1)]
    D[0] = list(range(m + 1))
    for i in range(1, n + 1):
        D[i][0] = i
        for j in range(1, m + 1):
            c = 0 if word_ok(ref[i - 1], got[j - 1], lenient) else 1
            D[i][j] = min(D[i - 1][j - 1] + c, D[i - 1][j] + 1, D[i][j - 1] + 1)
    # backtrack
    i, j, states, inserted = n, m, [None] * n, 0
    while i > 0 or j > 0:
        if i > 0 and j > 0 and D[i][j] == D[i - 1][j - 1] + (0 if word_ok(ref[i - 1], got[j - 1], lenient) else 1):
            ok = word_ok(ref[i - 1], got[j - 1], lenient)
            states[i - 1] = {"ref": ref[i - 1], "got": got[j - 1], "ok": ok}
            i, j = i - 1, j - 1
        elif i > 0 and D[i][j] == D[i - 1][j] + 1:
            states[i - 1] = {"ref": ref[i - 1], "got": None, "ok": False}
            i -= 1
        else:
            inserted += 1
            j -= 1
    correct = sum(s["ok"] for s in states)
    points = max(0.0, correct - extra_penalty * inserted)
    perfect = correct == n and inserted == 0 and m == n
    return {"words": states, "correct": correct, "total": n, "extra": inserted,
            "points": points, "perfect": perfect}
