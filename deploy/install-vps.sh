#!/usr/bin/env bash
# Installe ou met à jour DtForget sur le VPS, en une commande :
#   curl -fsSL https://raw.githubusercontent.com/gyrese/Dtforget/main/deploy/install-vps.sh | bash -s -- dtforget.mondomaine.fr
# Relancée sans argument, elle met simplement l'image à jour en gardant les réglages.
set -euo pipefail

DIR="${DTFORGET_DIR:-$HOME/dtforget}"
RAW="https://raw.githubusercontent.com/gyrese/Dtforget/main"
mkdir -p "$DIR" && cd "$DIR"
curl -fsSL -o compose.yml "$RAW/compose.yml"

if [ ! -f .env ]; then
  DOMAIN="${1:-}"
  if [ -z "$DOMAIN" ]; then echo "Indiquez le domaine : ... | bash -s -- dtforget.mondomaine.fr" >&2; exit 1; fi
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
  TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  PIN="$(head -c 64 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 12)"
  umask 077
  printf 'PUBLIC_URL=https://%s\nIMPORT_TOKEN=%s\nATELIER_PIN=%s\n' "$DOMAIN" "$TOKEN" "$PIN" > .env
fi

docker network inspect nginx-proxy-network >/dev/null 2>&1 || docker network create nginx-proxy-network >/dev/null
docker compose pull -q
docker compose up -d

# shellcheck disable=SC1091
. ./.env
echo
echo "DtForget tourne. Dans le proxy, pointez ${PUBLIC_URL#https://} vers dtforget:3000 (http, WebSocket activé)."
echo "Mot de passe admin : $ATELIER_PIN"
echo
echo "Atelier pour Windows et code de liaison : ${PUBLIC_URL}/admin.html (avec ce mot de passe)."
