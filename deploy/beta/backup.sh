#!/usr/bin/env bash
# Nightly encrypted logical backup to Cloudflare R2 (free tier).
# Also legitimate CPU: Always Free tenancies reclaim idle instances.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./beta.env; set +a

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f compose.beta.yaml exec -T postgres \
  pg_dump -U money -d money --no-owner \
  | gzip \
  | age -r "$BACKUP_AGE_RECIPIENT" \
  | rclone rcat "r2:${R2_BUCKET:-agentmoney-beta-backups}/money-${STAMP}.sql.gz.age"

# Keep the newest 14; the journal is append-only so dailies compose cleanly.
rclone lsf "r2:${R2_BUCKET:-agentmoney-beta-backups}" | sort | head -n -14 \
  | while read -r old; do rclone delete "r2:${R2_BUCKET:-agentmoney-beta-backups}/$old"; done

echo "backup money-${STAMP} shipped"
