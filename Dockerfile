# Image du serveur en ligne : le jeu, sa bibliothèque et l'atelier, dont les traitements lourds sont confiés
# au PC qui s'y connecte (app/agent.js) avec sa carte graphique.
# Les extraits (audio, paroles) arrivent par l'envoi depuis l'atelier et vivent dans le volume /srv/app/data.
FROM node:22-alpine
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev
COPY app/ ./
ENV NODE_ENV=production PORT=3000 ATELIER=remote
EXPOSE 3000
CMD ["node", "server.js"]
