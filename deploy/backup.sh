#!/usr/bin/env bash
# Cinderella backup — archive DB dump + media snapshot + env file.
# Schedule via cron or a systemd timer. Run as root (reads the env file).
#
#   /opt/cinderella/deploy/backup.sh [/backup/dir]
#
# Restore:
#   pg_restore -d cinderella <dump>           # into an empty DB owned by cinderella
#   tar -xzf <media.tar.gz> -C /var/lib/cinderella
#   install -m600 <env> /etc/cinderella/cinderella.env

set -euo pipefail

ENV_FILE="${CINDERELLA_ENV:-/etc/cinderella/cinderella.env}"
BACKUP_DIR="${1:-/var/backups/cinderella}"
MEDIA_ROOT="${MEDIA_ROOT:-/var/lib/cinderella/media}"
# Timestamp is passed by the environment when possible; fall back to `date`.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && set -a && . "$ENV_FILE" && set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL not set (check $ENV_FILE)" >&2
  exit 1
fi

install -d -m 0700 "$BACKUP_DIR"

# 1) Archive database (custom format — restore with pg_restore).
pg_dump --format=custom --no-owner "$DATABASE_URL" \
  > "$BACKUP_DIR/cinderella-db-$STAMP.dump"

# 2) Media store (paths in the DB are relative to MEDIA_ROOT).
if [ -d "$MEDIA_ROOT" ]; then
  tar -czf "$BACKUP_DIR/cinderella-media-$STAMP.tar.gz" -C "$MEDIA_ROOT" .
fi

# 3) Secrets (restrict tightly).
install -m 0600 "$ENV_FILE" "$BACKUP_DIR/cinderella-env-$STAMP.env"

# 4) Retain the 14 most recent of each kind.
for prefix in cinderella-db cinderella-media cinderella-env; do
  ls -1t "$BACKUP_DIR/$prefix-"* 2>/dev/null | tail -n +15 | xargs -r rm -f
done

echo "Backup complete: $BACKUP_DIR (stamp $STAMP)"
