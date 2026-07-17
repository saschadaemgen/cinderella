# CLAUDE.md — Cinderella standing context

Cinderella is a **consent-based SimpleX-group-to-web archive bot**. It joins a
public SimpleX group the operator controls, captures opted-in members' messages
(text/image/video/voice/file/link) into PostgreSQL + a media tree on disk, and
(later season) republishes them as a searchable public web archive. Standalone —
NOT part of CARVILON, CyberDesk, or SimpleGoX.

## The one rule: consent-first

**Nothing a member posts appears on the public archive unless that member sent
`/publish`.** This is the product's legal backbone. Publication is _derived_
(never a stale flag) from the `consent` table, `sent_at` (forward-only from
opt-in), `deleted`/`group_deleted`, and `moderation_state` — see the
`message_publish_state` / `published_messages` views.

## Non-negotiables (base briefing §1)

- Work on **`main`** only. **Conventional Commits**.
- **Mandatory pre-push grep** for real IPs, secrets, hostnames, device ids, and
  member data. The repo is **public**. Test/config data uses placeholders only.
- **No secrets in source or logs.** Everything sensitive is env (git-ignored
  `.env` in dev; systemd `EnvironmentFile` 0600 in prod). Redact before logging.
- **English** everywhere. Proof-of-concept before integration.

## Architecture (decided — do not re-litigate)

- **One process** (Addendum 1 A2): the `simplex-chat` npm SDK (6.5.4) embeds the
  Haskell chat core **in-process** (native addon) alongside the Fastify admin
  console. There is **no separate daemon and no exposed SimpleX port** — the old
  WebSocket-daemon model was the deprecated ≤0.3.x line. The sensitive surface is
  the on-disk SimpleX DB, protected by filesystem perms.
- **Two logical DBs, kept separate:** (1) the SimpleX core's own SQLite state
  under `state/`; (2) Cinderella's **archive** PostgreSQL (messages, links,
  consent, settings, audit, embeds).
- **Media on disk** (`MEDIA_ROOT`); the DB stores the path, never the bytes.
- **Search:** Postgres FTS (generated `tsvector` + GIN) + a `links` table.
- **Admin console** is hostile-facing: Fastify on 127.0.0.1, public nginx TLS in
  front at the admin hostname. **Passkeys (WebAuthn) are the primary auth**
  (native `@simplewebauthn`), with an admin-toggleable Argon2id break-glass path
  (+ optional TOTP). Signed HttpOnly/Secure/SameSite=Strict session; CSRF on all
  mutations; every A4.5 hardening control (session/step-up/rate-limit/IP/CSP/
  headers/attestation/alerting) is configured on the **Security** page, persisted
  in `settings`, audited. `trustProxy` pinned to `loopback`. Responsive (A5).

## Layout

- `src/` — `config.ts`, `log.ts`, `bot/` (core wiring, files, connect, avatar),
  `capture/` (parse, media, links, persist), `consent/`, `settings/`, `db/`,
  `web/` (server, auth, session, views), `index.ts`.
- `migrations/` — 001 messages/links · 002 consent+views · 003 admin · 004
  moderation gate · 005 deletion provenance · 006 webauthn + TOTP. Runner:
  `node dist/db/migrate.js`.
- `scripts/` — PGlite verification harnesses + asset/password helpers.
- `deploy/` — `cinderella.service`, `nginx-admin.conf`, `RUNBOOK.md`, `backup.sh`.
- Git-ignored: `.env`, `state/`, `media/`, `public/` (built assets), `dist/`.

## Verify before committing nontrivial changes

`npm run build` (tsc + Tailwind/htmx assets) · `npm run lint` · and the four
PGlite harnesses (real Postgres-in-WASM, no server needed):
`verify:db`, `verify:consent`, `verify:admin`, `verify:admin-views`.
`scripts/admin-preview.ts` boots a seeded local admin console for browser checks.

## Deploy (VPS) — see [deploy/RUNBOOK.md](deploy/RUNBOOK.md)

Shared production host. Be **additive**: never touch neighbouring services,
DBs, or nginx configs. App in `/opt/cinderella` (git), runtime data in
`/var/lib/cinderella` (owned by the non-root `cinderella` user). One systemd
unit. Update = `git pull && npm ci && npm run build && node dist/db/migrate.js &&
systemctl restart cinderella`. Admin console is **public + passkey-secured**
(Addendum 4): nginx TLS at the admin hostname → Fastify `127.0.0.1:8787`. See
[deploy/RUNBOOK.md](deploy/RUNBOOK.md). WireGuard (Addendum 3) is retired from the
admin path but stays installed for optional defense-in-depth
([deploy/wireguard.md](deploy/wireguard.md)).

## Parked (do not build now)

Bot avatar (operator supplies image → `npm run avatar -- <img>`), public
`/embed/<id>` widget render + Web-Component (later season; config model + admin
UI already exist), AI moderation / CSAM scanning (separate track — the
`moderation_state` column is the hook), self-hosted relay/super-peer capture.
