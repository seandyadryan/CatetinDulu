#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test -f .env && test -f secrets/n8n-credentials.json
chmod 600 .env
sudo chown -R "1000:$(id -g)" secrets
sudo chmod 750 secrets
sudo chmod 640 secrets/n8n-credentials.json
if docker network inspect ai-chat_default >/dev/null 2>&1; then
 export COMPOSE_FILE=docker-compose.yml:deploy/compose.oracle.yml
fi
docker compose up -d postgres
docker compose pull n8n
docker compose build gateway
docker compose run --rm n8n import:credentials --input=/run/catetin-secrets/n8n-credentials.json
docker compose run --rm n8n import:workflow --input=/import/finance-message.json
docker compose run --rm n8n publish:workflow --id=catetinDuluFinance
docker compose up -d
docker compose ps
