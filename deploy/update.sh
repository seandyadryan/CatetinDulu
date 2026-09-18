#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
dc=(docker compose -f docker-compose.yml -f deploy/compose.oracle.yml)
# Pause consumers, back up the consistent database, then migrate atomically.
"${dc[@]}" stop gateway n8n
trap '"${dc[@]}" up -d gateway n8n >/dev/null 2>&1 || true' ERR
umask 077
mkdir -p backups
backup="backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ).dump"
"${dc[@]}" exec -T postgres pg_dump -U catetindulu -d catetindulu -Fc > "$backup"
test -s "$backup"
"${dc[@]}" exec -T postgres pg_restore -l < "$backup" >/dev/null
"${dc[@]}" exec -T postgres psql -U catetindulu -d catetindulu -v ON_ERROR_STOP=1 < db/migrations/002_shared_workspaces.sql
"${dc[@]}" exec -T postgres psql -U catetindulu -d catetindulu -v ON_ERROR_STOP=1 < db/migrations/003_scheduled_messages.sql
"${dc[@]}" run --rm n8n import:workflow --input=/import/finance-message.json
"${dc[@]}" run --rm n8n publish:workflow --id=catetinDuluFinance
"${dc[@]}" up -d
trap - ERR
echo "Migration and workflow published. Database backup: $backup"
