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

   Elle affiche le code de l'atelier et la commande à coller sur le PC. Il reste à pointer le domaine vers
   `dtforget:3000` dans le proxy (WebSocket activé, gros envois acceptés : vidéos jusqu'à 800 Mo).
   Relancée sans argument, la même commande met l'image à jour en gardant les réglages.
3. **PC** : coller dans PowerShell, depuis `app/`, la commande affichée par le VPS :
   `.\scripts\install-agent.ps1 -Url https://… -Token …`. Elle écrit `app/.env` et installe l'agent, qui
   démarre ensuite tout seul à l'ouverture de session Windows, sans fenêtre (journal : `app/data/agent.log` ;
   retrait : `.\scripts\install-agent.ps1 -Remove`). Pour le lancer à la main : `npm run agent`.

Quand on ajoute une chanson sur l'atelier en ligne, le fichier monte au VPS, l'agent le récupère, l'analyse et
renvoie les paroles alignées ; les pistes séparées restent sur le PC (`app/data/agent/`). Si le PC est éteint,
la chanson attend et le traitement démarre dès que l'agent se reconnecte.

L'atelier fonctionne aussi entièrement sur le PC (`npm start`, puis `/atelier.html`) ; « Envoyer en ligne »
pousse alors les extraits finis vers le VPS.

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