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

| Stage | What                                                   | State      |
| ----- | ------------------------------------------------------ | ---------- |
| 0     | Repo scaffold + tooling + env-driven config            | ✅ done    |
| 1     | Daemon connect + receive + one file (proof of concept) | ⏳ next    |
| 2     | Persist captured messages to PostgreSQL                | ⏳ planned |
| 3     | Consent gating (`/publish` / `/unpublish`)             | ⏳ planned |

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
```

Run the config check (Stage 0 acceptance — boots, validates config, exits 0):

```bash
npm run build && node dist/index.js
# or, without a build step:
npm run dev
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

| Script              | What it does                            |
| ------------------- | --------------------------------------- |
| `npm run dev`       | Run from source with `tsx` (watch mode) |
| `npm run build`     | Type-check + compile to `dist/`         |
| `npm run typecheck` | Type-check only (no emit)               |
| `npm run lint`      | ESLint                                  |
| `npm run format`    | Prettier (write)                        |
| `npm run migrate`   | Apply database migrations               |
| `npm start`         | Run the compiled bot from `dist/`       |

## Repository layout

```
cinderella/
  src/
    config.ts            # env-driven config
    log.ts               # minimal leveled logger
    bot/                 # simplex-chat SDK wiring, event handlers, commands
    capture/             # message -> row mapping, media handling, link extraction
    db/                  # pool, migrations, queries
    consent/             # opt-in/opt-out logic, published-flag derivation
    index.ts
  migrations/            # SQL migrations (applied by src/db/migrate.ts)
  deploy/                # systemd units, docs (nginx/web front come later)
  media/                 # git-ignored media store
  state/                 # git-ignored SimpleX core DB + files folder
```

## Running on the VPS (systemd)

<!-- Filled in during Stage 1: a single systemd unit for the bot (which embeds
     the SimpleX core). No separate daemon unit. -->

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
