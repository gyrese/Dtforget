# DtForget — spike karaoké

Prototype de pipeline pour « N'oubliez pas les paroles » : extrait d'une chanson, séparation voix/instrumental, alignement des paroles, choix d'un trou, coupure silencieuse.

## Serveur en ligne (VPS)

Le VPS héberge le jeu, la bibliothèque et l'atelier. Les traitements lourds de l'atelier (séparation de la voix,
paroles, extrait) sont faits par le PC, qui a la carte graphique : un petit agent s'y connecte au VPS et
récupère le travail tout seul.

1. **Image** : chaque push sur `main` déclenche `.github/workflows/docker-latest.yml`, qui publie
   `ghcr.io/gyrese/dtforget:latest` sur le registre de GitHub, sans secret à configurer. Le paquet est public :
   le VPS le tire sans identifiants. L'image ne contient que le code de `app/`, aucune chanson.
2. **VPS** : une commande installe tout (dossier `~/dtforget`, `compose.yml`, jeton et code d'atelier tirés
   au hasard, démarrage) :

   ```bash
   curl -fsSL https://raw.githubusercontent.com/gyrese/Dtforget/main/deploy/install-vps.sh | bash -s -- dtforget.mondomaine.fr
   ```

   Elle affiche le mot de passe admin. Il reste à
   pointer le domaine vers `dtforget:3000` dans le proxy (WebSocket activé, gros envois acceptés).
   Relancée sans argument, la même commande met l'image à jour en gardant les réglages.
3. **PC** : ouvrir `https://<domaine>/admin.html`, entrer le mot de passe admin, télécharger l'atelier
   pour Windows et copier le code de liaison. Lancer le .exe : il demande ce code au premier lancement, puis
   installe seul ses outils d'IA (voir ci-dessous).

## Application de bureau de l'atelier (Windows)

`DtForget-Atelier.exe` est un exécutable portable : l'atelier s'ouvre dans sa propre fenêtre, traite la chanson
sur le PC (carte graphique NVIDIA obligatoire) et envoie l'extrait fini au serveur en ligne. Rien d'autre à
installer : ni Python, ni Node, ni navigateur.

- **Premier lancement** : l'application télécharge Python, PyTorch (CUDA) et ffmpeg, environ 8 Go, dans le
  dossier `DtForget-Atelier-data` créé à côté du .exe. La première analyse télécharge en plus les modèles
  (séparation des voix et Whisper, environ 4 Go).
- **Liaison au serveur** : coller le code `dtf1.…` affiché sur la page `/admin.html` du serveur. Modifiable ensuite par le menu
  Réglages → Serveur en ligne. Sans code, les extraits restent sur le PC.
- **Listes** : l'application propose les listes du serveur en ligne ; l'extrait y est ajouté à l'envoi.
- **Déplacer le dossier** : possible, l'environnement Python est reconstruit au lancement suivant.
- Le .exe n'est pas signé : Windows SmartScreen demande une confirmation au premier lancement.

Il est construit par `.github/workflows/atelier-exe.yml`, publié dans la release GitHub `atelier`, et relayé
par le serveur sur `/admin.html` (mot de passe `ADMIN_PASSWORD`, ou à défaut `ATELIER_PIN`), à chaque push qui touche `desktop/`, `app/` ou le
pipeline. En local : `npm ci --omit=dev` dans `app/`, puis `npm install && npm run dist` dans `desktop/`.

L'atelier existe aussi sous deux autres formes, sans l'application : en page web sur le PC (`npm start` dans
`app/`, puis `/atelier.html`), et en page web sur le VPS avec un agent sur le PC qui prête sa carte graphique
(`app/scripts/install-agent.ps1 -Url … -Token …`, puis `/atelier.html` sur le VPS avec le code d'atelier).

Le visualiseur du spike (extraits de `spike/out/viewer/`) se lance à part : `docker compose up`, puis
http://localhost:8080.

## Pipeline (local)

Environnement géré par `uv` dans `spike/` (Python 3.12, CUDA recommandé). Voir `spike/pyproject.toml`.

Les chansons et les sorties vont dans `spike/songs/` et `spike/out/`, ignorés par Git.


## Jeu Host

Dans `app/` : `npm install`, puis `npm start`. Ouvrir `/host.html` sur le grand écran.
Choisir un univers, explorer sa collection, régler 3, 5 ou 10 manches et créer le salon.
Le nombre de manches est limité aux chansons distinctes de la liste. Les téléphones scannent
le QR code (même réseau Wi-Fi) ou ouvrent `/play.html` et saisissent le code du salon.

La bibliothèque permet de créer et modifier les listes, rechercher les chansons, sélectionner
plusieurs titres et partager une chanson entre plusieurs univers. Les listes sont conservées
dans `app/data/lists.json`, ignoré par Git. Les parties utilisent une copie de la sélection
au moment de la création du salon.

Les animations sont servies localement : GSAP pour les transitions des écrans, Anime.js pour
les pochettes, Lottie pour le classement final. La préférence de réduction du mouvement est respectée.

Validation : `npm test`; avec le serveur lancé, `npm run test:host`, `npm run test:game`
et `npm run test:reconnect` (Chrome installé). La variable `BASE` permet de changer le serveur cible.
Les captures de validation restent dans `app/e2e-shots/`.

## Atelier : ajouter une chanson

Depuis l'écran hôte, « + Ajouter une chanson » ouvre `/atelier.html` :

1. déposer une vidéo ou un fichier audio, vérifier le titre et l'artiste (ou le film) ;
2. le serveur extrait l'audio, sépare la voix, écoute la chanson et cherche ses paroles sur LRCLIB ;
3. si aucune fiche ne correspond, une recherche LRCLIB (ou un collage manuel) permet de choisir les paroles ;
4. cliquer sur le premier puis le dernier mot du passage à deviner : la voix est retirée sur ce passage
   et l'extrait s'arrête 5 secondes après.

L'analyse est faite par `spike/atelier.py`, lancé par `app/pyworker.js` avec le Python de `spike/.venv`
(variable `ATELIER_PYTHON` pour en changer). Un seul traitement à la fois. Les médias, pistes séparées
et extraits restent dans `app/data/workshop/` et `app/data/clips/`, ignorés par Git.