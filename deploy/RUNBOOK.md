# Cinderella — deployment runbook (VPS)

One process (in-process SimpleX core + Fastify admin) as a non-root systemd
service behind nginx TLS. Debian, PostgreSQL, Node ≥ 20.

> **Shared host discipline:** this VPS may run other services. Everything below is
> **additive** — a new user, a new database, a new nginx vhost, an unused admin
> port. Do **not** modify neighbouring services, databases, or nginx configs, and
> do **not** impose a host-wide firewall that could break them.

## Paths & identity

- App code: `/opt/cinderella` (git checkout).
- Runtime data: `/var/lib/cinderella` (owned by `cinderella:cinderella`, `0750`)
  — `state/` (SimpleX SQLite DB), `files/` (XFTP downloads), `media/` (media store).
- Secrets: `/etc/cinderella/cinderella.env` (`0600 root:root`; systemd reads it as
  root before dropping to the service user).
- Service user: `cinderella` (system, non-root, `nologin`).

## First install

```bash
# 1) Native-addon build deps (the simplex-chat addon compiles its wrapper)
apt-get update && apt-get install -y build-essential python3

# 2) Service user + code
useradd --system --home-dir /var/lib/cinderella --shell /usr/sbin/nologin cinderella
git clone https://github.com/saschadaemgen/cinderella.git /opt/cinderella
cd /opt/cinderella
npm ci
npm run build          # tsc + Tailwind/htmx assets

# 3) PostgreSQL: least-privilege role + owned database
DB_PW="$(openssl rand -hex 24)"
sudo -u postgres psql -c "CREATE ROLE cinderella LOGIN PASSWORD '${DB_PW}';"
sudo -u postgres psql -c "CREATE DATABASE cinderella OWNER cinderella;"

# 4) Secrets + env file (root-owned, 0600)
SESSION_SECRET="$(openssl rand -hex 32)"
ADMIN_PW="$(openssl rand -base64 18)"                        # give this to the operator once
ADMIN_HASH="$(printf '%s\n%s\n' "$ADMIN_PW" "$ADMIN_PW" | npm run --silent hash-password | grep ADMIN_PASSWORD_HASH | sed "s/ADMIN_PASSWORD_HASH=//; s/'//g")"
install -d -m 0700 /etc/cinderella
cat > /etc/cinderella/cinderella.env <<ENV
DATABASE_URL=postgres://cinderella:${DB_PW}@127.0.0.1:5432/cinderella
BOT_DISPLAY_NAME=Cinderella
SIMPLEX_DB_PREFIX=/var/lib/cinderella/state/simplex/cinderella
SIMPLEX_FILES_FOLDER=/var/lib/cinderella/files
MEDIA_ROOT=/var/lib/cinderella/media
GROUP_NAME=
ADMIN_PORT=8787
ADMIN_USERNAME=operator
ADMIN_PASSWORD_HASH=${ADMIN_HASH}
SESSION_SECRET=${SESSION_SECRET}
PUBLIC_ORIGIN=https://<admin-hostname>
LOG_LEVEL=info
ENV
chmod 600 /etc/cinderella/cinderella.env

# 5) Runtime dirs (systemd StateDirectory also creates /var/lib/cinderella)
install -d -m 0750 -o cinderella -g cinderella \
  /var/lib/cinderella/state/simplex /var/lib/cinderella/files /var/lib/cinderella/media

# 6) Migrate the archive schema
cd /opt/cinderella
env $(grep -v '^#' /etc/cinderella/cinderella.env | xargs) node dist/db/migrate.js

# 7) systemd unit
cp deploy/cinderella.service /etc/systemd/system/cinderella.service
systemctl daemon-reload
systemctl enable --now cinderella
systemctl status cinderella --no-pager
curl -fsS http://127.0.0.1:8787/healthz     # -> {"ok":true}
```

## Admin access — WireGuard only (Addendum 3)

The console is **not** exposed publicly. It is reachable only over a WireGuard
tunnel: nginx binds the WG interface (`10.8.0.1:9443`) and terminates TLS in front
of Fastify (`127.0.0.1:8787`). Full setup — WireGuard server, peer configs, the
Secure-cookie TLS options (self-signed now / DNS-01 upgrade), and the nginx vhost
— is in **[deploy/wireguard.md](wireguard.md)**. Connect the tunnel, then browse
`https://10.8.0.1:9443` and log in as `operator`.

> Addendum 2's public nginx + Let's Encrypt vhost + IP-allowlist is superseded by
> this. Public `80/443` stay reserved for the future public embed front.

## Group onboarding

The operator provides the real SimpleX group link. Stop the service (single-writer
SimpleX DB), join, then restart:

```bash
systemctl stop cinderella
cd /opt/cinderella
env $(grep -v '^#' /etc/cinderella/cinderella.env | xargs) npm run connect -- "<simplex group link>"
# wait for "Joined group" + welcome message, then Ctrl+C
systemctl start cinderella
```

## Set the bot avatar (when the operator supplies the image)

```bash
systemctl stop cinderella
cd /opt/cinderella
env $(grep -v '^#' /etc/cinderella/cinderella.env | xargs) npm run avatar -- /path/to/avatar.png
systemctl start cinderella
```

## Update

```bash
cd /opt/cinderella
git pull
npm ci && npm run build
env $(grep -v '^#' /etc/cinderella/cinderella.env | xargs) node dist/db/migrate.js
systemctl restart cinderella
```

## Backup

`deploy/backup.sh` dumps the archive DB and snapshots `media/` + the env file.
Schedule it via cron/systemd-timer. Restore = `pg_restore` the dump, extract the
media tarball, restore the env file.

## Firewall

Cinderella's own surface is localhost-only (admin `127.0.0.1:8787`, Postgres
`127.0.0.1:5432`). On a shared host, review any host-wide firewall change against
the other services first — do not blanket-close ports they rely on.

## Logs

`journalctl -u cinderella -f`. Journald handles rotation. The dashboard surfaces
capture errors and failed file receipts (react before the ~48h XFTP expiry).
