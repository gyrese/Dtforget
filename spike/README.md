# Phase 0 : spike de faisabilité IA

Objectif : décider avec des chiffres si le pipeline (séparation, paroles, alignement au mot) est assez bon pour le jeu sur **votre** machine (RTX 4050 Laptop, 6 Go de VRAM).

## Installation (déjà faite)

```bash
cd C:\ai\DtForget\spike
py -3.14 -m uv sync --python 3.12
```

## 1. Déposer les chansons

Copiez 7 fichiers dans `spike/songs/` : 5 en français (dont 2 ou 3 anciens : Piaf, Dassin, Sardou…) et 2 en anglais. Formats acceptés : mp3, m4a, flac, wav, mp4. Le mieux est un **mélange de styles** : variété, rock, rap, une ballade, et un titre avec beaucoup de chœurs.

## 2. Lancer le pipeline (séparation + paroles + alignement)

```bash
.venv\Scripts\python pipeline.py "songs/zaz-je-veux.mp3" --artist "Zaz" --title "Je veux"
```

Variantes à comparer sur au moins 3 titres :

```bash
.venv\Scripts\python pipeline.py "songs/…" --artist … --title … --sep htdemucs_ft
.venv\Scripts\python pipeline.py "songs/…" --artist … --title … --sep bs_roformer --skip-sep --asr large-v3-turbo
.venv\Scripts\python pipeline.py "songs/…" --artist … --title … --cpu      # mesure du temps sur CPU (critère d)
```

## 3. Choisir 2 ou 3 trous par chanson et écouter

```bash
.venv\Scripts\python gap.py list zaz-je-veux --from 40 --to 70
.venv\Scripts\python gap.py preview zaz-je-veux --first 120 --last 128
```

La commande `preview` produit un extrait `.wav` : 8 s de chanson normale, puis l'instrumental seul. Elle affiche aussi la mesure du **résidu vocal** sur la fenêtre [t_cut − 50 ms, t_cut + 2 s].

**Critère (b), à l'oreille :** aucune voix du trou ne doit être audible dans cette fenêtre, ni le début du premier mot avant la coupure. Notez OK, LIMITE ou KO dans `results.md`.

## 4. Annoter la vérité terrain (critère a)

Dans **Audacity** :
1. Ouvrez `out/<slug>/audio.wav`.
2. Sélectionnez chaque mot d'un trou, puis Ctrl+B et tapez le mot.
3. Exportez les labels avec Fichier > Exporter > Exporter les labels, vers `annotations/<slug>.txt`.

Ensuite :

```bash
.venv\Scripts\python gap.py eval zaz-je-veux annotations/zaz-je-veux.txt
```

## 5. Tests des règles de score

```bash
.venv\Scripts\python -m pytest -q test_scoring.py
```

## Critères go/no-go

| Critère | Seuil | Si échec |
|---|---|---|
| (a) Timing des mots du trou | médiane ≤ 150 ms | Recalage manuel obligatoire dans l'éditeur, essayer WhisperX |
| (b) Voix inaudible après la coupure | ≥ 70 % des trous OK | Tester `mel_roformer` ; sinon LALAL.AI par API |
| (c) Couverture LRCLIB FR | ≥ 50 % | Paroles collées par l'hôte par défaut |
| (d) Temps par titre | GPU < 3 min | Préparation longtemps avant la soirée, ou API |

**Résultat déjà mesuré pour (c) :** 20 titres FR sur 20 avec paroles synchronisées (voir `out/lrclib_coverage.json`).

⚠️ Usage privé uniquement. Les stems et les paroles restent dans `out/` (ignoré par git) et ne doivent pas être diffusés.
