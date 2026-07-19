# CCB-S0-017 — Season 0 Close-Out: Protocol & Handover to Season 1

- **Briefing:** CCB-S0-017
- **Type:** Season close-out (protocol + handover + directive)
- **Project:** Cinderella
- **From:** Planning/Architecture
- **To:** Claude Code

> This document is the committed record of briefing CCB-S0-017. The five living
> documents it references (`architecture`, `security`, `wire-format`,
> `feature-backlog`, `decisions`) live under [`docs/`](../docs/).

---

## Part A — Directive to Claude Code

1. **Commit the Season 0 documentation set.** This close-out lives under
   `seasons/` (`seasons/SEASON-0-PROTOCOL.md`) and the five living documents under
   `docs/`. A `seasons/SEASON-INDEX.md` entry records Season 0. Conventional
   Commit, with a `Briefing: CCB-S0-017` line; pre-push grep first.
2. **Terminology correction (ordered by the operator).** The unit of work is the
   **Season**, numbered from zero. Season 0 is this entire first block. The
   "Stages 0–7" framing used in earlier implementation reports is **deprecated**
   and must not appear in future reports, commit messages, or documents. Where
   existing internal notes use stage labels, leave them as historical and simply
   stop creating stage-framed items.
3. **Numbering discipline continues.** Every briefing carries a
   `CCB-S<season>-<NNN>` id; that id goes in the resulting commit message.
   Professional, publication-ready tone throughout.

## Part B — Season 0 Protocol (what was delivered)

**Project identity.** Cinderella is the central AI/identity of the system. The
consent-based SimpleX group archive is her *first capability*, not her definition;
a team of agents and customer-facing self-service are planned to follow.

Delivered and **live in production** at `cinderella.simplego.dev`, with the bot
active in the real "Cyb3rD3sk" group:

- **Capture pipeline** — text, image, video, voice, link and file messages
  captured to PostgreSQL, with media downloaded to an on-disk store. (CCB-S0-001)
- **Consent gating** — `/publish` / `/unpublish`, forward-only from opt-in,
  honouring deletions; verified live (opt-in proven end to end). (CCB-S0-001, 007)
- **Admin console** — dashboard, Messages browser with takedown, Consent viewer,
  Settings, and Embed management; fully responsive. (CCB-S0-002)
- **Appless public security** — public console over real Let's Encrypt TLS,
  passwordless passkey (WebAuthn) authentication native in the app, Argon2id
  break-glass with optional TOTP, and the full hardening suite (session policy,
  step-up, rate-limit/lockout, IP allow/deny, CSP and security headers, audit log,
  security-event feed, webhook alerting, counter-regression auto-lock).
  (CCB-S0-005)
- **PostgreSQL-backed sessions** — sessions persist across restarts/deploys
  (migration 007); resolved premature logout. (CCB-S0-008)
- **Media pipeline fixed** — XFTP download reliable after correcting the EXDEV
  cross-device rename between `/tmp` and the data volume; media served only behind
  authentication (verified: anonymous access redirects to login). (CCB-S0-010)
- **Avatar** — set SDK-natively (image carried in the `bot.run` profile) and
  propagated to existing group members via a one-time group-message flush; renders
  for all members. (CCB-S0-014, 015)
- **Deployment** — non-root `cinderella` systemd service with hardening,
  PostgreSQL 17, on a shared VPS with bind-level scoping (no host-wide firewall, by
  necessity). (CCB-S0-003)

**Key decisions** (see [`docs/decisions.md`](../docs/decisions.md)): in-process
`simplex-chat` 6.5.4 (not the deprecated WebSocket client); appless public passkey
console with WireGuard dropped from the admin path; consent conducted privately via
the member-support scope; no host-wide firewall on the shared box; the AI brain
runs locally on the operator's RTX 3090 (privacy + cost), with the bot pulling
inference over a tunnel; Seasons numbered from 0 with the CCB briefing scheme.

**Key learnings** (see [`docs/architecture.md`](../docs/architecture.md) /
[`docs/wire-format.md`](../docs/wire-format.md) /
[`docs/security.md`](../docs/security.md)):

- `apiUpdateProfile` notifies direct contacts only; a bot's avatar reaches group
  members only on the bot's next group message (confirmed in the SimpleX core
  source). `bot.run` reconciles the whole profile including the image, so the image
  must be passed into it to avoid blank/restore churn.
- SimpleX has no persistent user identity → no durable bans (removed members
  rejoin instantly), and no per-member "whisper" inline in the main group timeline;
  the member-support scope is the only private per-member channel.
- The XFTP temp/work directory must live on the same filesystem as the media store
  (EXDEV).
- WebAuthn requires a secure context and a real hostname; an obscure hostname is
  not a security control (Certificate Transparency exposes it).

## Part C — Open items carried into Season 1 (operator-owned)

1. Register passkeys on ≥2 devices (a YubiKey 5-series has been ordered — the
   current YubiKey 4 predates FIDO2 and cannot store passkeys), then disable
   break-glass and rotate the break-glass password (it was exposed in plaintext in
   an implementation report).
2. Add a read-only deploy key on the VPS so Claude Code can `git pull` normally
   instead of deploying via `git bundle` (the repo is private).

## Part D — Season 1 scope (the horizon)

1. **Public embed front** — implement the `/embed/<instance-id>` route that serves
   published content to visitors; the admin-side embed settings, theme, filters and
   copy-paste snippet already exist and await this endpoint.
2. **Command & moderation system** (per the Command & Moderation Concept): private
   join + consent flow via the member-support scope (knocking → private greeting →
   `/publish` → accept), role-gated moderation with confirmation and audit, and
   admission hardening (knocking + bot-generated captcha + observer-by-default).
3. **Local AI brain** — integrate the RTX 3090 model over a secure tunnel,
   decoupled behind a single "AI endpoint" address so additional rented servers can
   be added later without a rebuild; the bot forwards free-form private messages to
   it and returns replies, while commands stay deterministic.
4. **Multi-tenancy toward customer self-service** — tenant isolation (carry a
   tenant key in new tables from the start), a role model (operator over all;
   customers scoped to their own tenant), and subscription/self-service management,
   with per-customer passkey login.
5. **Durable bans (optional)** — an application-level verified-identity layer (bind
   bans to an external key, as in the GoBot certificate idea) — only if admission-
   gate friction proves insufficient.

## Part E — Status

Season 0 is **content-complete and running in production**. Consent, capture,
media, avatar, the secured console and its embed management, and session
persistence are all live and verified. The public display, the AI brain, the
command/moderation system, and multi-tenancy are planned as Season 1. The five
living documents accompanying this briefing capture the current architecture,
security posture, wire-format findings, backlog, and decisions in full.
