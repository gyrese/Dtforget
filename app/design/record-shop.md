# Direction visuelle — Le disquaire

L’interface évoque une collection de disques que l’on sort pour une soirée entre amis.

- Fond papier crème `#f4efdf`, encre `#292820`, action vermillon `#bd3827`, accent forêt `#286151`.
- Titres Georgia, textes et contrôles Trebuchet MS avec secours système ; la nouvelle direction ne dépend pas de polices distantes.
- Grandes compositions typographiques, filets fins, coins presque droits et pochettes imprimées. Pas de halos ni de surfaces vitrées.
- Les trois pochettes SVG sont produites par `node scripts/create-record-art.mjs` depuis `app/`. Les images personnalisées restent prioritaires.
- `host-redesign.css` porte la direction de l’écran hôte ; `play-redesign.css` celle du téléphone.
- Conserver des cibles tactiles de 44 px au minimum, les contours de focus, la réduction du mouvement et le compteur toujours visible pendant les paroles.

Vérification : `npm test`, `npm run test:host`, `node scripts/e2e-record-shop.mjs` et `BASE=http://localhost:3210 npm run test:game` (adapter la syntaxe de variable à votre shell). Captures dans `e2e-shots/`.
