# Cinderella — Feature Backlog

> _Living document — Cinderella, Season 1–2. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S2-004**._

Cinderella's living record of what is built, what is scoped for Season 2, and what is
waiting on the operator. **The code is the source of truth.** Every "Done" item below
is anchored to a file and, where useful, a line. Where the planning outline and the
code disagree, the divergence is called out inline.

Season boundaries follow the close-out briefing CCB-S1-017
([`seasons/SEASON-1-PROTOCOL.md`](../seasons/SEASON-1-PROTOCOL.md)). The unit of work
is the **Season**, numbered from 1; the older "Stages 0–7" framing is deprecated (it
survives only in historical task labels and in-code comments).

---

## Done — Season 1 (built and verifiable in code)

### Capture pipeline — text, image, video, voice, link, file

- [x] **Six-way type taxonomy** — `CapturedType = 'text' | 'image' | 'video' | 'voice' | 'link' | 'file'` and the classifier that maps SimpleX `MsgContent` discriminants onto it. Note `chat`-type content (a SimpleX chat link) is folded into `link`. See [`src/capture/message.ts:13`](../src/capture/message.ts) and `classifyType` at [`src/capture/message.ts:64`](../src/capture/message.ts).
- [x] **Event wiring** — `newChatItems`, `chatItemUpdated` (edits overwrite so pre-edit text is never left published), and both in-group deletion events (`groupChatItemsDeleted`, `chatItemsDeleted`) are handled in [`src/capture/handler.ts`](../src/capture/handler.ts). Capture can be scoped to a single stable numeric group id.
- [x] **Media on disk, path in DB** — received files are moved into `MEDIA_ROOT`; the DB stores the relative posix path, mime, and size — never the bytes. Cross-device (`EXDEV`) rename falls back to copy+unlink (the fix confirmed live in CCB-S1-010). See [`src/capture/media.ts`](../src/capture/media.ts).
- [x] **Schema** — `messages` (with a generated `search` `tsvector` + GIN index, `simple` config) and `links`, in [`migrations/001_init.sql`](../migrations/001_init.sql). Full-text-search infrastructure (Postgres FTS + a `links` table) exists at the schema level; no public search UI is wired yet (that ships with the Season 2 web front).

### Consent gating — the one rule

- [x] **`/publish` / `/unpublish`** parsed as exact ASCII commands and recorded against the **stable member id** (never the display name); commands are treated as control messages and are **not** persisted as archive content. See `parseConsentCommand` in [`src/consent/commands.ts:19`](../src/consent/commands.ts), consent-command detection at [`src/capture/handler.ts:102`](../src/capture/handler.ts), and dispatch through the `onCommand` hook at [`src/capture/handler.ts:125`](../src/capture/handler.ts).
- [x] **Derived publish state** — publication is computed, never a stored flag, by the `message_publish_state` / `published_messages` views. A row publishes only when it is not admin-`deleted`, not `group_deleted`, `moderation_state <> 'rejected'`, the sender has an unrevoked `consent` row, and `sent_at >= opted_in_at` (forward-only). Introduced in [`migrations/002_consent.sql`](../migrations/002_consent.sql), then recreated to add the moderation gate in [`migrations/004_moderation.sql`](../migrations/004_moderation.sql) and the `group_deleted` split in [`migrations/005_deletion_provenance.sql`](../migrations/005_deletion_provenance.sql).
- [x] **Deletion provenance split** — `group_deleted` (set only by in-group deletion, never clearable from the console) is separated from admin `deleted`, so an operator can never undelete a member's group deletion back into publication. See [`migrations/005_deletion_provenance.sql`](../migrations/005_deletion_provenance.sql).
- [x] **Consent-first welcome / notice** — the verbatim group welcome (`WELCOME_MESSAGE` at [`src/consent/commands.ts:48`](../src/consent/commands.ts)) and the `/publish` / `/unpublish` confirmation replies (`PUBLISH_REPLY` [`:26`](../src/consent/commands.ts), `UNPUBLISH_REPLY` [`:32`](../src/consent/commands.ts)) live in [`src/consent/commands.ts`](../src/consent/commands.ts).

### Admin console — dashboard, messages + takedown, consent, settings, embeds

- [x] **Server** — Fastify bound to `127.0.0.1` only (nginx TLS in front, listen at [`src/web/server.ts:243`](../src/web/server.ts)), `trustProxy: 'loopback'` ([`src/web/server.ts:82`](../src/web/server.ts)), CSRF on all mutations, per-request IP-access and rate-limit hooks, security headers on every response. See [`src/web/server.ts`](../src/web/server.ts).
- [x] **Dashboard** — [`src/web/views/dashboard.ts`](../src/web/views/dashboard.ts) (`GET /`).
- [x] **Messages browser + manual takedown** — filters by type/published/deleted/time; takedown sets `moderation_state = 'rejected'`, restore clears it back to `'none'`, mark-deleted/undelete on the admin `deleted` axis, all audited; in-group deletions cannot be restored (409). See [`src/web/views/messages.ts`](../src/web/views/messages.ts) (routes `/messages`, `/messages/:id/takedown`, `/restore`, `/delete`, `/undelete`; the 409 guard at [`src/web/views/messages.ts:363`](../src/web/views/messages.ts)).
- [x] **Consent viewer** — [`src/web/views/consent.ts`](../src/web/views/consent.ts) (`GET /consent`).
- [x] **Settings** — live-editable operator settings persisted in the `settings` table (secrets stay in env). See [`src/web/views/settings.ts`](../src/web/views/settings.ts) and [`migrations/003_admin.sql`](../migrations/003_admin.sql).
- [x] **Embed management (admin side only)** — instance CRUD, theme/layout/filter/media-type config, and the copy-paste iframe snippet generator. See [`src/web/views/embeds.ts`](../src/web/views/embeds.ts). **The public endpoint the snippet points at is not built — see Season 2.**
- [x] **Audit log** — every state-changing action recorded (actor/action/target/details) in `audit_log`. See [`migrations/003_admin.sql`](../migrations/003_admin.sql) and [`src/db/audit.ts`](../src/db/audit.ts).

### Appless passkey security + hardening

- [x] **Passkeys (WebAuthn) as primary auth** with an Argon2id break-glass path and optional TOTP; counter-regression auto-locks a credential (cloned-authenticator signal — the `locked` column). Schema: [`migrations/006_webauthn.sql`](../migrations/006_webauthn.sql). Routes/ceremonies: [`src/web/security/routes.ts`](../src/web/security/routes.ts) and [`src/web/security/webauthn.ts`](../src/web/security/webauthn.ts).
- [x] **Full A4.5 hardening suite, admin-configurable and persisted** — passkey attestation policy, session idle/absolute timeouts, step-up for sensitive mutations, login rate-limit/lockout, global per-minute limit, IP allow/deny, configurable CSP + security headers, and webhook alerting (https-only URL validation). See [`src/security/settings.ts`](../src/security/settings.ts) and the enforcement hooks in [`src/web/server.ts`](../src/web/server.ts): security headers on `onSend` ([`:129`](../src/web/server.ts)), global rate-limit + IP allow/deny + session/auth guard on `onRequest` ([`:134`](../src/web/server.ts)), CSRF + step-up on `preHandler` ([`:172`](../src/web/server.ts)). Security page + TOTP enroll/enable/disable + logout-others: [`src/web/views/security.ts`](../src/web/views/security.ts).

### PostgreSQL-backed sessions

- [x] Sessions persist in the `admin_sessions` table so restarts/deploys no longer log the operator out; the signed cookie carries a stable id. See [`migrations/007_sessions.sql`](../migrations/007_sessions.sql), `SessionStore` in [`src/web/session.ts`](../src/web/session.ts), wired at [`src/web/server.ts:84`](../src/web/server.ts).

### Avatar

- [x] Set SDK-natively (image carried in the `bot.run` boot profile) and flushed to existing group members via a group message. Staging entry point: `npm run avatar -- <image>` → [`src/bot/set-avatar.ts`](../src/bot/set-avatar.ts); the running service applies it (`bot.run` + `updateBotUserProfile` self-heal) via [`src/bot/avatar.ts`](../src/bot/avatar.ts). The image path resolves from the `AVATAR_PATH` env (`resolveAvatarPath`, [`src/config.ts:121`](../src/config.ts)).
  > **Note:** the outline lists the avatar as Done and the code confirms it — SEASON-1-PROTOCOL records it delivered (CCB-S1-014/015, [`seasons/SEASON-1-PROTOCOL.md:57`](../seasons/SEASON-1-PROTOCOL.md)). The one stale point is that [`CLAUDE.md`](../CLAUDE.md) still files the avatar under "Parked (do not build now)" ([`CLAUDE.md:83`](../CLAUDE.md)). CLAUDE.md's stated invocation `npm run avatar -- <img>` is **accurate** — it matches the tool's own usage string ([`src/bot/set-avatar.ts:4`](../src/bot/set-avatar.ts)), which reads the image path from `process.argv[2]` ([`:22`](../src/bot/set-avatar.ts)); the npm script `"avatar": "tsx src/bot/set-avatar.ts"` ([`package.json:15`](../package.json)) forwards the `--` args to it. Treat the avatar as **done**; only CLAUDE.md's "Parked" placement is out of date.

---

## Planned — Season 2 (scoped, not yet in code)

### 1. Public embed front — the `/embed/<instance-id>` route

**Status: FOUNDATION SHIPPED (CCB-S2-003).** The SSR `GET /embed/:id` route, its
consent-gated media route `GET /embed/:id/media/:msgId`, server-side
type/time/full-text filtering via URL params, core SEO (title/description,
canonical, OG/Twitter, schema.org JSON-LD, indexable), and iframe auto-height are
built and verified ([`src/web/front/`](../src/web/front/),
[`src/db/public-archive.ts`](../src/db/public-archive.ts),
[`scripts/verify-public.ts`](../scripts/verify-public.ts)).

**The full SEO & marketing suite is SHIPPED too (CCB-S2-004):** per-instance
configurable structured data (the toggle-driven schema.org `@graph` — WebSite +
SearchAction, Organization, CollectionPage + BreadcrumbList / ItemList, postings,
ImageObject/VideoObject), `sitemap.xml` + sitemap index, admin-defaulted `robots.txt`,
per-instance meta (title template, description, keywords, canonical base, robots),
full OG/Twitter + operator/auto social image, an RSS feed, and a privacy-respecting
per-instance analytics hook (off by default, CSP-scoped — D-017). All admin-edited on
the embed instance, all consent-gated. See [`src/web/front/seo.ts`](../src/web/front/seo.ts).

**Remaining in Season 2:** multiple templates (CCB-S2-005), a design editor
(CCB-S2-006), the Web Component, and SSR/media caching with publish-event
invalidation. The history below records the pre-CCB-S2-003 state.

- **What exists today (verified):**
  - `embed_instances` table ([`migrations/003_admin.sql:26`](../migrations/003_admin.sql)).
  - Admin CRUD + theme/layout/filter/media config + audit ([`src/web/views/embeds.ts`](../src/web/views/embeds.ts)).
  - The snippet generator `embedSnippet()` that emits `<iframe src="{publicOrigin}/embed/{instanceId}">` plus an auto-height `postMessage` listener ([`src/web/views/embeds.ts:24`](../src/web/views/embeds.ts)). `publicOrigin` comes from `AdminConfig.publicOrigin` ([`src/config.ts:62`](../src/config.ts)).
- **What is missing (verified absent):** there is **no `GET /embed/:id` route anywhere in the codebase.** A repo-wide search finds `/embed/<instance-id>` only in comments, the snippet string, and season/schema docs — the only registered routes are the admin `/embeds` family. The iframe the operator can already copy today points at an endpoint that returns nothing. The source says so explicitly: "The public `/embed/<instance-id>` route and the widget rendering itself are a later season" ([`src/web/views/embeds.ts:5`](../src/web/views/embeds.ts)); "The `/embed` route goes live with the public-front season" ([`src/web/views/embeds.ts:265`](../src/web/views/embeds.ts)); and the schema comment "The `/embed/<instance-id>` route and widget rendering are a later season" ([`migrations/003_admin.sql:24`](../migrations/003_admin.sql)).
  > This matches the outline's suspicion exactly: the embed **admin settings** exist, the **public `/embed` endpoint is not implemented.** Season 2 must add the route that resolves an instance id → its settings → the `published_messages` projection and renders the widget (plus the Web Component, per [`CLAUDE.md`](../CLAUDE.md)).

- [x] Implement `GET /embed/:id` serving published content, honouring per-instance theme/layout/filters/media visibility. **(CCB-S2-003)**
- [ ] Render the widget (and the parked Web-Component wrapper).

### 2. Command & moderation system

- [ ] Private join + consent flow over the member-support scope (knocking → private greeting → `/publish` → accept).
- [ ] Role-gated moderation with confirmation and audit.
- [ ] Admission hardening: knocking + bot-generated captcha + observer-by-default.
  > Hook already in place: the `moderation_state` enum is defined ([`migrations/001_init.sql:9`](../migrations/001_init.sql)) and enforced *negatively* by the publish views and the manual takedown button, but nothing drives it automatically — every captured row stays `'none'` until this track is built (comment at [`migrations/001_init.sql:7`](../migrations/001_init.sql)).

### 3. Local AI brain over a tunnel

- [ ] Integrate the operator's local model over a secure tunnel, decoupled behind a single "AI endpoint" address; the bot forwards free-form private messages and returns replies, while commands stay deterministic. Not present in code today (source: [`seasons/SEASON-1-PROTOCOL.md`](../seasons/SEASON-1-PROTOCOL.md) Part D §3).

### 4. Multi-tenancy for customer self-service

- [ ] Tenant isolation (carry a tenant key in new tables from the start), a role model (operator over all; customers scoped to their tenant), subscription/self-service management, per-customer passkey login. The current schema is single-tenant — no tenant key exists in any table yet (source: [`seasons/SEASON-1-PROTOCOL.md`](../seasons/SEASON-1-PROTOCOL.md) Part D §4).

### 5. Optional durable-ban identity layer

- [ ] An application-level verified-identity layer binding bans to an external key — **only if** admission-gate friction proves insufficient. SimpleX has no persistent identity, so removed members otherwise rejoin instantly. Explicitly conditional/optional in [`seasons/SEASON-1-PROTOCOL.md`](../seasons/SEASON-1-PROTOCOL.md) Part D §5.

---

## Operator-owned open items (carried into Season 2)

These are not code tasks — they are actions only the operator can take. Source:
[`seasons/SEASON-1-PROTOCOL.md`](../seasons/SEASON-1-PROTOCOL.md) Part C.

- [ ] **Register a second passkey, then close the break-glass path.** Enrol passkeys on ≥2 devices (a YubiKey 5-series has been ordered — the current YubiKey 4 predates FIDO2 and cannot store passkeys), then disable break-glass and **rotate the break-glass password** (it was exposed in plaintext in an implementation report). The toggle and rotation surface live on the Security page ([`src/web/views/security.ts`](../src/web/views/security.ts)); the decision to flip them is the operator's.
- [ ] **Add a read-only deploy key on the VPS** so deployment can `git pull` normally instead of shipping via `git bundle`.
  > **Note:** [`seasons/SEASON-1-PROTOCOL.md:94`](../seasons/SEASON-1-PROTOCOL.md) (Part C §2) describes the repo as **private** ("deploying via `git bundle` … the repo is private"). This contradicts [`CLAUDE.md`](../CLAUDE.md), which states once, at [`CLAUDE.md:25`](../CLAUDE.md), that "The repo is **public**." (CLAUDE.md's other uses of "public" — the admin console, the SimpleX group, the web archive, the `/embed` widget — do not refer to the repository.) The two standing documents disagree on repository visibility; this backlog reports the discrepancy rather than resolving it. Either way, the pre-push secret-grep discipline applies.

---

## Verification note

This backlog was written against the code on `main`. Every "Done" checkbox was
confirmed against a named file and line; every Season 2 item was confirmed **absent**
from the codebase (no route, table, or module implementing it), not merely
undocumented. The single most important verification result: **the public
`/embed/:id` route does not exist in code** — only its admin-side configuration does.
