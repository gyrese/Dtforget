# DtForget — spike karaoké

Prototype de pipeline pour « N'oubliez pas les paroles » : extrait d'une chanson, séparation voix/instrumental, alignement des paroles, choix d'un trou, coupure silencieuse.

## Visualiseur (Docker)

Le visualiseur lit les extraits générés dans `spike/out/viewer/` (audio et paroles). Ces données ne sont pas dans Git.

```bash
docker compose up
```

Puis ouvrir http://localhost:8080.

## Pipeline (local)

Environnement géré par `uv` dans `spike/` (Python 3.12, CUDA recommandé). Voir `spike/pyproject.toml`.

Les chansons et les sorties vont dans `spike/songs/` et `spike/out/`, ignorés par Git.
