#!/usr/bin/env bash
set -euo pipefail
cd /home/ubuntu/CatetinDulu
sudo chown 1000:1000 secrets/test-workflow.json secrets/test-credentials.json
sudo chmod 600 secrets/test-workflow.json secrets/test-credentials.json
docker compose exec -T n8n n8n import:credentials --input=/run/catetin-secrets/test-credentials.json
docker compose exec -T n8n n8n import:workflow --input=/run/catetin-secrets/test-workflow.json
docker compose exec -T n8n n8n publish:workflow --id=catetinDuluIntegrationTest
docker compose restart n8n
