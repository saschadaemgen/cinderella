# Cinderella — SimpleX Wire-Format Findings

> _Living document — Cinderella, Seasons 1–3. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S3-006**._

This document records the SimpleX protocol and SDK behaviours that materially affect Cinderella's implementation. Everything below is verified against the code in this repo; where the working outline and the code disagree, the code wins and the divergence is called out inline and collected at the end.

Sources read: `src/bot/avatar.ts`, `src/bot/client.ts`, `src/consent/commands.ts`, `src/capture/handler.ts`, `src/capture/message.ts`, `src/bot/files.ts`, `src/index.ts`, `migrations/002_consent.sql`, and the SDK source `node_modules/simplex-chat/src/bot.ts` (simplex-chat 6.5.4).

## 1. Profile image is a small square JPEG data URI, budgeted to fit the profile envelope

The bot avatar is not a file reference — it is a base64 `data:` URI carried literally inside the SimpleX profile. SimpleX profile images ride inside the profile message envelope (documented in the code as ~15,610 bytes encoded), so the image must be kept small or the core silently declines to propagate it.

`buildAvatarDataUri` (`src/bot/avatar.ts:41`) downscales the source to a **square JPEG** and drops resolution then quality until the encoded URI fits a byte budget. The relevant constants (`src/bot/avatar.ts:36-38`):

- `MAX_DATA_URI_CHARS = 12000` — the enforced budget, deliberately kept "comfortably under" the ~15,610-byte envelope rather than at it.
- `SIZES = [192, 160, 128]` — pixel dimensions tried largest-first.
- `QUALITIES = [72, 64, 56, 48, 40]` — JPEG quality steps tried within each size.

The MIME type emitted is **`image/jpg`** (not `image/jpeg`), i.e. the literal prefix is `data:image/jpg;base64,` (`src/bot/avatar.ts:50`). Sharp is invoked with `.rotate()` to honour EXIF orientation and `.resize(px, px, { fit: 'cover', position: 'centre' })` for the square crop. JPEG is used deliberately — the file header comment (`src/bot/avatar.ts:19`) notes PNG "renders blurry."

> Note: the outline says "~192px square JPEG." That is the _starting_ size only. The code will step down to 160px or 128px, and reduce quality, if 192px does not fit `MAX_DATA_URI_CHARS`. If nothing fits, `buildAvatarDataUri` returns the smallest URI it produced anyway (`src/bot/avatar.ts:56`) and `loadAvatarDataUri` logs a warning that it may not propagate (`src/bot/avatar.ts:73-79`).

> Note: the outline's "~15,610-byte profile message envelope" appears in the code only as an explanatory comment (`src/bot/avatar.ts:17`, `35`). The value actually enforced in code is the 12000-**character** URI budget, not a 15,610-byte check.

## 2. Member-profile updates reach contacts immediately, but groups only on the next group send

This is the single most important SimpleX wire-format fact for the avatar feature, and the code is built entirely around it.

**bot.run reconciles the whole profile, image included.** The boot profile passed to `bot.run` carries the image inline (`src/bot/client.ts:80-107`). The SDK's `updateBotUserProfile` (`node_modules/simplex-chat/src/bot.ts:199-214`) deep-compares (`fast-deep-equal`) the config profile against the stored profile via `util.fromLocalProfile(user.profile)`, and when they differ **and** `updateProfile` is true, calls `apiUpdateProfile(userId, profile)` with the _full_ profile — image included. So Cinderella sets the image on first run and self-heals it on any boot where the stored profile differs.

- Critical subtlety encoded in `client.ts`: the boot profile only includes the `image` key when an avatar file was actually loaded (`...(image ? { image } : {})`, `src/bot/client.ts:86`), and `updateProfile` is set to `image !== undefined` (`src/bot/client.ts:103`). This is because a profile object _without_ an image would deep-differ from a stored profile _with_ one, causing the SDK to wipe the avatar on every avatar-less boot. The header comment (`src/bot/avatar.ts:8-11`) documents that an earlier `updateProfile:false` + separate re-apply approach "fought the SDK" and blanked the avatar every boot.

**`apiUpdateProfile` only notifies direct CONTACTS.** The bot is a consent bot with no open contact address (`createAddress: false`, `src/bot/client.ts:92`) and therefore effectively zero direct contacts. So the profile update alone reaches nobody in the group.

**Groups receive the profile only when the bot next sends a group message.** The SimpleX core piggybacks the member-profile update (an `XInfo` protocol message) onto the next outgoing group message, gating on `userMemberProfileSentAt < userMemberProfileUpdatedAt` — setting the avatar advances the "updated" side (`src/bot/avatar.ts:92-96`). `flushAvatarToGroups` (`src/bot/avatar.ts:103`) forces this: it reads the active user's image, computes a sha256 marker of it, and if that marker has not already been flushed (a `settings` row keyed `avatarGroupFlushMarker`, `src/bot/avatar.ts:85`) it sends **one** minimal group message — the literal `FLUSH_MESSAGE = '🕯️✨'` (`src/bot/avatar.ts:87`) — to every group. After a successful send it records the marker so restarts do not spam the group. This is wired into startup at `src/index.ts:109-116`, after capture is registered.

> Note on terminology: the outline (and `avatar.ts`) describe the gate as `user_member_profile_sent_at < user_member_profile_updated_at`. That is the SimpleX core's own (SQLite) column semantics; the SDK-facing comment spells the same thing in camelCase. Both refer to the core's internal state, not to any column in Cinderella's Postgres schema.

## 3. Consent commands are recognised on GROUP messages only, by exact string match

Consent is the product's legal backbone, and the command surface is deliberately narrow.

**Only group messages are parsed at all.** `parseGroupMessage` (`src/capture/message.ts:116`) returns `null` unless the item is a group chat (`chatInfo.type === 'group'`), in the receive direction (`chatItem.chatDir.type === 'groupRcv'` — a real member's message, never the bot's own sends or system events), and carries real message content (`content.type === 'rcvMsgContent'`). Direct/local chats and group-event items are dropped before any command logic runs.

**Command recognition is exact-match.** `parseConsentCommand` (`src/consent/commands.ts:19-24`) trims and lowercases the text and matches it against exactly `/publish` or `/unpublish`. Anything else (a command with trailing words, an inline mention) returns `null` and is treated as ordinary content.

**A command must be plain text with no attachment.** In the capture handler, `commandFor` only calls `parseConsentCommand` when `msg.type === 'text' && !msg.file` (`src/capture/handler.ts:102-103`). Recognised commands are routed to the `onCommand` hook and are explicitly **not persisted** as archive content (`src/capture/handler.ts:124-139`).

> Divergence worth recording: Cinderella does **not** use the SDK's built-in command mechanism. The SDK offers `onCommands` + `util.ciBotCommand` (`node_modules/simplex-chat/src/bot.ts:41`, `123-140`) for keyword dispatch, but Cinderella ignores it and does its own parsing inside the capture handler. (Confirmed: a grep of `src/` for `onCommands`/`ciBotCommand` returns no usages.) This is consistent — Cinderella subscribes to the raw `newChatItems` event itself — but means the SDK's command-parsing rules do not apply here; the exact-match rule above is Cinderella's own.

## 3a. Natural addressing rides the same group-message envelope (CCB-S3-002)

Slash commands are no longer the only way in, but nothing about the **envelope** changed:
natural addressing reads the same `newChatItems` group items, through the same
`parseGroupMessage` filter, and answers into the same group chat. No new SimpleX surface,
no new event, no new command mechanism. (How those answers are SENT changed in CCB-S3-003 —
see §3c.)

Three wire-level facts are worth recording:

- **The reply-to signal is the quoted item's direction.** A member replying to one of
  Cinderella's messages is an address in itself. It is detected from
  `chatItem.quotedItem?.chatDir?.type === 'groupSnd'` — `groupSnd` meaning the quoted item was
  sent by *us* in that group — surfaced as `CapturedMessage.quotedFromBot`
  (`src/capture/message.ts`). There is no other reliable "this is a reply to the bot" marker
  in the envelope.
- **The forwarded marker is `meta.itemForwarded`, not `meta.forwardedByMember`.** They look
  interchangeable and are not. `itemForwarded` (`CIForwardedFrom`) is what the clients use to
  draw the "forwarded" label and is surfaced as `CapturedMessage.forwarded`;
  `forwardedByMember` is a group ROUTING detail that is set on perfectly ordinary messages.
  Verified in the live SimpleX database: real `/publish` commands carry
  `forwarded_by_group_member_id` while carrying no `fwd_from_tag`. A guard keyed off the
  wrong field would have silently stopped consent commands from working.
- **Command-shaped text never enters the conversational path.** A message whose text begins
  with `/` is handled by the slash path or not at all (`src/interaction/engine.ts`). Without
  this, a disabled `/publish` could still be triggered through the follow-up window.
- **Persona strings are sent verbatim, and the RECEIVER formats them.** The bot hands the core
  a plain string; the core stores exactly that (`{"type":"text","text":"…"}`, no parsed
  formatting) and each receiving client parses the markup for display. An earlier version of
  this document concluded from the first half of that sentence that "SimpleX renders no
  markdown" — which is false, and is what shipped literal asterisks to a live group. See §3b
  for what the parser actually accepts.

Because attachments are content rather than instructions, the engine ignores any message with
a file or a non-`text` type — a photo captioned "publish me" is not a consent decision.

## 3b. SimpleX message formatting — single-character delimiters (verified)

SimpleX chat renders its own markup, and it is **not CommonMark**. Delimiters are single
characters, and **doubling any of them disables the format** and prints the delimiters
literally.

| Format | Delimiter | Example | Renders as |
| --- | --- | --- | --- |
| bold | `*` | `*yes*` | **yes** |
| italic | `_` | `_maybe_` | _maybe_ |
| strikethrough | `~` | `~gone~` | ~~gone~~ |
| code / snippet | `` ` `` | `` `code` `` | monospace |
| secret / spoiler | `#` | `#hidden#` | hidden until tapped |
| coloured | `!<digit> … !` | `!1 red!` | coloured text |
| link | none | `https://example.org` | auto-detected |
| mention | `@` | `@alice` | member mention |

**Colour, verified against the running parser (CCB-S3-006 §6).** `!<n> text!` where `n` is
a DIGIT, or the colour name spelled out. Only six indices exist:

| Index | Name form | Colour |
|---|---|---|
| `!1 …!` | `!red …!` | red |
| `!2 …!` | `!green …!` | green |
| `!3 …!` | `!blue …!` | blue |
| `!4 …!` | `!yellow …!` | yellow |
| `!5 …!` | `!cyan …!` | cyan |
| `!6 …!` | `!magenta …!` | magenta |

`!0`, `!7`, `!8`, `!9`, `!black` and `!white` produce NO formatting at all — the text and
the delimiters are shown literally. `!- text!` is the separate `small` format.

Cinderella's shipped copy uses **no colour**. Six indices with no theme guarantee is a weak
basis for meaning, and the briefing's own instruction was to use it sparingly and never
decoratively; bold, italic and separators carry the whole layout instead. The mapping is
recorded here so a future decision to use it starts from fact rather than a guess.

**How this was established.** Two independent methods, in agreement (CCB-S3-003):

1. The embedded 6.5.4 core was booted against a throwaway database and asked to parse each
   candidate string; the core's own `chatItem.formattedText` was read back. Note the oracle is
   `chatItem.formattedText`, a SIBLING of `content` — `content.msgContent` echoes the raw text
   unchanged and tells you nothing about parsing.
2. The parser source `Simplex.Chat.Markdown` at tag `v6.5.4` (matching the GHC symbols in the
   shipped `libsimplex.dll`) and its test suite were read.

**The decisive observation.** `x **dbl** and *sgl* y` parses to
`[{"text":"x **dbl** and "},{"format":{"type":"bold"},"text":"sgl"},{"text":" y"}]` — the
single-asterisk word became bold while the double-asterisk word survived as literal text,
asterisks included. `**bold**`, `__ital__` and `~~strike~~` all parse to *no formatting at all*.

Boundary rules that matter when writing copy, all observed directly:

- Multi-word spans work: `*two words*` is bold.
- Whitespace just inside a delimiter kills the span: `* bold *` is literal.
- Punctuation immediately after a closing delimiter is fine: `*ja*,` and `*Cinderella*.` both
  format. (Every shipped string was run through the real parser before release.)
- Underscores inside a word do not italicise, so `snake_case` is safe.
- A **paired** delimiter in a member's display name will format: a member called `#Robin#`
  would render as a spoiler span. `sanitizeDisplayName` in `src/interaction/reply.ts` strips
  `*`, `~`, `` ` `` and `#` from names used in the mention prefix for exactly this reason.

`scripts/verify-interaction.ts` fails if any shipped persona string, retort or prefix template
contains a doubled delimiter, so this cannot silently regress.

## 3c. Outbound replies: plain by default, quoting is opt-in (CCB-S3-003)

Two SDK calls produce visibly different messages in the group:

- `apiSendTextMessage(chatInfo, text)` with no `inReplyTo` — a **normal group message**.
- `apiSendTextReply(chatItem, text)` — a **quoting reply**: SimpleX repeats the quoted
  message above the answer.

Until CCB-S3-003 every reply used the second form, so each answer carried a copy of the
member's message. In the live group that meant 30 of the bot's 33 sent items were quoting
replies (the only exceptions being the join welcome and two avatar-flush markers), which read
as duplicated, assembled noise to members not part of the exchange.

Both the interaction engine and the slash-command handler now go through one transport,
`sendToChat` (`src/bot/send.ts`), which picks the call from a single boolean. The choice is
made by `formatOutbound` (`src/interaction/reply.ts`) from the admin `replyMode` setting:

| Mode | Transport | Text |
| --- | --- | --- |
| `plain` (default) | `apiSendTextMessage` | the reply body |
| `mention` | `apiSendTextMessage` | `<name>, ` + the reply body |
| `quote` | `apiSendTextReply` | the reply body |

Two rules override the mode: **consent confirmation prompts and slash-command confirmations
never quote** in any mode, and **nickname retorts never quote and never carry a name prefix**
(a retort is a snub, not an address). If the chat reference is somehow missing, `sendToChat`
falls back to the quoting form rather than dropping the message — cluttered is recoverable,
an unsent consent confirmation is not.

## 3d. Market data: the instance's only outbound calls (CCB-S3-004)

Everything else Cinderella does is inbound. The Crypto Prices plugin adds the only EGRESS, to
whichever of three providers is configured.

- **What leaves the host:** a canonical asset id (or a chain and contract address) and a
  currency code. No member id, no message text, no group identity.
- **Attribution is a licence term.** CoinGecko requires "Powered by CoinGecko" and
  CoinMarketCap requires "Data provided by CoinMarketCap.com" wherever their data is shown.
  A group chat has no footer, so the credit is appended to the reply and names the provider
  that ACTUALLY answered — after failover that is not necessarily the first one tried.
  Dexscreener requires no attribution.
- **Caching rights, read from the current terms rather than assumed:** CoinGecko permits
  caching but requires a refresh at least daily, which the cache enforces as a per-provider
  ceiling; CoinMarketCap carves caching out of its storage ban; Dexscreener's terms are silent,
  so its data is treated as transient by policy.
- **Responses are not trusted:** a bad status, a timeout, a missing price, or a cross rate with
  only one leg is a failure, never a zero and never a stale value beyond the TTL.
- **Chain-scoped lookups are mandatory for on-chain sources.** Forked chains reuse contract
  addresses — Ethereum and PulseChain HEX share one — so an address-only query can return
  another chain's price with no error.
- **Keys are stored encrypted** in the plugin's settings row and never rendered back, logged,
  or written to an audit entry.

## 4. There is no private per-member channel — consent is group-only, and confirmations are public

The outline references "the member-support scope as the only private per-member channel." **That channel is not implemented in the current code.** This is a Season 2 concept, not present in the codebase.

Evidence:

- `parseGroupMessage` discards every non-group item (`src/capture/message.ts:119-123`), so no direct/DM message ever reaches consent handling.
- A grep of `src/` finds no member-support scope, no `directRcv` handling, and no direct-contact message path (the only `src/` hit for any of these terms is `createAddress: false`). The only `contactConnected`/`contactDeletedByContact` handlers are the SDK's own log lines (`node_modules/simplex-chat/src/bot.ts:143-148`); the bot deliberately creates no contact address (`createAddress: false`, `src/bot/client.ts:92`).
- The confirmation reply is sent with `apiSendTextReply(msg.raw, text)` (`src/consent/commands.ts:63`), where `msg.raw` is the original **group** chat item. So the `/publish` / `/unpublish` acknowledgements (`PUBLISH_REPLY`, `UNPUBLISH_REPLY`, `FAILURE_REPLY`; `src/consent/commands.ts:26`, `32`, `38`) are posted **into the group, visibly to everyone** — they are not private DMs.

> Divergence, explicit: outline says a private per-member support channel is the mechanism; the code has **no private per-member channel at all**. Consent is entirely group-scoped, and even the consent confirmations are public group replies. Treat "member-support / private DM" as _planned / not yet implemented_.

**CCB-S3-002 inherits this constraint.** The briefing asks for personal answers (`STATUS`,
undo detail) to be kept out of the public group "where a private channel exists". None does,
so the rule's fallback applies: those answers are kept **short**. `STATUS` is a single line
with two counts and no message content, and the undo reply states only that something was
undone. Every natural-language reply, like every slash-command confirmation, is a public group
reply. Reply rate limits (per member and per chat, `src/interaction/state.ts`) exist because
that publicness makes flooding a group through her a real risk.

## 5. SimpleX has no persistent user identity — consent is bound to a stable-but-not-durable member id

SimpleX does not give a member a durable, cross-session identity. A member who leaves and rejoins a group is issued a **new** group member id. Cinderella's schema is designed around exactly this.

`migrations/002_consent.sql:1-13` binds consent to the **stable group member id** (`consent.member_id TEXT PRIMARY KEY`, line 7), never the display name (which can collide across members and is mutable). The migration's own comment states the consequence directly: "A member who leaves and rejoins gets a new member id, so consent does not carry over — that is intended (fresh consent on rejoin)." (`migrations/002_consent.sql:3-4`)

Consequences that follow from this, all visible in code:

- **No durable bans / no durable identity.** Because the id is regenerated on rejoin, there is no stable handle to ban or to carry consent across a leave/rejoin. Consent is intentionally re-requested.
- **The id is used everywhere consent matters.** Capture records `senderMemberId` from `member.memberId` (`src/capture/message.ts:137`, and the field is documented "Stable group member id (NOT the display name)" at `message.ts:46`). The consent handler records opt-in/opt-out against `msg.senderMemberId` (`src/consent/commands.ts:83`, `87`), and the publish-state view joins `messages.sender_member_id` to `consent.member_id` (`migrations/002_consent.sql:35`).
- **Publication is derived, forward-only.** The `message_publish_state` view (`migrations/002_consent.sql:21-35`) computes `published` live from: not deleted, a consent row exists, `revoked_at IS NULL`, and `sent_at >= opted_in_at`. Opt-in timestamps use the group-message clock domain (`opted_in_at` is the `/publish` message's timestamp, per the column comment at `migrations/002_consent.sql:8-10`), so "from the moment you say yes, forward only" is enforced at the id+timestamp level, not by a stored flag.

## 6. Public archive front — the embed/host wire contract (CCB-S2-003)

Not SimpleX wire, but the outward HTTP/embedding contract the public front commits
to (so hosts, crawlers, and later briefings can rely on it):

- **iframe auto-height.** The embed page posts `{ cinderellaEmbedHeight: <px> }` to
  `window.parent` on `load`/`resize` (and via `ResizeObserver`), and again after a
  live-update DOM swap (CCB-S2-006), matching the Season 1 snippet's listener that
  filters on `e.origin === publicOrigin` and `e.data.cinderellaEmbedHeight`
  (`src/web/views/embeds.ts:24-30`, `src/web/front/render.ts` `HEIGHT_SCRIPT` /
  `LIVE_SCRIPT`).
- **URL-driven, crawlable filter state.** Filtering/search is expressed as query
  params on `GET /embed/:id`: `type` (one of text/image/video/voice/link/file),
  `since`/`until` (`YYYY-MM-DD`, interpreted UTC), `q` (full-text), `page`. Each is
  honoured only if the instance enables that filter; the canonical URL echoes the
  active params, so filtered/searched views are shareable and indexable.
- **Media URL scheme.** A published item's media is addressed as
  `GET /embed/:id/media/:messageId` — resolved through `published_messages` every
  request (never a raw path), `404` when not published. Images and video render inline
  (`content-disposition: inline`); files download. The route honours HTTP **byte-ranges**
  (CCB-S2-008): it always sends `Accept-Ranges: bytes`, and a `Range` request gets a
  `206` with `Content-Range` (satisfiable) or `416` (not) — required for inline `<video>`
  on WebKit and for seeking. The consent check runs before the range branch, so an
  unpublished id `404`s regardless of a `Range` header.
- **Inline video + embed snippet (CCB-S2-008).** Video is a native
  `<video controls preload="metadata" playsinline>`; a Download button (and the native
  download control) appear only when the instance's `player.showDownload` is on, else the
  player carries `controlsList="nodownload"`. The copy-paste host snippet's iframe now
  carries `allow="fullscreen" allowfullscreen` so the fullscreen button works cross-origin,
  and the page re-posts `{cinderellaEmbedHeight}` on `loadedmetadata`/`fullscreenchange`.
- **SEO payload.** The page head emits schema.org JSON-LD as a `@graph`
  (`WebSite`, `Organization`, and an `ItemList` of `DiscussionForumPosting`), plus
  Open Graph / Twitter Card tags; `<` is escaped to `<` so message text cannot
  break out of the `<script type="application/ld+json">` block.
- **SEO artifact endpoints (CCB-S2-004).** All consent-gated, all off the instance
  `seo` config:
  - `GET /embed/:id/sitemap.xml` — `<urlset>` of public front URLs (base, pagination,
    per-type filters) with `<lastmod>` from the newest published `sent_at`; empty when
    the instance is `noindex`.
  - `GET /sitemap.xml` — origin `<sitemapindex>` referencing the marketing-site sitemap
    (`/sitemap-site.xml`, CCB-S2-012) + every instance sitemap.
  - `GET /robots.txt` — since CCB-S2-012, `Allow: /` with explicit `Disallow:` for each
    admin surface, `Sitemap: {origin}/sitemap.xml` (§7).
  - `GET /embed/:id/feed.xml` — RSS 2.0 of published items (linked from the page head
    as `rel="alternate" type="application/rss+xml"`).
  - `GET /embed/:id/og.png` — a 1200×630 PNG social preview (SVG rasterized via
    `sharp`), only when `seo.og.autoImage` is on.
  - JSON-LD `@graph` is toggle-driven: WebSite+SearchAction, Organization,
    CollectionPage+BreadcrumbList wrapping an ItemList of the configured posting type
    (`DiscussionForumPosting` / `Article` / `SocialMediaPosting`), plus
    ImageObject/VideoObject on media items.
- **Theme sync contract (CCB-S2-005).** The front persists the visitor's theme in
  `localStorage['sg-theme']` (`'light'`/`'dark'`) — the SAME origin-scoped key the
  operator's site uses, so the stream and site stay in sync. `data-theme` on `<html>`
  is the switch (default `dark`); a no-flash `<head>` script applies the stored value
  before paint (and honours `prefers-color-scheme` for `mode: auto`); `<meta
name="theme-color">` is `#050A12` (dark) / `#FAFBFD` (light), updated on toggle.
- **Live auto-update + infinite-scroll contract (CCB-S2-006/007).** An open page keeps
  itself current AND pages the archive without a manual refresh, via consent-gated
  endpoints keyed by the SAME query params as the page (so the filtered view stays
  live), all reading `published_messages`:
  - **Cursor**: an opaque base64url of `"<sent_at::text>|<id>"` (full precision). SSR
    emits it on each card (`data-cursor`) and the next-page cursor on `#stream-list`
    (`data-next-cursor`, plus `data-has-more`, `data-at-top`, `data-window-cap`,
    `data-page-size`, `data-hash`, `data-poll`). A malformed cursor → `400`.
  - `GET /embed/:id/page?cursor=<c>&dir=older|newer` → `{ "html": "<li…>…", "nextCursor":
"<c>|null", "hasMore": <bool> }`. `html` is the bare card sequence (reuses the SSR
    renderer). `older` pages down (strictly older); `newer` pages up (newest-first).
    `cache-control: no-store`.
  - `GET /embed/:id/state?cursor=<bottom>&top=<top>` → `{ "hash": "<16-hex>", "ids":
[<band ids>], "hasNewer": <bool> }` over the loaded band `[bottom, top]` inclusive.
    Ids + hash only (never bodies/media), `cache-control: public, max-age=5`. Without a
    cursor it falls back to the legacy page-1 window (empty-view use).
  - The client (`STREAM_SCRIPT`) auto-loads older on scroll (IntersectionObserver),
    windows the DOM (height-preserving top spacer), polls `state` every ~18s to sweep
    recalled ids + prepend new head publishes, re-posts iframe height after every
    mutation, and **pauses while `document.hidden`**. `/page` + `/state` sit in SEPARATE
    per-IP rate-limit buckets. A recalled id vanishes (media `404`s) within one interval.
  - **Crawlable deep pages**: `<link rel="prev"/"next">` in `<head>` (range-gated,
    canonicalBase-consistent) alongside the unchanged `?page=N` SSR pages + sitemap.
  - The CCB-S2-006 `/fragment` route + wholesale swap are REMOVED; SSE
    (`/embed/:id/events`) remains a recorded future upgrade.
- **Content report contract (CCB-S2-009).** `POST /embed/:id/report` — a plain same-origin
  `<form>` POST (fields `msg`, `reason` ∈ {illegal, spam, copyright, other}, optional `note`),
  no CSRF/session (the one exempt mutating public-front route). Always answers with a neutral
  `303` → `?reported=1` (whether stored, deduped, or gated), so it is never an existence/publication
  oracle; `400` only for a reason outside the enum, `403` for a `Sec-Fetch-Site: cross-site`
  submission or over the per-IP rate limit. A report never changes publication (visible-until-review).
  The confirmation banner renders on the follow-up `GET /embed/:id?reported=1`.

## 7. Public marketing site — routing & i18n wire contract (CCB-S2-012)

The domain root is a public SSR site ([`src/web/site/`](../src/web/site/)), separate from
`/embed` and the admin. Routes and the language contract:

- `GET /` → `302` to `/<lang>`, where `<lang>` is the persisted `cin-lang` cookie if a
  supported locale, else the first supported `Accept-Language`, else the default (`en`).
  `cache-control: no-store`.
- `GET /<lang>` → the localized landing page; `GET /<lang>/<slug>` → a localized page
  (built pages render content; the not-yet-built ones render a `noindex` "coming soon"
  stub — never a 404; an unknown slug is a `404`). One static route per **loaded** locale
  (`locales/<code>.json`), so adding a language is a file, not code.
- **Language persistence.** Serving any `/<lang>*` page sets `cin-lang=<lang>`
  (`HttpOnly`, `SameSite=Lax`, `Path=/`, 1-year) — a functional/essential cookie, no
  consent required (like the theme).
- **SEO head.** Per page: `<title>`, meta description, `<link rel="canonical">`,
  `hreflang` alternates for every locale + `x-default`, Open Graph + Twitter (per-locale
  `og:locale`), and JSON-LD `@graph` = Organization + WebSite + SoftwareApplication (stable
  `@id`s cross-linked by `publisher`). Home is `index, follow`; thin stubs `noindex, follow`.
- `GET /sitemap-site.xml` → `<urlset>` of the indexable pages, one `<url>` per locale each
  carrying `xhtml:link rel="alternate"` hreflang entries; referenced from the origin
  `/sitemap.xml` index. `cache-control: public, max-age=3600`.
- **Headers** (`applySiteHeaders`): the same nonce CSP as the archive front but
  `frame-ancestors 'none'` + `X-Frame-Options: DENY` (non-embeddable), indexable,
  `cache-control: no-store` (per-request nonce). No mutating routes.
- **Theme sync.** Reuses the same `localStorage['sg-theme']` key + `data-theme`/no-flash
  contract as §6 (shared via `src/web/theme.ts`).
- **Consent-gated add-ons (D-025).** When the operator enables analytics AND the cookie
  banner, an inline nonce'd bootstrap shows the banner and, only on `cin-consent=granted`
  (localStorage), injects the operator's analytics `<script src>`; the analytics origin is
  added to `script-src`/`connect-src`. With the banner off, nothing loads. Social share is
  script-free `<a>` links to each network's share endpoint (title + canonical URL params).

## Appendix: related file-transfer wire behaviour (context)

Not in the outline, but relevant to the same "what SimpleX actually puts on the wire" theme and verified in `src/bot/files.ts`: SimpleX media is **preview-only until downloaded**. An incoming image/video/file carries only metadata plus a base64 thumbnail inline; the real bytes move over XFTP and must be _received_ per file (`files.ts:1-15`, `receive` at `files.ts:68`). Receipts are issued with `storeEncrypted: false` so the file lands readable for the media store, and `userApprovedRelays: true` (`files.ts:98`). XFTP relays expire files after ~48h, so late/failed receipts are surfaced rather than retried forever (`files.ts:8`). `rcvFileWarning` is treated as transient (the transfer continues), while `rcvFileError` is terminal (`files.ts:154-172`, and the subscription wiring at `src/bot/client.ts:116-120`).

## Summary of divergences from the outline

1. **Private per-member channel does not exist.** The outline's "member-support scope as the only private per-member channel" is not implemented. Consent is group-only; there is no direct/DM path (`src/capture/message.ts:119-123`), and consent confirmations are posted publicly into the group as group replies (`src/consent/commands.ts:63`). Planned / not yet implemented.
2. **Avatar size is a range, not a fixed 192px.** The outline's "~192px square JPEG" is the starting size; the code steps down through 160px/128px and five quality levels to fit budget (`SIZES`/`QUALITIES`, `src/bot/avatar.ts:37-38`).
3. **The enforced budget is 12000 URI characters, not the ~15,610-byte envelope.** The 15,610 figure is only an explanatory comment (`src/bot/avatar.ts:17`, `35`); the actual check is `MAX_DATA_URI_CHARS = 12000` (`src/bot/avatar.ts:36`, `52`, `73`).
4. **MIME type is `image/jpg`, not `image/jpeg`.** Literal prefix `data:image/jpg;base64,` (`src/bot/avatar.ts:50`).
5. **Consent commands do not use the SDK's command dispatch.** The outline implies command handling; the code ignores the SDK's `onCommands`/`ciBotCommand` path and parses `/publish`/`/unpublish` itself in the capture handler with an exact string match plus a no-attachment guard (`src/capture/handler.ts:102-103`, `src/consent/commands.ts:19-24`).
