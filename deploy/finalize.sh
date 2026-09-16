#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/CatetinDulu
docker compose stop n8n
docker compose run --rm n8n import:workflow --input=/import/finance-message.json
docker compose run --rm n8n publish:workflow --id=catetinDuluFinance
docker compose run --rm n8n unpublish:workflow --id=catetinDuluIntegrationTest
docker compose -f docker-compose.yml -f deploy/compose.oracle.yml up -d
# Preserve isolated test data for reproducible verification; its endpoint stays unpublished.
sudo chown -R "1000:$(id -g)" secrets
sudo chmod 750 secrets
sudo chmod 640 secrets/n8n-credentials.json secrets/test-credentials.json secrets/test-workflow.json
