from common import tokenize
from scoring import score


def test_norm():
    assert tokenize("J’ai") == tokenize("j'ai") == tokenize("J AI")
    assert tokenize("Être") == tokenize("etre")
    assert tokenize("coeur") == tokenize("cœur")
    assert tokenize("deux") == tokenize("2")
    assert tokenize("c'est") != tokenize("ses")
    assert tokenize("aujourd'hui, c'est-à-dire !") == ["aujourd", "hui", "c", "est", "a", "dire"]
    assert tokenize("oh (oh oh) yeah") == ["oh", "yeah"]


def test_align_missing_word():
    r = score("a b c d", "a c d")
    assert r["correct"] == 3 and not r["perfect"]


def test_align_extra_word():
    r = score("a b c d", "a b x c d")
    assert r["correct"] == 4 and r["extra"] == 1 and r["points"] == 3.5 and not r["perfect"]


def test_perfect():
    r = score("Je veux d'l'amour, d'la joie", "je veux d l amour d la joie")
    assert r["perfect"] and r["points"] == r["total"]


def test_spam_scores_zero():
    r = score("vivre sans regretter rien jamais trop longtemps", "je la de et que tu le")
    assert r["points"] == 0


def test_spam_long_burst_truncated():
    r = score("le soleil brille sur la ville ce matin", " ".join(["le la"] * 30))
    assert r["points"] <= 2


def test_lenient_typo():
    assert score("regretter", "regreter")["correct"] == 1
    assert score("regretter", "regreter", lenient=False)["correct"] == 0
    assert score("ses", "ces")["correct"] == 0  # homophones refusés
