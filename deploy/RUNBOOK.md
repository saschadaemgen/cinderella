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

## Admin access — public, appless, passkeys (Addendum 4)

The console is public at the admin hostname over real Let's Encrypt TLS, secured
by **passkeys** (WebAuthn) — not by network location. nginx terminates TLS and
proxies to Fastify on `127.0.0.1:8787`.

```bash
# DNS A-record for the admin hostname must already point at the VPS.
certbot certonly --nginx -d <admin-hostname>          # reuses the existing ACME account
# Set the real hostname in the vhost, then enable it:
sed -i "s/cinderella.example.org/<admin-hostname>/g" deploy/nginx-admin.conf   # or edit by hand
cp deploy/nginx-admin.conf /etc/nginx/sites-available/cinderella-admin
ln -sf ../sites-available/cinderella-admin /etc/nginx/sites-enabled/cinderella-admin
nginx -t && systemctl reload nginx                    # reload, never restart (shared host)
```

Set the WebAuthn env (RP id/origin derive from `PUBLIC_ORIGIN`, so usually just):

```
PUBLIC_ORIGIN=https://<admin-hostname>
```

**First login (bootstrap):** break-glass is enabled by default. Log in with the
Argon2id password, open **Security → Passkeys**, register passkeys on **≥2
devices** (phone + desktop, ideally a hardware key too), then disable break-glass
if you wish. Every A4.5 control (session, rate-limit, step-up, IP access, headers,
etc.) is configured on the Security page.

> Retires Addendum 3's WireGuard-interface vhost — remove
> `/etc/nginx/sites-enabled/cinderella-admin`'s WG version before installing this.
> WireGuard stays installed but is no longer on the admin path. See
> [deploy/wireguard.md](wireguard.md) (now optional defense-in-depth).

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

## Set the bot avatar

The avatar is carried **in the boot profile**: on startup the bot loads the image
at `AVATAR_PATH` (default `/var/lib/cinderella/avatar.jpg`), auto-downscales it to
a small square JPEG (SimpleX profile images ride inside the profile message
envelope — a full-size photo is silently never applied), and the SDK applies /
self-heals it. So the whole flow is **place the file, then restart** — no need to
stop the service first (the DB is never opened by the avatar tooling):

```bash
# 1. Put the image where the bot reads it, owned by the cinderella user.
sudo install -o cinderella -g cinderella -m 0644 avatar.jpg /var/lib/cinderella/avatar.jpg

# 2. Apply it: restart picks up the new image and the boot-time group flush
#    pushes it to existing members (one small group message, once per image).
systemctl restart cinderella
```

Optional — validate the downscale and copy in one step with the helper (it only
reads the image and writes it to `AVATAR_PATH`; it does **not** open the SimpleX
core, so the service can stay running — then restart as above):

```bash
cd /opt/cinderella
sudo -u cinderella env AVATAR_PATH=/var/lib/cinderella/avatar.jpg \
  node dist/bot/set-avatar.js /path/to/source-image.jpg
```

Admin sessions persist in PostgreSQL (`admin_sessions`), so the restart does not
log the operator out.

## Update

> The repo is **private**: the VPS cannot `git pull` anonymously. Either add a
> read-only deploy key/token on the VPS, or ship commits with a git bundle:
> `git bundle create /tmp/x.bundle main` (locally) → `scp` → on the VPS
> `git pull /tmp/x.bundle main`.

```bash
cd /opt/cinderella
git pull            # (needs a deploy key; else use the bundle above)
npm ci && npm run build
env $(grep -v '^#' /etc/cinderella/cinderella.env | xargs) node dist/db/migrate.js
systemctl restart cinderella   # sessions survive this now
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
