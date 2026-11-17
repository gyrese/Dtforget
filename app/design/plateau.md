# Direction visuelle — Plateau de nuit

L'interface évoque un plateau télé de jeu musical, salle éteinte : un projecteur ambre éclaire la scène et les mots qui manquent s'allument dans des cases cyan.

- Jetons dans `public/plateau.css` (chargé par toutes les pages) : fond `--night #0a0c14`, panneaux `--deck #121624`, texte `--chalk #f5f1e8`, action et mots chantés `--spot #ffb627`, trous et réponses `--led #46d9ec`, erreurs `--live #ff5a66`, bonne réponse `--hit #5fe08f`.
- Titres en Big Shoulders Display 900 capitales, textes et paroles en Archivo, codes et scores en JetBrains Mono. Les polices sont servies depuis `public/fonts/` (SIL OFL) : aucune dépendance à Internet pendant une soirée.
- Ambre = ce qu'on fait ou ce qui est chanté. Cyan = ce qu'il faut trouver. Jamais les deux sur le même rôle.
- Les cases lumineuses (`.w.hole`) sont la signature : bordure cyan 2 px, halo doux, tirets espacés.
- Coins arrondis 6 / 10 / 16 px, filets fins `--rule`, bordures de contrôles `--rule-strong` (3:1). Pas de dégradés violets ni de verre dépoli.
- `host-redesign.css` porte l'écran hôte, `play-redesign.css` le téléphone ; l'atelier et l'admin gardent leur style en ligne sur les mêmes jetons.
- Pochettes par défaut : `node scripts/create-record-art.mjs` depuis `app/`. Les images personnalisées restent prioritaires.
- Conserver les cibles tactiles de 44 px minimum, les contours de focus cyan, la réduction du mouvement et le compteur toujours visible pendant les paroles.
- Contrastes vérifiés : texte secondaire `--haze` 9:1, paroles à venir `--dim` 6,2:1 sur le fond.

Vérification : `npm test`, `npm run test:host`, `node scripts/e2e-record-shop.mjs` et `BASE=http://localhost:3210 npm run test:game`.
