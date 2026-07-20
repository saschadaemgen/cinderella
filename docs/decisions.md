# Cinderella — Decision Log

> _Living document — Cinderella, Season 1–2. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S2-011**._

Standing record of the architectural and operational decisions taken across
Seasons 1–2, newest first. Each entry states the decision, a one-line rationale, and
whether it is **IMPLEMENTED** (present in the code / config today) or **PLANNED**
(committed direction, not yet in code). Where a decision differs from how the code
actually behaves today, the divergence is called out inline.

Companion documents: `seasons/SEASON-1-PROTOCOL.md` (close-out CCB-S1-017),
`CLAUDE.md` (standing architecture). Paths below are repo-relative.

---

### D-022 — Fail fast on a WebAuthn RP-ID/origin mismatch (passkey-lockout guard)
**Status: IMPLEMENTED.**
**Decision.** `loadAdminConfig` calls `validateRpConfig(rpId, webauthnOrigin)` at startup
(`src/config.ts`, CCB-S2-011): the server refuses to boot unless the effective
`WEBAUTHN_RP_ID` equals the WebAuthn origin's host or is a registrable parent of it, and
it logs the effective RP ID/origin on start. **Diagnosis context:** an operator reported a
passkey `NotAllowedError` lockout after a run of deploys. The logs + diffs showed the RP ID
was correct (`= PUBLIC_ORIGIN` host, unchanged), the WebAuthn ceremony code was
byte-identical to the last working build, the options endpoint returned identical output,
and the failing attempt came from the same client that had just succeeded — i.e. NOT a
server regression but a client-side `get()` reject. No RP-ID/origin was restored because
none had drifted; the guard is defense-in-depth against the *classic* cause (a future
`WEBAUTHN_RP_ID`/`PUBLIC_ORIGIN` change) rather than a fix for this incident.
**Rationale.** An RP-ID/origin mismatch invalidates every registered passkey with a silent
client-side error — the worst kind of auth regression (it locks the operator out with no
server error to point at). Converting it into a boot-time config failure + a startup log
line makes the failure loud and the diagnosis trivial. Verified by
[`scripts/verify-admin.ts`](../scripts/verify-admin.ts) (match/parent pass; mismatch and
unrelated origin rejected).

---

### D-021 — Content reporting is visible-until-review, minimal-data, published-gated; alerts are a placeholder
**Status: IMPLEMENTED.**
**Decision.** The public front carries a per-item "Report" control (a no-JS `<details>` form,
CCB-S2-009) and the admin a grouped review queue + an open-count notification bar. A report is the
notice-and-takedown signal, NOT a moderation action: `POST /embed/:id/report` writes ONLY the
`reports` table and NEVER changes publication — content stays **visible until the operator reviews
it**. The endpoint (the one mutating public-front route, exempt from the admin CSRF/auth preHandler
as a public surface) rate-limits first (its own per-IP bucket), rejects cross-site submissions
(`Sec-Fetch-Site`, anti-flood), validates the reason against a fixed enum, and gates on `isPublished`
through `published_messages` (D-016) — an unpublished / recalled / nonexistent id gets the SAME
neutral 303 and stores nothing, so there is no existence/publication oracle. **Minimal data**
(`migrations/008_reports.sql`): message id, reason, optional 1000-char note, timestamp, status, and
the ONLY reporter-derived value — a keyed, non-reversible `HMAC(sessionSecret, ip|msgId|utc-date)`
that rotates daily and is per-item (no raw IP, no UA/cookie/fingerprint; dedup is one row per
item/client/day via a unique constraint). The admin queue groups by message with a consent/auth-gated
preview and audited take-down / resolve / dismiss actions (takedown reuses `setModerationState` +
auto-resolves the item's open reports); the open-count bar injects into every admin page via a stable
`onSend` comment marker (an AsyncLocalStorage approach was dropped because `enterWith` didn't survive
Fastify's hook→handler boundary). External e-mail/SMS/SimpleX alerts are an **inert, disabled Settings
placeholder** (Part C) — no route, no key, no delivery.
**Rationale.** Visible-until-review keeps a report from being weaponised to hide content; the
published gate + neutral response keep the consent gate and prevent id enumeration; the daily,
per-item HMAC is enough for abuse dedup while identifying no one and self-expiring. An adversarial
review (4 low findings, all fixed) added the cross-site gate, a prototype-safe flash lookup, a single
honest report count, and a real CSRF-scope test. Verified by
[`scripts/verify-public.ts`](../scripts/verify-public.ts) +
[`scripts/verify-admin-views.ts`](../scripts/verify-admin-views.ts).

---

### D-020 — Infinite scroll is cursor-paged + DOM-windowed; live-update reconciles the loaded span
**Status: IMPLEMENTED.**
**Decision.** The public stream pages by a stable `(sent_at, id)` cursor (CCB-S2-007), not by
offset, so items don't shift/dupe when content is published/recalled between loads. The SSR
first page is unchanged (SEO) and seeds the next cursor. `GET /embed/:id/page?cursor=&dir=older|newer`
returns a JSON envelope `{ html, nextCursor, hasMore }` of bare `<li>` cards (reusing
`renderCards`, byte-identical to SSR), consent-gated through `published_messages`, behind its
OWN per-IP rate-limit bucket (a scroll burst can't 429 the consent poll). A single inline
`STREAM_SCRIPT` owns one loaded-item model: a bottom `IntersectionObserver` appends older cards
and windows the top behind a height-preserving spacer (DOM bounded at `WINDOW_CAP`); a top
sentinel restores windowed-off cards on scroll-up by RE-FETCHING (never a stash — a card
recalled while off-screen can't return); the ~18s poll hits
`GET /embed/:id/state?cursor=<bottom>&top=<top>` over the EXACT loaded band (+ `hasNewer`),
sweeping out any recalled id wherever it sits and prepending new publishes only at the true
head. Windowing is symmetric (trim top on scroll-down, trim bottom on restore) so `loaded` never
exceeds the span LIMIT. Deep crawlability is preserved by the untouched `?page=N` SSR pages +
`<link rel=prev/next>` (canonicalBase-consistent, range-gated) + the sitemap; JS-off keeps the
pager. Filters/search reset pagination via a full SSR navigation (shareable).
**Rationale.** Offset paging dupes/skips under concurrent publish/recall; a cursor is a stable
row boundary. The wholesale `/fragment` swap (D-018) was incompatible with appended pages, so it
is retired for a surgical reconcile — the D-016/D-018 CONSENT guarantees are UNCHANGED (both
/page and /state read only `published_messages`; recalled content still vanishes within the poll
interval); only the DOM mechanism differs. The auto-height-iframe eager-load case is bounded by a
burst cap → "Load older" button; full virtualization is the heavier future alternative. Verified
by [`scripts/verify-public.ts`](../scripts/verify-public.ts) (cursor stability, span bounding +
LIMIT truncation, consent, rel=next/prev, separate rate-limit buckets) + a windowing simulation
(loaded never breaches the cap through a down-then-up cycle). An adversarial review caught and
fixed asymmetric windowing (unbounded up-scroll growth), a hash-gate hiding new top publishes, a
deep-page auto-prepend misfire, and a poll single-flight gap.

---

### D-019 — Video plays inline; a media download button is per-instance, default ON; the media route serves byte-ranges
**Status: IMPLEMENTED.**
**Decision.** On the public stream, video renders as an INLINE native `<video controls
preload="metadata" playsinline>` (CCB-S2-008), replacing the old "Open video" link that
opened the raw file on a blank page. A themed **Download** button is gated by a new
per-instance setting `player.showDownload` (**default ON**), designed to cover all
downloadable media so it extends from video today to images later without a schema change;
when OFF the button is hidden and the player carries `controlsList="nodownload"`. Two
correctness requirements ride with inline playback: the consent-gated media route
`/embed/:id/media/:msgId` now answers HTTP **`Range`** requests (`206` + `Accept-Ranges:
bytes` + `Content-Range`) — WebKit refuses to play inline `<video>` without it and seeking
needs it — with the range branch strictly AFTER the `getPublishedMedia` consent gate + path
guard (a recalled id still `404`s, Range header or not); and the copy-paste embed snippet's
iframe now carries `allow="fullscreen" allowfullscreen` so the native fullscreen button works
in the cross-origin embed (Permissions-Policy defaults to `'self'` otherwise). The embed CSP
gains `media-src 'self'` so inline playback isn't blocked by `default-src 'none'`. Voice/file
remain links (out of this briefing's scope).
**Rationale.** Video-as-link was broken UX (a bare file with ~1000px whitespace); inline
playback matches images and the house design. The download toggle is the operator's lever for
the notice-and-takedown posture without pretending that published content isn't, by nature,
fetchable at its URL — the toggle is a UI affordance, not an access control (`controlsList` is
a cosmetic, Chromium-only hint). Byte-range + the fullscreen grant are what make "plays inline
with a working fullscreen button" TRUE on real browsers (Safari/iOS + cross-origin embeds)
rather than only in the harness — both were caught by an adversarial review that the first
harness pass had false-passed. Verified by [`scripts/verify-public.ts`](../scripts/verify-public.ts)
(inline `<video>` + toggle both ways + `media-src` + `206`/`Accept-Ranges` incl.
consent-before-range + snippet fullscreen grant).

---

### D-018 — Live auto-update on the public front is consent-gated polling; "immediately" = within the poll interval
**Status: IMPLEMENTED (DOM mechanism revised by [D-020](#d-020)).**
**Mechanism note (CCB-S2-007):** the wholesale `GET /embed/:id/fragment` swap and the
`LIVE_SCRIPT` described below were REPLACED by the infinite-scroll client's surgical reconcile
(cursor `/page` + ranged `/state?cursor=&top=` + id-sweep, D-020). The polling posture, the
per-IP poll rate limit, "immediately = within the poll interval", and the consent guarantees
here are ALL unchanged — only the DOM update path differs (`/fragment` is removed).
**Decision.** An open `/embed/:id` page keeps itself current with no manual refresh by
polling a cheap, consent-gated state endpoint and swapping in a re-rendered fragment
when the set changes — progressive enhancement layered on the unchanged SSR/SEO
baseline. `GET /embed/:id/state` returns only the published item ids for the page's
active filters plus a short version hash (ids + an md5 content marker — never bodies
or media); `GET /embed/:id/fragment` returns the re-rendered `#stream-list` region.
Both resolve through `published_messages`
([`listPublishedIds`](../src/db/public-archive.ts)), so a recalled / unpublished id
can never appear — when one leaves the set the hash changes and the client drops the
card; a newly published one appears the same way. The client (`LIVE_SCRIPT`,
[`src/web/front/render.ts`](../src/web/front/render.ts)) polls every ~18s, pauses
while the tab is hidden (resuming, with an immediate tick, on focus), and re-posts the
iframe height after any swap. The embed CSP adds `connect-src 'self'` for the
same-origin poll; the two poll endpoints carry their own per-IP rate limit (the public
front is otherwise exempt from the admin limiter). **"Immediately" means "within one
poll interval"** (plus a ≤5s state-cache TTL). SSE (`/embed/:id/events`) is the
recorded future upgrade — deliberately not built.
**Rationale.** Live removal of recalled content is defense-in-depth for consent, not
only UX: a viewer who leaves the page open must not keep seeing content a member has
withdrawn. Polling (vs SSE) keeps the server stateless and cache-friendly and ships
with no new infrastructure; the state payload is ids + hash only, so even a briefly
stale cache can at most delay a card's removal by the TTL, never leak content.
Verified by [`scripts/verify-public.ts`](../scripts/verify-public.ts) (remove-on-recall
incl. media 404, add-on-publish, consent-only ids, rate limit).

---

### D-017 — Analytics is per-instance, off by default, and never weakens the CSP globally
**Status: IMPLEMENTED.**
**Decision.** An operator may attach a privacy-respecting analytics script per embed
instance (`seo.analytics.scriptUrl`, https-only) — **off by default**. When set, only
THAT instance's public-page CSP adds the script's origin to `script-src` and
`connect-src` (`applyEmbedHeaders`, [`src/web/front/embed.ts`](../src/web/front/embed.ts));
the admin console CSP and every other instance are untouched, and the admin form
states the tradeoff. Message content is never sent to third parties — the script runs
in the visitor's browser; the server forwards nothing.
**Rationale.** Analytics is a real operator need, but silently weakening CSP or piping
content to third parties would betray the privacy posture. Scoping the allowance to
the single instance and surfacing it in the admin keeps the operator in control and
the default safe.

---

### D-016 — Consent-gating is absolute on the public archive front
**Status: IMPLEMENTED.**
**Decision.** Only published (opted-in) content is ever served, rendered, or
indexed on the public front. Every public read goes through the
`published_messages` view (consent + forward-only + not admin-deleted /
group-deleted / moderation-rejected); the public media route
(`/embed/:id/media/:msgId`) resolves each file through that same published check on
**every request** (`getPublishedMedia`, [`src/db/public-archive.ts`](../src/db/public-archive.ts)),
never by raw path — so an unpublished / re-unpublished / deleted item's media
`404`s. The public routes are a distinct surface from the authenticated admin media
path, exempt from the admin auth / IP-policy / rate-limit but carrying their own
embeddable+indexable headers.
**Rationale.** Consent is the product's legal backbone, and the public surface is
where a leak would be irreversible — so the gate is enforced in SQL (the view) and
re-derived per request, never cached or trusted from prior state. Verified by
[`scripts/verify-public.ts`](../scripts/verify-public.ts) (published media → 200,
unpublished/before-opt-in → 404).

---

### D-015 — Public-front doctrine: maximum functionality, everything configurable in the admin
**Status: IMPLEMENTED (foundation) / PLANNED (full suite).**
**Decision.** The public archive front aims to be best-in-class and differentiated:
the full range of options is exposed and configured in the admin, whether or not
every operator needs each one. Bounded technical limits live in internal docs, never
as hidden UI warnings. CCB-S2-003 builds the extensible foundation — server-side
rendered `/embed/<id>`, theme/layout/filters driven from the `embed_instances`
record, and a single render entry point ([`src/web/front/render.ts`](../src/web/front/render.ts))
— into which the full SEO/marketing suite (CCB-S2-004), templates (CCB-S2-005), and
a design editor (CCB-S2-006) plug without a rewrite.
**Rationale.** The public front is the product's outward face; over-exposing
configuration (the same pattern as the admin console) differentiates it and avoids
re-architecture as later briefings land.

---

### D-014 — Season numbering aligned to one; internal and public numbering match
**Status: IMPLEMENTED. Supersedes D-011.**
**Decision.** The unit of work is the **Season**, and the first completed block is
**Season 1** (the next is Season 2). The retired zero-based scheme (D-011) is
dropped. **All briefing ids are renumbered to `CCB-S1-<NNN>`** — the canonical,
authoritative ids (see [`../seasons/CCB-REGISTER.md`](../seasons/CCB-REGISTER.md)).
Commit messages and planning-chat filenames created before the alignment retain
their original `CCB-S0-<NNN>` ids as historical artifacts in git history; those are
not rewritten.
**Rationale.** The earlier zero-based scheme created a permanent off-by-one between
the internal "Season 0" and the public "Season 1", which caused confusion; aligning
them (Season 1 = first block, Season 2 = next) removes the offset.

---

### D-013 — Consent to move to the private member-support scope (Season 2)
**Status: PLANNED.**
**Decision.** Onboarding and the `/publish` consent exchange will be conducted
privately, per member, through SimpleX's member-support scope (knock → private
greeting → `/publish` → accept), rather than in the shared group timeline.
**Rationale.** SimpleX offers no per-member "whisper" inline in the main group
timeline, so the member-support scope is the only private per-member channel for a
one-to-one consent conversation.

> **Note: the outline (and the Season 1 close-out) describe consent as "conducted
> privately via the member-support scope." The code today does consent in-group,
> not privately.** `parseConsentCommand` handles `/publish` / `/unpublish` that
> "arrive as plain group messages to the bot," and the confirmation is sent as an
> in-group reply via `apiSendTextReply` (`src/consent/commands.ts:4-6`, `:19-24`,
> `:61-70`). The consent-first `WELCOME_MESSAGE` is defined in
> `src/consent/commands.ts:48-59` but is actually *sent* to the group from the
> one-shot `npm run connect` helper when the bot joins
> (`src/bot/connect.ts:47-63`, `apiSendTextMessage`), not from `commands.ts` and
> not privately. No member-support / support-scope code exists in `src/` (verified
> by search: no matches for member-support / support-scope / whisper). The
> private-scope flow is Season 2 scope — see `seasons/SEASON-1-PROTOCOL.md:100-104`.
> The in-group reality is logged as D-004.

---

### D-012 — Local RTX 3090 hosts the AI brain; the bot pulls inference over a tunnel
**Status: PLANNED.**
**Decision.** The conversational/AI model ("the brain") runs locally on the
operator's RTX 3090; the bot forwards free-form private messages to it over a
secure tunnel and returns replies, while commands stay deterministic. The endpoint
is to sit behind a single "AI endpoint" address so additional rented inference can
be added later without a rebuild.
**Rationale.** Keeps inference private and at zero marginal cost while the product
is small, and decouples the model host from the bot.

> **Note: no AI-brain, inference, or RTX code exists in the repository yet**
> (verified: no matches for `rtx` / `3090` / `inference` / `ai brain` under
> `src/`). This is Season 2 direction only — `seasons/SEASON-1-PROTOCOL.md:105-108`.

---

### D-011 — Seasons numbered from zero; every briefing carries a `CCB-S<season>-<NNN>` id
**Status: Superseded by D-014** (was IMPLEMENTED; the zero-based scheme is retired — the first block is Season 1). Text kept below as history.
**Decision.** The unit of work is the **Season**, numbered from zero; Season 0 is
the entire first block. Each briefing carries an id of the form `CCB-S0-017`, and
that id goes in the resulting commit message. The earlier "Stages 0–7" framing is
deprecated for new work.
**Rationale.** A single, operator-mandated numbering scheme keeps briefings,
commits, and documents traceable to one another.

> **Note:** the deprecated "Stage" labels still exist as *historical* artifacts —
> e.g. the internal task list carries "Stage 0…Stage 6" items. Per the directive
> these are left as history and simply not used for new work
> (`seasons/SEASON-1-PROTOCOL.md:21-29`).

---

### D-010 — Avatar carried inside the `bot.run` profile, then flushed to the group with one message
**Status: IMPLEMENTED.**
**Decision.** The bot avatar is passed as a data-URI `image` inside the profile
given to `bot.run`, and `updateProfile` is enabled **only** when an avatar was
actually loaded; a single minimal group message (`🕯️✨`, hash-gated in `settings`)
then flushes the member-profile update to existing group members.
**Rationale.** The SDK's `updateBotUserProfile` deep-compares against the stored
profile, so an image-less profile would blank a stored avatar; and
`apiUpdateProfile` reaches direct contacts only, so a group send is required to
propagate the avatar to members.
**Evidence.** `src/bot/client.ts:76-107` (image in boot profile;
`updateProfile: image !== undefined`), `src/bot/avatar.ts:41-141`
(`buildAvatarDataUri`, `flushAvatarToGroups`), `src/index.ts:113`
(`flushAvatarToGroups` invoked at boot), `src/bot/set-avatar.ts`
(`npm run avatar -- <img>` stages the file; restart applies).

---

### D-009 — Admin sessions persisted in PostgreSQL, not process memory
**Status: IMPLEMENTED.**
**Decision.** Admin sessions live in an `admin_sessions` table rather than
in-process memory; the signed HttpOnly cookie carries only a stable id.
**Rationale.** In-memory sessions were wiped on every `systemctl restart` (deploys,
config changes), logging the operator out prematurely.
**Evidence.** `migrations/007_sessions.sql:8` (`CREATE TABLE admin_sessions`),
`:19` (`admin_sessions_last_seen_idx`); `src/web/session.ts`
(`SessionStore` reads/writes `admin_sessions`); `src/web/server.ts:84-87`.

---

### D-008 — XFTP temp/work directory pinned to the media filesystem (EXDEV fix)
**Status: IMPLEMENTED.**
**Decision.** `TMPDIR` for the chat core is set to an `xftp-tmp` directory that
sits on the same filesystem as the SimpleX files folder, created at boot before the
core starts.
**Rationale.** XFTP stages and decrypts a download in temp, then `rename()`s it into
the files folder; if temp is on a different device (default `/tmp` tmpfs, further
isolated by the systemd unit's `PrivateTmp`) the rename fails with `EXDEV` and every
receive stalls. Same-filesystem temp makes the move a cheap rename.
**Evidence.** `src/bot/client.ts:37-45` (`ensureDirs` sets `process.env['TMPDIR']`).

---

### D-007 — Appless public passkey console; WireGuard dropped from the admin path
**Status: IMPLEMENTED.**
**Decision.** The admin console is public over real TLS (nginx → Fastify on
`127.0.0.1:8787`), with WebAuthn passkeys as primary auth and an admin-toggleable
Argon2id break-glass path (optional TOTP). WireGuard is retired from the admin path;
it stays installed only as optional defense-in-depth.
**Rationale.** A tunnel-only console is friction for a solo operator and an obscure
hostname is not a security control (Certificate Transparency exposes it); passkeys +
the full A4.5 hardening suite provide the real control.
**Evidence.** `src/web/server.ts:1-8`, `:80-82` (`trustProxy: 'loopback'`),
`:110-188` (CSRF, step-up, IP allow/deny, rate limits, security headers),
`:243-246` (binds `127.0.0.1`); the break-glass TOTP second factor is
`migrations/006_webauthn.sql:27` (`CREATE TABLE admin_totp`);
`deploy/nginx-admin.conf` (TLS vhost → `127.0.0.1:8787`);
`deploy/wireguard.md:1-7` ("RETIRED as the admin path").

---

### D-006 — No host-wide firewall on the shared VPS; scope at the bind level
**Status: IMPLEMENTED (operational posture).**
**Decision.** Cinderella does not impose a host-wide firewall on the shared host;
its own surface is confined by binding to loopback (admin `127.0.0.1:8787`, Postgres
`127.0.0.1:5432`), and any host-wide firewall change is reviewed against neighbour
services first.
**Rationale.** The shared box runs other services that legitimately use many ports;
a blanket firewall could break them, so Cinderella is scoped at the bind level and
stays strictly additive.
**Evidence.** `deploy/RUNBOOK.md:173-176` (Firewall section), `:9`
("do not impose a host-wide firewall that could break them"),
`deploy/wireguard.md:18-24`; bind confirmed in `src/web/server.ts:243`.

---

### D-005 — In-process `simplex-chat` SDK 6.5.4, not the deprecated WebSocket client
**Status: IMPLEMENTED.**
**Decision.** Run the SimpleX chat core in-process via the `simplex-chat` npm SDK
(`^6.5.4`), which embeds the Haskell core as a native addon; `bot.run` opens the
local SimpleX DB and event loop. There is no separate daemon and no exposed SimpleX
port.
**Rationale.** The old external WebSocket-daemon model is the deprecated ≤0.3.x
line; the in-process core removes a network surface, leaving only the on-disk
SimpleX DB (protected by filesystem perms) as the sensitive surface.
**Evidence.** `src/bot/client.ts:9-10`, `:80-107` (`bot.run` from `simplex-chat`);
`package.json:45` (`"simplex-chat": "^6.5.4"`), `:36`
(`"@simplex-chat/types": "^0.8.0"`).

---

### D-004 — Consent conducted in-group via exact `/publish` / `/unpublish` commands
**Status: IMPLEMENTED.**
**Decision.** A member opts in/out by sending the exact ASCII commands `/publish` or
`/unpublish` as ordinary group messages; each is recorded against the sender's
stable member id and answered with an in-group confirmation that restates what
publishing means and how to revoke. A consent-first welcome is posted to the group
when the bot joins.
**Rationale.** Explicit, per-member, forward-only consent is the product's legal
backbone; capturing the exact command keeps the signal unambiguous.
**Evidence.** `src/consent/commands.ts:19-24` (`parseConsentCommand`), `:76-104`
(`makeConsentHandler` → `recordOptIn` / `recordOptOut` + reply), `:48-59`
(`WELCOME_MESSAGE`); wiring in `src/capture/handler.ts:103` (command parse in the
capture pipeline) and `src/index.ts:88` (`hooks.onCommand = makeConsentHandler`);
the welcome is sent from `src/bot/connect.ts:47-63` (on `userJoinedGroup`, in the
`npm run connect` helper).

> **Note:** this is the *current, implemented* behaviour and diverges from the
> Season 1 close-out prose, which describes consent as private via the member-support
> scope (see D-013). Today it is in-group.

---

### D-003 — Publication state is derived, never a stored flag
**Status: IMPLEMENTED.**
**Decision.** Whether a message is public is computed from the `consent` table,
forward-only `sent_at` from opt-in, `deleted` / `group_deleted`, and
`moderation_state` — surfaced through the `message_publish_state` /
`published_messages` views — rather than persisted as a mutable boolean.
**Rationale.** A derived view cannot go stale or drift out of sync with a consent
revocation or deletion, which a cached flag could.
**Evidence.** `migrations/002_consent.sql` (consent + views),
`migrations/004_moderation.sql`, `migrations/005_deletion_provenance.sql`;
`CLAUDE.md:13-19`.

---

### D-002 — Two logical DBs kept separate; media on disk, DB stores the path
**Status: IMPLEMENTED.**
**Decision.** Keep the SimpleX core's own SQLite state (under `state/`) separate
from Cinderella's archive PostgreSQL (messages, links, consent, settings, audit,
embeds); store media bytes on disk under `MEDIA_ROOT` and keep only the path in the
database.
**Rationale.** The two stores have different owners, lifecycles, and trust models;
keeping bytes out of Postgres keeps the archive DB small and lets media be served
directly (behind auth).
**Evidence.** `src/bot/client.ts:37-45` (creates `simplexDbPrefix`,
`simplexFilesFolder`, `mediaRoot`); `migrations/001_init.sql`;
`src/web/server.ts:119-124` (media served from `mediaRoot`); `CLAUDE.md:37-41`.

---

### D-001 — Work on `main`, Conventional Commits, mandatory pre-push secret grep, public repo
**Status: IMPLEMENTED (process convention).**
**Decision.** All work lands on `main` with Conventional Commit messages; before any
push, grep for real IPs, secrets, hostnames, device ids, and member data; test and
config data use placeholders only. Nothing sensitive lives in source or logs —
everything sensitive is environment (git-ignored `.env` in dev; systemd
`EnvironmentFile` 0600 in prod).
**Rationale.** The repository is public, so a single leaked secret or member
identifier is irreversible; a mechanical pre-push check is the backstop.
**Evidence.** `CLAUDE.md:21-28`; placeholder hostnames throughout
`deploy/nginx-admin.conf` (`cinderella.example.org`) and `deploy/wireguard.md`
(keys/IPs as placeholders).

---

#### Status legend
- **IMPLEMENTED** — observable in the code or committed config referenced above.
- **PLANNED** — committed direction recorded in `seasons/SEASON-1-PROTOCOL.md`; no
  implementing code exists yet.
