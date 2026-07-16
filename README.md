# Cinderella

> The tireless worker — first into the group, never resting, endlessly diligent.

Cinderella is a **consent-based SimpleX-group-to-web archive bot**. It joins a
public SimpleX group that the operator controls, captures every message that
**opted-in** members contribute (text, images, videos, files, links), stores it
in a database alongside the media files, and later republishes it as a
searchable, sortable public web archive.

## The one rule that matters most: consent-first

**Nothing a member contributes appears on the public web archive unless that
member has explicitly opted in via a bot command.** This is the legal backbone
of the whole product. Everything in this repo is built so that publication is
gated on recorded, per-member consent.

## Status

This repo currently covers **Season 0 — Foundation** (bootstrap + core capture
pipeline). The public web front and the admin interface are later seasons and
are intentionally out of scope here.

| Stage | What                                                 | State   |
| ----- | ---------------------------------------------------- | ------- |
| 0     | Repo scaffold + tooling + env-driven config          | ✅ done |
| 1     | Core connect + receive + one file (proof of concept) | ✅ done |
| 2     | Persist captured messages to PostgreSQL              | ✅ done |
| 3     | Consent gating (`/publish` / `/unpublish`)           | ✅ done |

Parked for later seasons: public web front, admin interface, AI moderation /
CSAM scanning (separate track — schema leaves a `moderation_state` hook),
self-hosted relay / super-peer capture.

## Architecture (decided)

- **Runtime:** TypeScript on Node.js (ES modules, strict `tsc`).
- **SimpleX integration:** the official [`simplex-chat`](https://www.npmjs.com/package/simplex-chat)
  npm SDK (v6.x). This SDK **embeds the SimpleX Haskell chat core in-process**
  as a native addon — the same core the SimpleX apps use, giving full
  message-type and file support. See the note below.
- **Database:** PostgreSQL (the archive DB; separate from the SimpleX core's own
  SQLite DB).
- **Media storage:** files on disk in a dedicated media tree; the DB stores the
  file **path**, not the bytes.
- **Search:** PostgreSQL full-text search (a generated `tsvector` column with a
  GIN index) plus a separate extracted `links` table.
- **Deployment:** the VPS (Debian, systemd). **One** long-lived process — the
  Cinderella bot, which embeds the chat core.

> **Note — no separate daemon, no exposed port.** The Season 0 briefing assumed
> the SDK talks over WebSocket to a separate `simplex-chat` CLI daemon bound to
> `127.0.0.1`. That describes the now-deprecated `simplex-chat` npm line (≤ 0.3.0).
> The current SDK (6.5.4) instead embeds the chat core directly, so there is **no
> WebSocket API, no daemon process, and no network port** to expose or firewall.
> The sensitive surface is the on-disk SimpleX DB (`SIMPLEX_DB_PREFIX`), which is
> protected by filesystem permissions. This deviation was reviewed and accepted;
> the capability rationale ("same Haskell core → full capability") is unchanged.

## Prerequisites

- Node.js ≥ 20 (developed on 22).
- PostgreSQL 14+ (any recent version with `to_tsvector` — i.e. all supported
  versions).
- No separate SimpleX daemon or CLI is required — the `simplex-chat` npm SDK
  ships the native chat-core library and runs it in-process. On first run the OS
  may take a few seconds to verify the native library.

## Setup (development)

```bash
npm install
cp .env.example .env      # then edit .env with your local values
npm run build             # type-checks and compiles to dist/
npm run migrate           # create the archive schema in PostgreSQL
```

Validate config without connecting to anything (boots, validates, exits 0):

```bash
node dist/index.js --check
```

Verify the DB layer end-to-end without a live Postgres (uses PGlite, an
in-process Postgres):

```bash
npm run verify:db && npm run verify:consent
```

## Configuration

All settings come from the environment (via a git-ignored `.env` in dev, or
systemd `EnvironmentFile=` in production). See [.env.example](.env.example) for
the full list. Secrets are never hardcoded.

| Variable               | Meaning                                             | Default                      |
| ---------------------- | --------------------------------------------------- | ---------------------------- |
| `BOT_DISPLAY_NAME`     | Bot's SimpleX profile display name                  | `Cinderella`                 |
| `SIMPLEX_DB_PREFIX`    | File prefix for the embedded SimpleX core SQLite DB | `./state/simplex/cinderella` |
| `SIMPLEX_FILES_FOLDER` | Files folder the core writes received files into    | `./state/files`              |
| `GROUP_NAME`           | Group to scope capture (empty = all groups)         | _(all)_                      |
| `MEDIA_ROOT`           | Cinderella's own media store                        | `./media`                    |
| `DATABASE_URL`         | PostgreSQL connection string                        | _(required)_                 |
| `LOG_LEVEL`            | `error` \| `warn` \| `info` \| `debug`              | `info`                       |

## Scripts

| Script                   | What it does                            |
| ------------------------ | --------------------------------------- |
| `npm run dev`            | Run from source with `tsx` (watch mode) |
| `npm run build`          | Type-check + compile to `dist/`         |
| `npm run typecheck`      | Type-check only (no emit)               |
| `npm run lint`           | ESLint                                  |
| `npm run format`         | Prettier (write)                        |
| `npm run migrate`        | Apply database migrations               |
| `npm run connect`        | Join a group via a SimpleX link (once)  |
| `npm run verify:db`      | Verify the schema + write-path (PGlite) |
| `npm run verify:consent` | Verify consent gating (PGlite)          |
| `npm start`              | Run the compiled bot from `dist/`       |

## Repository layout

```
cinderella/
  src/
    config.ts            # env-driven config
    log.ts               # minimal leveled logger
    bot/                 # SimpleX core wiring (client, files, connect)
    capture/             # message -> row mapping, media, links, persist hooks
    db/                  # pool, migration runner, message + consent queries
    consent/             # /publish, /unpublish command handling
    index.ts
  migrations/            # 001_init.sql (messages/links), 002_consent.sql (consent + views)
  scripts/               # verify-db.ts, verify-consent.ts (PGlite harnesses)
  deploy/                # systemd unit + install notes (nginx/web front come later)
  media/                 # git-ignored media store
  state/                 # git-ignored SimpleX core DB + files folder
```

## Running the bot

### Join the archive group (one-time)

The bot only captures from groups it belongs to, and **history is not
backfillable** — introduce the bot at group inception. Join the operator's group
via its SimpleX link:

```bash
npm run connect -- "<simplex group link>"
# wait for "✓ Joined group: …", then Ctrl+C
```

The bot and this helper share one SimpleX DB, so membership persists. Do **not**
run `connect` and the bot at the same time (single-writer DB).

### Run the capture bot

```bash
npm run build && npm start      # or: npm run dev
```

You should see `SimpleX core started …`, the files folder confirmation, the
group(s) the bot is in, and `Cinderella is capturing.`. Each received group
message logs the sender's stable member id, type, and text; each attached file
is downloaded and its on-disk path confirmed.

### Consent: `/publish` and `/unpublish`

Members control publication themselves, in the group, with two plain-text
commands (ASCII):

- **`/publish`** — opt in. From that moment onward, the member's messages become
  eligible for the public archive. Publishing is **forward-only**: messages sent
  _before_ opting in are never published.
- **`/unpublish`** — opt out. The member's messages are immediately removed from
  the published set (they no longer appear on the archive).

Consent binds to the member's **stable group member id**, never the display name
(display names are not unique). A member who leaves and rejoins gets a new member
id, so consent does not carry over — fresh consent is required on rejoin. Command
messages are treated as control messages and are not themselves archived. The bot
replies to each command explaining what publishing means and how to revoke.

Whether a stored message is published is **derived** (never a stale flag): the
`published_messages` / `message_publish_state` views compute it from the consent
table, the message timestamp, and the deleted flag. In-group **deletions** are
honoured — a deleted message is excluded from the published set, mirroring
SimpleX's own channel webpage.

### On the VPS (systemd)

A single unit runs the bot (which embeds the SimpleX core) — there is **no
separate daemon unit**. See [deploy/cinderella.service](deploy/cinderella.service)
for the unit and step-by-step install notes. Point `SIMPLEX_DB_PREFIX`,
`SIMPLEX_FILES_FOLDER`, and `MEDIA_ROOT` at a protected runtime directory
(`/var/lib/cinderella`), and keep the env file `chmod 600`.

## Security & operational notes

- **No network-facing SimpleX surface.** The chat core runs in-process; there is
  no WebSocket API or port to expose. Protect the on-disk SimpleX DB
  (`SIMPLEX_DB_PREFIX`) and files folder with filesystem permissions.
- **No secrets in source.** Everything sensitive is an environment variable.
- **Pre-push hygiene.** Before every push, grep the diff for real IPs, secrets,
  hostnames, device identifiers, and any real member data. Test data uses
  placeholders only. This repo is public.
- **Capture caveats** (baked into the code where relevant):
  - History is **not** backfillable — introduce the bot at group inception.
  - Media is preview-only until actively downloaded per file; XFTP relays expire
    files after ~48h, so keep the bot highly available and surface failed
    receipts.
  - Complete capture as a plain member is not guaranteed in large decentralized
    groups; a future operator-run relay/super-peer is the mitigation. The
    capture layer is designed so a relay-fed source can be swapped in.

## License

See [LICENSE](LICENSE) (placeholder pending the operator's final decision) and
[NOTICE](NOTICE).
