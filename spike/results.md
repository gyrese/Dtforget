# Phase 0 : résultats

Machine : RTX 4050 Laptop (6 Go de VRAM), Windows 11, Python 3.12.16, torch 2.11.0+cu128, faster-whisper 1.2.1, stable-ts 2.19.1, audio-separator (BS-RoFormer viperx `model_bs_roformer_ep_317_sdr_12.9755`).

## Titre 1 : « L'air du vent » (version française de Pocahontas), 209,6 s

| Mesure | Résultat | Critère |
|---|---|---|
| Paroles LRCLIB | trouvées, version synchronisée, écart de durée **0,0 s** | (c) ✅ |
| Hallucinations de Whisper | 0 | ✅ |
| Mots alignés | 270, dont 31 marqués « incertains » (11 %) | — |
| Accord entre l'alignement forcé et l'ASR libre | médiane **20 ms**, p90 310 ms (221 mots appariés sur 270) | — |
| Trou A (refrain, 1:26, 8 mots, chant continu) : début du chant réel par rapport à l'aligné | **+20 ms** | (a) ✅ |
| Trou B (couplet, 1:57, 7 mots) : fin de la note tenue précédente | sous-estimée de **~700 ms** par wav2vec2 | voir correctif |
| Résidu vocal dans [t_cut − 50 ms, t_cut + 2 s] | A : silence numérique ; B : Δ −30 dB | (b) ✅ (mesure), écoute à confirmer |
| Temps de séparation | 309 s avec overlap=8, puis **94 s avec overlap=2** (écart de qualité −38 à −42 dB, inaudible) | — |
| Temps total du pipeline (overlap=2) | ≈ **145 s** (séparation 94 + chargement Whisper 12 + ASR 25 + alignement 13) | (d) ✅ < 3 min |
| VRAM | pic de 1,6 Go pour la séparation (torch). Whisper int8_float16 ≈ 3 Go (ctranslate2, non mesuré par torch) | ✅ tient dans 6 Go |

## Enseignements pour le produit

1. **La coupure ne doit pas reposer uniquement sur la fin du mot précédent.** wav2vec2 raccourcit les voyelles tenues. Correctif validé : `t_cut` est placé au **creux d'énergie de la piste voix isolée** entre le mot précédent et le trou (`gap.valley_cut`). Résultat : le niveau de la voix au point de coupure passe de −25 dB (note coupée net) à un silence complet.
2. **La marge peut être très faible quand le chant est continu** (trou A : 50 ms entre la coupure et le premier mot). L'aperçu à l'écoute dans le studio reste obligatoire.
3. Réglage **`overlap=2`** pour RoFormer : 3,3 fois plus rapide, sans perte audible.
4. Il faut **renseigner l'artiste tel qu'il apparaît dans LRCLIB** (« Disney » ici, pas « Laura Mayne »). Le filtre sur la durée a sélectionné la bonne version. Dans le produit : recherche puis tri par écart de durée, et l'hôte confirme le résultat.
5. Une zone mal alignée a été repérée vers 0:25–0:38 : un mot isolé est placé avant un interlude. Il faut un recalage en lot dans l'éditeur (risque déjà prévu dans le plan).

## Synthétique (contrôle)

Voix TTS posée sur un fond musical généré : erreur médiane de **24 ms** au début des phrases (max 131 ms), résidu de Δ −43 dB.

## Reste à faire pour clore la phase 0

- [x] Écoute humaine des extraits trou A et trou B : **coupure propre, aucune voix audible** (validé par l'utilisateur le 2026-11-06). Critère (b) ✅ sur ce titre.
- [ ] Deux à quatre autres titres : un rap ou un débit rapide, un titre avec beaucoup de chœurs, un titre ancien en mono, un titre en anglais.
- [ ] Comparaison htdemucs_ft contre BS-RoFormer sur un titre (`--sep htdemucs_ft`).
- [ ] Temps sur CPU (`--cpu`) pour documenter le repli.
