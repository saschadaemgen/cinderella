#!/usr/bin/env bash
#
# Cinderella one-command deploy.
#
# pull → install → build → migrate → restart → poll /healthz until it answers.
# Prints exactly one result line (DEPLOY OK / DEPLOY FAILED) and exits non-zero on
# failure, so it is safe to chain or run from a hook. The health check is a RETRY
# LOOP with a deadline, not a fixed sleep — a fixed wait is a guess that is wrong on
# a slow boot (the embedded SimpleX core binds the port a few seconds after start).
#
# Run as root on the VPS (systemctl + the 0600 env file need it):
#     sudo bash deploy.sh
#
# Overridable via env: CINDERELLA_DIR, CINDERELLA_ENV, CINDERELLA_SERVICE,
# ADMIN_PORT, HEALTH_TIMEOUT (seconds).
set -euo pipefail

APP_DIR="${CINDERELLA_DIR:-/opt/cinderella}"
ENV_FILE="${CINDERELLA_ENV:-/etc/cinderella/cinderella.env}"
SERVICE="${CINDERELLA_SERVICE:-cinderella}"
PORT="${ADMIN_PORT:-8787}"
HEALTH_URL="http://127.0.0.1:${PORT}/healthz"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

if [ "$(id -u)" -ne 0 ]; then
  echo "deploy.sh must run as root (needs systemctl and the 0600 env file). Try: sudo bash deploy.sh" >&2
  exit 1
fi
cd "$APP_DIR"

echo "→ pull";    git pull --ff-only
echo "→ install"; npm ci
echo "→ build";   npm run build
# Unquoted on purpose: the KEY=VALUE pairs must word-split into separate `env`
# args (same pattern as deploy/RUNBOOK.md). Command-substitution output is not
# re-expanded, so an Argon2 hash's `$` stays literal.
# shellcheck disable=SC2046
echo "→ migrate"; env $(grep -v '^#' "$ENV_FILE" | xargs) node dist/db/migrate.js
echo "→ restart"; systemctl restart "$SERVICE"

rev="$(git rev-parse --short HEAD)"
echo "→ health: polling ${HEALTH_URL} for up to ${HEALTH_TIMEOUT}s"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until body="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null)"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "DEPLOY FAILED — ${SERVICE} did not answer ${HEALTH_URL} within ${HEALTH_TIMEOUT}s (rev ${rev})."
    echo "--- last 25 log lines ---"
    journalctl -u "$SERVICE" -n 25 --no-pager || true
    exit 1
  fi
  sleep 2
done

echo "DEPLOY OK — ${SERVICE} live at rev ${rev}: ${body}"
