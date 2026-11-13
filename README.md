# DtForget — spike karaoké

Prototype de pipeline pour « N'oubliez pas les paroles » : extrait d'une chanson, séparation voix/instrumental, alignement des paroles, choix d'un trou, coupure silencieuse.

## Serveur en ligne (VPS)

Le VPS héberge le jeu et sa bibliothèque ; l'atelier reste sur le PC, qui a la carte graphique.

1. **Image** : chaque push sur `main` déclenche `.github/workflows/docker-latest.yml`, qui publie
   `<compte Docker Hub>/dtforget:latest`. Secrets du dépôt GitHub : `DOCKERHUB_USERNAME` et `DOCKERHUB_TOKEN`.
   L'image ne contient que le code de `app/`, aucune chanson.
2. **VPS** : copier `compose.yml`, créer à côté un fichier `.env` avec `PUBLIC_URL` (adresse publique, pour le
   QR code) et `IMPORT_TOKEN` (un long jeton secret), puis `docker compose pull && docker compose up -d`.
   Le conteneur `dtforget` écoute sur le port 3000 du réseau `nginx-proxy-network`. Les extraits et les listes
   vivent dans `./data`.
3. **PC** : copier `app/.env.example` en `app/.env`, y mettre `PUBLISH_URL` (adresse du VPS) et `PUBLISH_TOKEN`
   (le même jeton), relancer `npm start`. L'atelier propose alors « Envoyer en ligne » après chaque extrait et
   « Envoyer toute la bibliothèque en ligne » sur sa première page. Les extraits partent en MP3 avec leurs
   paroles et les listes auxquelles ils appartiennent.

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

L'analyse est faite par `spike/atelier.py`, lancé par `app/workshop.js` avec le Python de `spike/.venv`
(variable `ATELIER_PYTHON` pour en changer). Un seul traitement à la fois. Les médias, pistes séparées
et extraits restent dans `app/data/workshop/` et `app/data/clips/`, ignorés par Git.
