#!/usr/bin/env bash
# Provision (or re-provision) the hosted beta on a fresh Ubuntu ARM VM.
# The VM is cattle: this script + the newest R2 backup IS the recovery plan,
# and it must be drilled once before pilot #1 (GOTOMARKET M1 gate).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MaxwellCalkin/money.git}"
BRANCH="${BRANCH:-main}"
DIR="${DIR:-/opt/agentmoney}"

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v rclone >/dev/null; then
  curl -fsSL https://rclone.org/install.sh | bash
fi

if [ ! -d "$DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR" && git fetch origin "$BRANCH" && git checkout "origin/$BRANCH" -- . 2>/dev/null || git pull

cd "$DIR/deploy/beta"
if [ ! -f beta.env ]; then
  echo "beta.env is missing — copy beta.env.example, fill it, chmod 600, and re-run." >&2
  exit 1
fi
chmod 600 beta.env
set -a; . ./beta.env; set +a

docker compose -f compose.beta.yaml up -d postgres
sleep 8

LATEST_BACKUP=$(rclone lsf "r2:${R2_BUCKET:-agentmoney-beta-backups}" 2>/dev/null | sort | tail -1 || true)
if [ -n "$LATEST_BACKUP" ] && [ ! -f .restored ]; then
  echo "Newest backup: $LATEST_BACKUP"
  read -r -p "Restore it into this fresh database? [y/N] " answer
  if [ "$answer" = "y" ]; then
    if [ -z "${BACKUP_AGE_KEY_FILE:-}" ] || [ ! -f "$BACKUP_AGE_KEY_FILE" ]; then
      echo "Set BACKUP_AGE_KEY_FILE to the age private key file (kept OFF this VM normally)." >&2
      exit 1
    fi
    rclone cat "r2:${R2_BUCKET:-agentmoney-beta-backups}/$LATEST_BACKUP" \
      | age -d -i "$BACKUP_AGE_KEY_FILE" \
      | gunzip \
      | docker compose -f compose.beta.yaml exec -T postgres psql -U money -d money
    touch .restored
  fi
fi

docker compose -f compose.beta.yaml up -d --build

# DuckDNS refresh + nightly backup crons (idempotent).
( crontab -l 2>/dev/null | grep -v 'duckdns\|backup.sh' ;
  echo "*/5 * * * * curl -fsS 'https://www.duckdns.org/update?domains=${BETA_HOSTNAME%%.*}&token=${DUCKDNS_TOKEN}&ip=' >/dev/null" ;
  echo "17 3 * * * $DIR/deploy/beta/backup.sh >> /var/log/agentmoney-backup.log 2>&1"
) | crontab -

echo "Beta stack is up. Verify: curl -fsS https://${BETA_HOSTNAME}/health/ready"
