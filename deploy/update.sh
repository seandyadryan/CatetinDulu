#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose exec -T postgres psql -U catetindulu -d catetindulu -v ON_ERROR_STOP=1 < db/schema.sql
docker compose stop n8n
docker compose run --rm n8n import:workflow --input=/import/finance-message.json
docker compose run --rm n8n publish:workflow --id=catetinDuluFinance
docker compose -f docker-compose.yml -f deploy/compose.oracle.yml up -d
python3 deploy/connect-proxy.py
