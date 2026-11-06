# DtForget : plan « N'oubliez pas les paroles »

> v2 (2026-11-06). Synthèse de 5 agents : explore (cartographie de LTNhout), document-specialist (veille IA), analyst (règles et risques), architect (confrontation au code), critic (revue adverse).

## 1. Vision

Un hôte importe une chanson (vidéo ou audio). L'IA sépare la voix de l'instrumental, puis récupère ou transcrit les paroles avec un timing mot par mot. L'hôte corrige les paroles et choisit un passage à trou. En partie, l'écran principal joue la chanson en karaoké. Arrivé au trou, il ne reste que l'instrumental et les paroles deviennent des tirets. Les joueurs tapent les mots manquants sur leur téléphone. La révélation se fait mot par mot, en vert ou en rouge.

**Contexte visé pour le MVP :** soirées privées, joueurs dans la même pièce, LAN, un seul hôte, un seul GPU.

## 2. Décisions d'architecture

| # | Sujet | Décision |
|---|---|---|
| D1 | Rendu | **En direct dans le navigateur hôte**, sans MP4 pré-rendu. Les paroles sont superposées en HTML et pilotées par `media.currentTime` (et `requestVideoFrameCallback`). L'export MP4 (ffmpeg + ASS `\kf`) est reporté en V2. |
| D2 | Média | **Un seul `<video>` par manche.** À la préparation, on fabrique le mix troué (original, puis instrumental à partir de `t_cut`, fondu de 80 ms), qu'on **remuxe dans la vidéo** (`ffmpeg -map 0:v -map 1:a -c:v copy`). Pour une chanson sans vidéo : pochette ou fond fixe. Audio en Opus/WebM, ou décalage AAC mesuré et compensé. |
| D3 | Son | **Uniquement sur l'écran hôte.** Les téléphones servent de manettes. Réglage `audioOffsetMs` pour compenser une enceinte Bluetooth ou HDMI. Bouton « Démarrer » obligatoire (règles d'autoplay). |
| D4 | Coupure (`t_cut`) | `t_cut` = fin du mot qui précède le trou + une petite marge, **et non** le début du premier mot du trou. Un aperçu de ±3 s autour de la coupure est obligatoire avant de sauvegarder la manche. |
| D5 | Paroles | Ordre de recherche : LRCLIB `/api/get`, puis `/api/search` (`plainLyrics`), puis paroles collées par l'hôte, puis ASR en dernier recours. Ensuite, **alignement forcé au mot** sur la voix isolée. La revue humaine du passage à trou est obligatoire. |
| D6 | Réutilisation de LTNhout | **Repo neuf + copie sélective du noyau**, pas de fork suivi d'un nettoyage (voir §4). |
| D7 | Worker IA | **Un seul processus FastAPI** (les modèles restent chargés, concurrence 1). Échanges en HTTP dans les deux sens, **sans Redis ni BullMQ**. |
| D8 | Saisie | Une seule zone de texte, compteur X/N mots en direct, `autocorrect`, `autocapitalize` et `spellcheck` désactivés. Le brouillon est **soumis automatiquement** à l'échéance, et reste modifiable jusque-là. |
| D9 | Normalisation | **Découper en mots d'abord, puis normaliser chaque mot** : casse, accents, œ/æ, apostrophes ’/', ponctuation, chiffres en lettres pour les nombres simples. Les élisions (« j'ai ») sont séparées en deux mots (« j » + « ai »), et la même règle s'applique à la référence et à la saisie. ⚠️ `normalizeAnswer` de LTNhout supprime **tous** les espaces : il ne convient qu'à un seul mot. |
| D10 | Scoring | Alignement avec coût (Needleman-Wunsch) entre la référence et la saisie, **pénalité pour les mots en trop**, saisie tronquée à N+2 mots. 1 point par mot juste à sa place, plus un bonus « parfait ». **Pas de bonus de vitesse** dans le MVP. Mode « indulgent » activé par défaut : 1 lettre d'écart tolérée pour les mots de plus de 5 lettres, à cause de l'autocorrection iOS. L'hôte peut forcer un mot en vert. |
| D11 | Taille du trou | MVP : **3 à 15 mots**. `level` = gain affiché (style TV), sans lien avec le nombre de mots, qui s'affiche à part. `answerTimeS = 20 + 3 × N`. |

## 3. Architecture

```
┌──────────── packages/web (Vite 8 / React 19 / TanStack Router / zustand) ─────┐
│ /                   Joueur : PIN → pseudo → manette (saisie du trou)           │
│ /party/manager/:id  Écran hôte : <video> karaoké + scores (son ici seulement)  │
│ /manager/songs      Bibliothèque, upload, suivi, éditeur paroles, choix du trou│
└───────────────▲──────────────────────────────────▲────────────────────────────┘
                │ Socket.IO /ws (noyau LTNhout)    │ HTTP upload ; /media/ servi par nginx (Range)
┌───────────────┴──── packages/socket (Express 5 + Socket.IO 4.8) ──────────────┐
│ Copié : Registry, PlayerManager, CooldownTimer (+ pause/resume), logger,      │
│   recovery-links, auth manager, utils (safe-handler, rate-limit, validate…)   │
│ Nouveau : Game allégé, LyricsRoundManager, SongService, JobClient             │
│ Route /internal/jobs/:id/progress (secret partagé, non exposée par nginx)     │
│ Progression → room `song-owner-${clientId}` : SONGS.PROGRESS {songId,step,%}  │
└───────────────┬───────────────────────────────────────────────────────────────┘
                │ POST /jobs {songId, dir}           ▲ POST progress / done
┌───────────────▼──── worker/ (Python 3.12, FastAPI, 1 process, asyncio.Queue) ─┐
│ Étapes idempotentes (sautées si l'artefact existe) ; modèles déchargés entre   │
│ étapes pour tenir dans 8 Go de VRAM :                                          │
│ 1 ffprobe/ffmpeg : contrôle, WAV 44,1 kHz, transcodage H.264 si vidéo exotique │
│ 2 audio-separator (Mel-Band/BS-RoFormer) → vocals.flac / instru.flac           │
│ 3 LRCLIB get → search → plainLyrics (titre et artiste saisis par l'hôte)       │
│ 4 faster-whisper large-v3 sur vocals (VAD, condition_on_previous_text=False,   │
│   word_timestamps, liste noire d'hallucinations, marquage uncertain si         │
│   avg_logprob/compression_ratio mauvais)                                       │
│ 5 alignement forcé au mot : stable-ts align / WhisperX align (texte de réf.)   │
│ 6 Claude : suggestions de trous + diffs ciblés {wordId, suggestion}            │
│   → jamais le texte intégral en sortie                                         │
│ 7 à la demande (manche) : résidu vocal sur la fenêtre du trou + mix troué     │
│   + remux dans la vidéo → round-<id>.webm                                      │
└────────────────────────────────────────────────────────────────────────────────┘
Stockage : MEDIA_PATH/songs/<id>/{source.*, video.*, vocals.flac, instru.flac, round-<id>.*}
           (hors config/uploads, que LTNhout purge) ; métadonnées dans config/songs/*.json
```

## 4. Ce qu'on reprend de LTNhout

**Copier tel quel :**
- `common` : `constants.ts` (épuré) ;
- `socket` :
  - `services/game/{cooldown-timer,player-manager,logger,recovery-links}.ts` ;
  - `services/{registry,manager}.ts` ;
  - `utils/{safe-handler,atomic-write,rate-limit,same-origin,client-ip,validate,timeout,sleep,password}.ts` ;
  - séquence de démarrage `index.ts:620-897` ;
- `web` : `socket-context.tsx` (reconnexion, horloge SNTP `getServerTime()`), écrans PIN/pseudo/lobby (`Room.tsx`, QR), `Leaderboard`, `Podium`, `components/*`, i18n + `check-i18n.mjs`, avatars, wake lock.

**Adapter :**
- `services/game/index.ts` → `Game` allégé, sans power-ups, soirée ni pièces ;
- `persistence.ts` : le snapshot passe de `quizz` à `playlist + rounds`, et le brouillon est indexé par clientId ;
- `CooldownTimer` : ajouter `pause()` et `resume()`, qui émettent `ROUND_EXTENDED`.

**Réécrire :**
- `round-manager.ts` → `LyricsRoundManager` : même interface publique, on reprend le schéma `await cooldown.start()` puis `if (!started) return`, la double émission joueur/hôte, les acks et `getCheckpoint`/`restoreCheckpoint` ;
- types `Question`/`Quizz` → `Song`/`Round`/`Playlist` ;
- éditeur de quiz (Konva) → studio de chansons.

**Ne pas reprendre :** power-ups, mode soirée, IA quiz, PPTX, présentation, solo. Le duel de départage est optionnel.

Estimation : 2 à 3 j, contre 3 à 5 j pour un fork suivi d'un nettoyage. En contrepartie, les tests e2e lobby/reconnexion sont à reporter.

⚠️ Le web garde le mot de passe hôte en clair dans `localStorage` (`rc_pwd`) : à corriger au passage.

## 5. Machine d'états

Statuts gardés : `SHOW_ROOM`, `SHOW_START`, `SHOW_RESULT`, `SHOW_LEADERBOARD`, `FINISHED`, `WAIT`, `PAUSED`.
Statuts nouveaux : `SONG_INTRO`, `PLAYING`, `GAP_INPUT`, `REVEAL`.

```
SHOW_ROOM → SHOW_START → SONG_INTRO (titre, artiste, gain, nb de mots, 3-2-1)
 → PLAYING   hôte : paroles complètes + trou (statut HÔTE uniquement)
             joueurs : { gapWordCount, endsAtEstimate } seulement
             hôte → host:playbackStarted{mediaTime} ; le serveur arme un filet
             de sécurité cooldown(leadIn + 3 s)
 → host:cutReached{roundId} (idempotent) → cooldown.abort(), cutBy: host|timeout
 → GAP_INPUT cooldown.start(20 + 3N), startedAt/endsAt diffusés ; l'instrumental continue
             player:gapDraft (debounce) / player:gapSubmit (ack)
 → REVEAL    hôte : mots officiels un par un + scores agrégés
             chaque téléphone : sa propre correction vert/rouge
             manager:forceWordCorrect ; bouton « réécouter l'original »
 → SHOW_LEADERBOARD → manche suivante … → FINISHED (podium)
```

Robustesse :
- `host:playbackStalled`/`Resumed` → `CooldownTimer.pause()/resume()`.
- `playbackStartedAt` est stocké côté serveur, ce qui permet de reprendre la lecture au bon endroit quand l'hôte se reconnecte.
- Les médias de chanson ne sont **jamais** préchargés sur les téléphones (exclusion dans `MEDIA_PRELOAD`).
- `host:mediaReady` n'est émis que lorsque `buffered` couvre `[0, gap.endMs]`.

## 6. Modèle de données

```ts
Song { id, title, artist, language, durationMs,
  source: { kind: "video"|"audio", originalPath, playbackVideoPath? },
  stems: { vocals, instrumental },
  lyrics: { version: number, source: "lrclib"|"pasted"|"asr", reviewed: boolean, lines: Line[] },
  processing: { status, steps: Record<Step, { state, progress, error? }> } }
Line { id, startMs, endMs, words: Word[] }
Word { id, text, startMs, endMs, confidence, uncertain?: boolean }
Round { id, songId, lyricsVersion, level, gap: { firstWordId, lastWordId, cutMs, endMs },
  leadInMs (≥ 5000), answerTimeS, mediaPath, vocalResidueDb, acceptedVariants?: Record<wordId, string[]> }
Playlist { id, name, roundIds[] }
```

Si `lyrics.version` change, les `Round` liés passent en « à revalider » et leur média est régénéré.

## 7. Sécurité et limites

- **Upload :** route dédiée (multer audio/vidéo, 500 Mo, 8 min). Contrôle ffprobe côté worker, octets magiques.
- **nginx :** `client_max_body_size 600m` et `proxy_request_buffering off` sur `/api/songs/upload`. La configuration actuelle de LTNhout est à 25 Mo, ce qui donnerait une erreur 413.
- **Médias :** servis par nginx sous `/media/`, avec prise en charge native des requêtes Range pour le seek. Les URL sont **signées ou utilisent un jeton non devinable**, car `<video>` n'envoie pas l'en-tête `x-client-id`. Les stems et le JSON des trous ne sont jamais accessibles aux joueurs.
- **Docker :** le conteneur worker est séparé (`nvidia/cuda`, réservation GPU dans compose). Sous Windows : Docker Desktop avec WSL2 et GPU, **ou** worker lancé en natif (recommandé pour le dev).

## 8. Phases et estimations (≈ 30 à 40 jours)

**Phase 0 : spike de faisabilité, avec un go/no-go (3 à 4 j)**
- Valider l'installation torch, CUDA, ctranslate2/cuDNN 9 et WhisperX sous Windows. C'est souvent le point le plus pénible.
- Préparer 7 chansons (5 FR, dont des titres anciens, et 2 EN). Pour chacune, **annoter à la main** les mots de 2 ou 3 trous, qui servent de vérité terrain.
- Comparer :
  - RoFormer, htdemucs_ft et LALAL.AI ;
  - faster-whisper + alignement et Scribe v2 ;
  - avec et sans LRCLIB.
- Critères mesurés :
  - (a) écart médian de timing au mot ≤ 150 ms sur les trous annotés ;
  - (b) **aucune voix audible** dans [t_cut − 50 ms, t_cut + 2 s] (écoute + seuil RMS à étalonner) ;
  - (c) taux de réussite de LRCLIB sur 20 titres FR ;
  - (d) temps de traitement sur GPU et sur CPU.
- Go/no-go :
  - si (b) échoue sur plus de 30 % des cas → passer à LALAL.AI par API ;
  - si (c) est inférieur à 50 % → paroles collées par l'hôte en mode par défaut, ASR seulement en suggestion ;
  - sans GPU → préparation plusieurs heures avant la soirée (CPU : 10 à 30 min par titre) ou API.

**Phase 1 : noyau temps réel (2 à 3 j).** Repo neuf, copie sélective (§4), Game allégé, pause/resume dans CooldownTimer. Tests : lobby, reconnexion, takeover.

**Phase 2 : worker IA + upload (8 à 12 j).**
- FastAPI, file de jobs, étapes idempotentes, callbacks de progression, route d'upload, `MEDIA_PATH`.
- UI de suivi en direct (`SONGS.PROGRESS`), relance d'une étape en échec.

**Phase 3 : studio de préparation (5 à 6 j).**
- Bibliothèque et liste de suivi.
- Éditeur de paroles : texte, décalage ±50 ms par mot, **recalage en lot** d'une ligne ou d'une plage, boucle de lecture, relance de l'alignement, mots `uncertain` en surbrillance.
- Diffs proposés par Claude (accepter ou refuser).
- Sélection du trou : suggestions Claude, alerte de résidu vocal, alerte si le passage est un refrain répété.
- Aperçu de ±3 s, sauvegarde de la manche, playlists simples.

**Phase 4 : gameplay (5 à 6 j).**
- `LyricsRoundManager` et nouveaux statuts.
- Lecteur karaoké côté hôte : mot courant surligné, masquage du trou, `audioOffsetMs`.
- Manette côté joueur.
- Normalisation et scoring (D9, D10).
- Révélation, classement, podium.

**Phase 5 : robustesse et packaging (3 à 4 j).** Buffering, reconnexion pendant la lecture, test de charge (10 joueurs, 5 manches), Docker compose (web + socket + worker), purge configurable des médias.

**V1.5 / V2 :**
- Modèle UVR « karaoke » (voix principale / chœurs).
- AcoustID pour l'identification automatique.
- Repli cloud (Modal/RunPod).
- i18n EN.
- Export MP4.
- Modes « La Même Chanson » et « Maestro » (duel des deux premiers).
- Audio sur les téléphones (jeu à distance).
- Juge Claude pour les cas gris.

## 9. Critères d'acceptation clés (MVP)

- **AC-norm :** `J’ai` = `j'ai` = `J AI` ; `Être` = `etre` ; `coeur` = `cœur` ; `deux` = `2` ; `c'est` ≠ `ses`.
- **AC-align :** pour la référence `a b c d` et la saisie `a c d`, le joueur a 3 mots justes. La saisie `a b x c d` donne 4 mots justes moins la pénalité, et pas de bonus « parfait ».
- **AC-spam :** une rafale de mots fréquents (« je la de et que tu le ») sur un trou de 7 mots qui n'en contient aucun donne 0 point.
- **AC-leak :** aucun payload envoyé à un joueur pendant `PLAYING` ou `GAP_INPUT` ne contient les mots du trou (test automatisé sur les événements émis).
- **AC-cut :** dans l'aperçu, aucun mot du trou n'est audible avant `t_cut`, et la bascule audio se fait à ±50 ms de `t_cut`.
- **AC-sync :** surlignage karaoké décalé de 200 ms au plus par rapport à l'audio, une fois `audioOffsetMs` réglé.
- **AC-input :** les téléphones passent en mode saisie au plus 500 ms après `host:cutReached`. Une réponse arrivée plus d'1 s après `endsAt` est ignorée, et le brouillon est soumis automatiquement.
- **AC-reconnect :** un joueur qui recharge la page pendant la saisie retrouve la phase en cours et son brouillon en 3 s au plus.
- **AC-persist :** chansons, stems, paroles et manches survivent à un redémarrage. Si on modifie les paroles, les manches liées passent en « à revalider ».

## 10. Stack IA retenue

| Rôle | Principal | Repli |
|---|---|---|
| Séparation | audio-separator + Mel-Band RoFormer (Kim) / BS-RoFormer (viperx) | htdemucs_ft (MIT), LALAL.AI (API) |
| Paroles de référence | LRCLIB (get → search) | paroles collées par l'hôte, Musixmatch (payant) |
| Transcription | faster-whisper large-v3 sur la voix isolée | large-v3-turbo, ElevenLabs Scribe v2 (~0,015 $/titre) |
| Timing au mot | stable-ts `align` / WhisperX align (wav2vec2 FR/EN) | ctc-forced-aligner (⚠️ MMS en CC-BY-NC) |
| Suggestions et diffs | Claude Sonnet 5.5 (`claude-sonnet-5-5`), sortie JSON validée, indices et diffs uniquement | choix manuel |
| Validation des réponses | règles déterministes + RapidFuzz | Claude Haiku 5.5 pour les cas gris (V2) |
| Rendu | `<video>` + overlay HTML | ffmpeg + ASS `\kf` (export, V2) |

## 11. Risques

1. **Qualité de l'ASR sur le chant et hallucinations de Whisper :** paroles de référence, liste noire, marquage `uncertain`, revue obligatoire.
2. **Chœurs qui restent dans l'instrumental :** mesure du résidu sur la fenêtre du trou, alerte, choix d'un autre passage. Le modèle karaoke viendra en V1.5.
3. **Wav2vec2 sur des voix tenues et des mélismes :** les fins de mots dérivent, d'où le recalage en lot dans l'éditeur.
4. **Pas de GPU :** CPU à 10 à 30 min par titre, préparation bien avant la soirée, ou API.
5. **Claude et les paroles protégées :** Claude ne renvoie jamais le texte intégral. Il ne produit que des indices et des diffs, que l'hôte valide.
6. **Licences :** les poids RoFormer/UVR et MMS sont souvent non commerciaux ou sans licence claire. C'est acceptable pour un **usage privé en LAN**. Un hébergement public ou commercial exige de changer de modèles ou de passer par des API sous licence, et de régler les droits sur les paroles et les enregistrements (SACEM, éditeurs).
7. **Latence de sortie audio (Bluetooth/HDMI) :** réglage `audioOffsetMs`.

## 12. Questions ouvertes

- La machine de traitement a-t-elle un GPU NVIDIA ? Combien de VRAM ?
- Usage confirmé : privé, en LAN, dans la même pièce ?
- Mode « indulgent » activé par défaut : OK, ou orthographe stricte comme à la télé ?
- Garder le duel de départage et la télécommande de LTNhout ?
