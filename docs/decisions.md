# Cinderella — Decision Log

> _Living document — Cinderella, Seasons 1–3. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S3-010**._

Standing record of the architectural and operational decisions taken across
Seasons 1–2, newest first. Each entry states the decision, a one-line rationale, and
whether it is **IMPLEMENTED** (present in the code / config today) or **PLANNED**
(committed direction, not yet in code). Where a decision differs from how the code
actually behaves today, the divergence is called out inline.

Companion documents: `seasons/SEASON-1-PROTOCOL.md` (close-out CCB-S1-017),
`CLAUDE.md` (standing architecture). Paths below are repo-relative.

---

### D-064 — Capture events are written ahead to a durable log before they are processed

**Status: IMPLEMENTED (CCB-S3-024 Slice 1: the durable substrate). PLANNED (Slice 2: the
dispatcher records-then-processes through it; Slice 3: retention prune + admin counts + crash test).**
**Finding (§1, the extent, established before any change).** SimpleX delivers each event ONCE and
never re-sends it. Of the events the running bot subscribes to, two were lost on any handler failure
with only a log line: an ordinary **new message** and an **edit** (`capture/handler.ts`, `persist()`
catches, logs, returns false, drops). Deletions became durable in CCB-S3-023 (`deletion.apply`);
file-download receipts are recorded as `media_error` but never retried — which is exactly the 16
unrecoverable receipts of CCB-S3-018 (recorded, not retried, past the ~48h relay window). Member and
profile events are not subscribed by the running bot at all (only by the one-shot `connect` helper).
**Production before-check.** The SimpleX core DB was cross-referenced against the archive: of 438
non-deleted received member messages, 67 were not captured — **all** text, real-time, on Jul 19–22,
and **all** in categories that were intentionally not archived at the time (consent commands like
`/publish`, and messages addressed to the bot before CCB-S3-009 made instructions archivable). **Zero**
gaps on Jul 23–24. So the new-message/edit loss path is real in code but has not fired for ordinary
member content — the same latent-but-untriggered shape the deletion finding had.
**Decision.** A write-ahead log (`migrations/018_capture_events.sql`, `src/capture/events/`): every
in-scope capture event is recorded BEFORE it is applied, and marked processed only on success. A
failed apply leaves a durable row the queue drains and retries (`capture.drain`, interactive lane),
instead of a message lost to a log line. The write-ahead is idempotent (dedupe key); the drain
preserves per-conversation order on replay and DEFERS an early deletion (a deletion whose message has
not arrived) rather than treating it as an error; a poison event dead-letters (kept, never dropped)
and is distinguishable from an ordinary job failure. The CCB-S3-019 scope gate runs BEFORE the write,
so support-scope and direct events never enter the store.
**Retention (§5).** Processed rows prune after a short, configurable window (raw events hold member
content); pending, deferred, and dead rows are never pruned (unfinished work and lost events are
forensic evidence).
**Evidence.** `migrations/018_capture_events.sql`; `src/capture/events/{store,replay}.ts`;
`src/queue/index.ts` (`capture.drain` registration + `enqueueCaptureDrain`);
`scripts/verify-capture-events.ts` (30 checks: idempotent write-ahead, apply/processed, transient
retry→dead-letter, permanent fail-fast, ordering with a stalled insert, out-of-order deletion defer,
bounded defer, counts, retention pruning only processed rows, real-worker drain); `docs/architecture.md`.

---

### D-063 — Swallowed-error audit: caught errors are classified, and silent failure is surfaced

**Status: IMPLEMENTED (CCB-S3-023).**
**Finding.** The season's recurring fault (five incidents) is a caught error converted into an
ordinary-looking state with nobody told. An audit classified all **114 caught errors** in the
codebase: **85 correct, 19 silently-degrading, 10 masking**; an adversarial verify pass confirmed
**9** of the degrading/masking cases on the critical paths.
**Worst case (broken all along).** A failed in-group deletion (`capture/handler.ts` `runDeleted`) was
only `log.error`'d, so member-deleted content could stay **published** with the dashboard green — a
silent breach of the consent-first rule. Now loud (`status.error` naming the message ids).
**Fixes (failure made visible, not necessarily thrown).** Deletion failure and consent-command
classification failure now surface to the dashboard with ids; the `secrets.ts` decrypt path now
distinguishes **stored-but-undecryptable** from **unset** (the not-configured-vs-failing distinction),
shown in the Plugins page and checked at boot; the CoinGecko market-cap enrichment, the files-folder
config, the serve-time media stat, the Argon2/TOTP verifies, the avatar read, and the site-icon read
no longer swallow; recorded media failures now have an admin surface (dashboard).
**Startup self-check.** Boot now verifies configured **credentials** are usable (an enabled provider
whose stored key will not decrypt is reported via `status.error`), generalising the existing pin and
media derivative checks; and those checks' own failures are now surfaced too.
**Rule.** Recorded as a standing non-negotiable in `CLAUDE.md`: surface failures, distinguish
not-configured from configured-but-failing, count masking fallbacks, and do not add noise.
**Deletion path (follow-up, done).** Production was checked against the SimpleX core DB: all 6
in-group deletions were correctly applied and zero are still published, so the `runDeleted` finding
never actually fired. A failed deletion now enqueues a durable `deletion.apply` job (idempotent,
interactive lane, fail-fast on a bad payload) that retries until it succeeds or dead-letters, and the
alert is actionable. This is effective fail-closed: the withhold (`group_deleted=TRUE`) is a DB write,
so it cannot literally remove the window (a failed write cannot withhold), but the leak window only
exists while the DB is up — the archive is unreadable while it is down — and the durable retry closes
it there in seconds, guaranteeing the deletion is applied.
**Still deferred (in the backlog, risk stated).** Atomic consent-command categorisation (so a
classification failure cannot leak the command); a generalised plugin `selfCheck()` interface. The many safe, already-logged backstops were left as-is
to avoid crying wolf.
**Evidence.** `src/capture/handler.ts`, `src/plugins/secrets.ts` + `crypto-prices/settings.ts` +
`web/views/plugins.ts`, `src/bot/client.ts`, `src/web/front/embed.ts`, `src/web/views/dashboard.ts`,
`src/index.ts` (self-check), `src/web/auth.ts`, `src/bot/avatar.ts`, `src/web/site/icons.ts`,
`crypto-prices/providers/adapters.ts`; `CLAUDE.md`.

---

### D-062 — Background work runs on ONE durable Postgres-backed queue

**Status: IMPLEMENTED (CCB-S3-022 foundation; media migration + backfill + admin page are the
planned phase 2 of the same briefing).**
**Decision.** All background work moves onto a single durable job queue (`migrations/017_jobs.sql`,
`src/queue/`) instead of each piece inventing its own approach. Jobs live in Postgres, survive
restarts, are claimed with `FOR UPDATE SKIP LOCKED`, retry with bounded exponential backoff, and
dead-letter (kept, not deleted, not looped) on the final attempt or a `PermanentJobError`. Priority
lanes (interactive before bulk), per-type and global concurrency limits, and a pausable bulk lane
keep a backlog from starving a member's reply or taking the shared process down. Idempotency keys
dedupe enqueues; handlers must be idempotent.
**Rationale.** Every silent failure this season came from ad-hoc background work failing where nobody
could see it: derivatives that could not be written, a remediation script run as root, in-memory logs
that lost their evidence on restart. Categorisation and the gallery will be far heavier; building them
on ad-hoc work would repeat every failure at scale. The queue is deliberately boring: one process,
one database, no broker. `SKIP LOCKED` still lets a second process pull safely if it is ever needed.
**Crash recovery, hardened by an adversarial review.** A multi-agent review of the reclaim path
caught four real defects the first harness missed: `completeJob`/`failJob` had no ownership fence (a
superseded "zombie" run could clobber a newer run's terminal state); the sweep reclaimed a job the
LIVE worker still held (double-running a slow-but-alive handler and consuming an attempt on a job that
never failed); a graceful deploy consumed an attempt and could dead-letter a single-attempt in-flight
job; and a non-integer per-type threshold threw in the `::bigint` cast and the swallowed error
silently disabled all reclaim. All four are fixed and locked in by `verify:queue` (attempt-fence,
live-worker exclusion, orderly-drain vs hard-crash, float sanitisation) — see architecture §21.
**Evidence.** `migrations/017_jobs.sql`; `src/queue/{types,store,registry,worker,index}.ts`,
`src/queue/jobs/analysis.ts`; `scripts/verify-queue.ts` (48 checks: durability, no-double-claim,
backoff + dead-letter, permanent fail-fast, starvation with a 2000-job backlog, concurrency + pause,
idempotency, per-type threshold, ownership fence, orderly drain, observability); `docs/architecture.md`
§21.
**Not built here (deliberately).** No categorisation and no AI integration; the analysis job is a
placeholder that records "no provider configured". The analysis interface waits for the AI briefing.

---

### D-061 — No em-dashes in member-facing output, enforced; help reads as blocks

**Status: IMPLEMENTED (CCB-S3-021).**
**Decision.** The em-dash (`—`), en-dash (`–`), and horizontal bar (`―`) are banned from every
member-facing string, in every language, and the ban is enforced by `verify:no-dashes`. The harness
guards on three fronts: locale files (blanket), the composed runtime output (persona, retorts, the
help reply + its topics, the welcome message), and a comment-stripped source scan of the copy-bearing
modules plus the whole `src/plugins` tree, so a new plugin's strings are caught without anyone
remembering to. The rule is recorded in `CLAUDE.md`.
**Also.** The help reply was regrouped into blocks separated by blank lines (who she is, how to talk
to her, what publishing means, what you can ask), one icon per heading rather than one per line, and
an undecorated command list. Every fact was kept, including the three publishing properties; the
fuller detail stays in `help consent` / `help prices`. The welcome message's "three things" run-on
became three lines. This is a formatting change, not a content cut.
**Rationale.** The operator has a standing style rule against these characters; without an enforced
check the fault returns the moment someone writes new copy (the same lesson as the doubled-delimiter
guard, D-003 era). And the help is the first thing a new member sees, so vertical grouping is worth
more than density.
**Evidence.** `scripts/verify-no-dashes.ts`; `src/interaction/help.ts`, `src/interaction/settings.ts`,
`src/consent/commands.ts` (WELCOME_MESSAGE), `locales/*.json`; `CLAUDE.md`.

---

### D-060 — The admin console shares the website's dark-neon design system

**Status: IMPLEMENTED (CCB-S3-015 Stage 3).**
**Decision.** The admin console adopts the marketing site's dark-neon design system (cyan accent) by
extending `assets/app.css`: the site design tokens (mirrored from `src/web/site/css.ts`), the site's
self-hosted Source Sans 3 / JetBrains Mono woff2, a dark base, and un-layered CSS that remaps the
light Tailwind color utilities (`bg-white`, `text-slate-*`, `bg-red-50`, …) to the dark palette. Only
the admin links `app.css` — the public archive front and the marketing site inline their own CSS — so
this cannot touch a public surface, and no per-view rewrite was needed. Primary actions render cyan,
the active nav gets a cyan bar, form fields are dark with a cyan focus ring.
**Rationale.** Tailwind v4 places its utilities in `@layer`, so plain un-layered overrides win the
cascade over the numbered utilities without `!important` or editing every view — the smallest change
that re-themes the whole console. Reusing the site tokens keeps one visual language across the
product. No inline styles and no CSP change: the sheet is same-origin (`style-src 'self'`) and the
fonts load under `default-src 'self'`.
**Verified.** Browser computed-style checks on the login, dashboard, and settings pages: dark
surfaces, cyan accent/active-nav/buttons, dark form fields, and ZERO light-background elements on a
form-heavy page; `verify:admin` / `verify:admin-views` still green (function unchanged).
**Evidence.** `assets/app.css`; `docs/architecture.md` §7.
**Follow-up.** Stage 2 (two-column tiles + per-tile save) is next; the token system this establishes
is what those tiles are built on.

---

### D-059 — Capture is a whitelist: only a public group message is ever archived

**Status: IMPLEMENTED (CCB-S3-019, urgent security fix).**
**Decision.** An incoming chat item is captured only when it is POSITIVELY a public group message —
`chatInfo.type === 'group'` **and** `chatInfo.groupChatScope === undefined`. The gate,
`isPublicGroupChat`, lives in `src/capture/message.ts` and is called by `parseGroupMessage`, the one
function every incoming item passes through, before persistence and before consent. A member's
private "Chat with admins" thread (member-support scope) arrives on the same `newChatItems` event as
ordinary messages and is now excluded there; so is a direct chat (CCB-S3-017 §2), and so is any
future scope the predicate does not recognise as public.
**Rationale.** The CCB-S3-016 audit found the pipeline had no scope check, so a private conversation
by an opted-in member would have been captured and published — the exact thing a private channel
exists to prevent, and unrecoverable once read. A whitelist that fails closed is the durable rule: a
missing archive row is a small, recoverable loss; a leaked private message is not. A blacklist of
known-bad scopes would have to be extended for every new scope; a whitelist excludes the unknown by
construction.
**Diagnostic.** Expected exclusions (direct chats, `memberSupport`) are silent; an UNRECOGNISED
scope is counted and surfaced on the dashboard (amber), because capture stopping for a reason we do
not understand must never be invisible (`unrecognisedScopeType`, `src/capture/scope-diagnostics.ts`).
**Remediation outcome.** The scan found 2 support-scope rows already captured, 0 ever published, from
one member; both removed.
**Evidence.** `src/capture/message.ts` (`isPublicGroupChat`, `unrecognisedScopeType`,
`parseGroupMessage`); `src/capture/handler.ts` (deletion path uses the same predicate);
`src/web/views/dashboard.ts` (the amber diagnostic); `scripts/verify-support-scope.ts` (fails if the
gate is removed; asserts the counter); `scripts/scan-support-scope.ts` (existing-data remediation);
`docs/security.md` §9h.

---

### D-037 — Symbols are resolved once, pinned in the database, and never silently re-resolved

**Status: IMPLEMENTED (CCB-S3-004).**
**Decision.** The first time a symbol is asked for it is resolved against the provider chain.
One match is pinned automatically; several make Cinderella ASK the member, and their answer is
pinned. Pins live in `asset_mappings`, are GLOBAL by default (HEX is HEX whichever group
asks, with a per-community scope available for genuine exceptions), and are never re-resolved.
An operator can lock a mapping so automatic resolution can never touch it, edit it, or delete
it to force a fresh resolution. A row identifies an ASSET — display name, chain, contract —
and carries a `provider_ids` map, because ids are not portable between providers.
**Rationale.** Provider search rankings move. Re-resolving on every request means the same
question can quietly return a different token's price on a later day, and nobody would notice
until someone acted on it. Pinning makes the answer reproducible and makes any change to it a
deliberate, visible act. Asking rather than choosing is the same instinct as the consent
handshake: a wrong pin is durable, so the cheap question is worth it once.
**Evidence.** `migrations/010_asset_mappings.sql`; `src/db/asset-mappings.ts`;
`src/plugins/crypto-prices/service.ts` (`resolve`, `pin`); `scripts/verify-price.ts` §5–§7.

---

### D-036 — Capabilities beyond the archive are PLUGINS, and a disabled plugin registers no intents

**Status: IMPLEMENTED (CCB-S3-004).**
**Decision.** A plugin declares an id, a name, a version, a default-enabled flag, the intents
it contributes, and its own admin page. Enablement lives under the `plugins` settings key and
each plugin's settings under `plugin:<id>`. The sidebar has a **Plugins** entry whose submenu
is generated from the registry. Crucially, the intent catalog is now split: a compile-time
closed set (`INTENTS`, which makes an invented intent a type error) and a RUNTIME ACTIVE set
recomputed whenever enablement changes. A disabled plugin's intents are absent from the active
set, so the rule engine skips their patterns and the resolver seam downgrades them to UNKNOWN.
**Rationale.** "Disabled" must mean the capability is not there, not that a handler declines
politely. A half-wired handler behind a switch that is off is exactly the shape of thing that
answers a question it should not — and CCB-S3-005 had just finished proving how expensive an
unwanted answer is. Making absence the mechanism means there is no handler to reason about.
**Consequence.** Adding a second plugin is a `definePlugin` call, a settings page, and one
import — no change to the sidebar, the resolver, or the settings framework.
**Evidence.** `src/plugins/registry.ts`, `src/plugins/service.ts`;
`src/interaction/intent.ts` (`setActiveIntents`, `isActiveIntent`);
`src/interaction/resolver.ts`; `src/interaction/rules.ts`; `src/web/views/plugins.ts`;
`scripts/verify-price.ts` §1.

---

### D-058 - The contact-member structural link exists; the pairing protocol is the conditional fallback

**Status: FINDING (CCB-S3-017 Addendum A, research only - nothing built; blocked on CCB-S3-017 section 3).**
**Finding.** A direct contact created from a group member carries a trustworthy, core-set link back
to that member - `Contact.contactGroupMemberId` <-> `GroupMember.memberContactId`, delivered together
in `newMemberContactReceivedInv`, and openable by the bot itself via `apiCreateMemberContact`
without a public address (wire-format section 8f). So per the Addendum's first instruction, the
pairing-code protocol is UNNECESSARY in the normal case, and I built nothing.
**The caveat that keeps the fallback alive.** Adversarial verification found the whole mechanism is
gated on the group's `directMessages` preference; with direct messages OFF (a legitimate posture for
a public archive group) the link never forms and `apiCreateMemberContact` is prohibited. In that
configuration the pairing-code fallback or the support scope (section 8a) is the only private route
- so the fallback is documented, not deleted, pending a live test.
**Blocked.** The Addendum cannot be built: CCB-S3-017 section 3 (the direct-contact surface - inbound
contact channel, lifecycle events, a directRcv parser + its archive exclusion, a direct reply
transport, contact-member resolution) does not exist, and CCB-S3-017 itself is not in the repo. The
consent write-path can record a first-person decision but nothing can deliver a private one to it.
**Stale-member rule (recorded for the eventual build).** Resolve numeric `groupMemberId` -> stable
`memberId` at use time, never cache across a rejoin, and void the binding when the member record is
gone.
**Evidence.** `docs/wire-format.md` section 8f (citations to the SDK sources at the running version);
`src/consent/apply.ts`, `src/consent/commands.ts` (the group-keyed write path).

---

### D-057 — The member support scope is available in the SDK; initiation is the one open question

**Status: FINDING (CCB-S3-016, research only — nothing built).**
**Finding.** An evidence-based audit of `simplex-chat` 6.5.4 / `@simplex-chat/types` 0.8.0
(`docs/wire-format.md` §8) establishes that the member support scope ("Chat with admins") IS
exposed by the TS SDK and is reachable by Cinderella's group-only, `createAddress:false` bot: a
send targets `#<group>(_support:<memberId>)` via `ChatRef.chatScope`, and a received support
message arrives on the ordinary `newChatItems` event distinguished by `chatInfo.groupChatScope`.
This corrects the earlier doc claim (§4) that there is "no private per-member channel at all" —
true of the code, not of the SDK.
**The open question.** Whether a moderator can INITIATE a support conversation, or only reply to
one a member starts, is not determinable from the types and needs a live test. It decides whether
private onboarding is possible or whether the channel is reply-only.
**The prerequisite.** Support-scope messages ride the same event as group messages, so capture
must exclude them (`chatInfo.groupChatScope` present) before anything is built, or a private
message could reach the public archive. Not yet implemented.
**Also found:** real moderation/membership tooling is already exposed (accept/reject/remove
members, role changes, block-for-all, roster with join times and pending status), and reactions
(send and the unsubscribed `chatItemReaction` event) are a free interaction primitive. Forwarding
and the command menu are core-only / not-applicable gaps.
**Evidence.** `docs/wire-format.md` §8 (full table, citations to the SDK sources at the running
version).

---

### D-056 — Video links are click-to-play, and their thumbnails are ours

**Status: IMPLEMENTED (CCB-S3-014).**
**Decision.** A recognised video link renders as a card that loads NOTHING from a third party until
the visitor clicks. The thumbnail is obtained once at capture — the wire image SimpleX delivered,
else a one-time server fetch — stored as the message's own media so it rides the CCB-S3-011
strip-and-serve pipeline, and served from `/media`. On click, a first-party handler writes a
`youtube-nocookie.com` iframe. The CSP `frame-src` is widened only on a page that has a card;
`img-src` and `script-src` gain nothing. Providers are a matcher REGISTRY (`src/media/video.ts`):
adding PeerTube or Vimeo is a matcher, not a rewrite.
**Rationale.** A standard embed loads Google's player and trackers on page load — against the
product's position and, under EU rules, the class of loading that needs prior consent. The click is
the consent, and it keeps working with the cookie banner off. Hotlinking a remote thumbnail would
be the same tracking one step earlier, so the thumbnail is always local; a failed fetch falls back
to a neutral placeholder, never a remote image.
**Evidence.** `src/media/video.ts`, `src/media/thumbnail.ts`, `src/capture/video.ts`;
`migrations/016_video_links.sql`; `src/web/front/render.ts` (card + click handler),
`src/web/front/embed.ts` (scoped CSP), `src/web/front/seo.ts` (VideoObject); `scripts/verify-public.ts`
— the card, the no-iframe-before-click and no-third-party-host assertions, the CSP scoping, and the
consent gate on the thumbnail. Browser-verified: zero third-party requests before the click.

---

### D-054 — Help is generated from the active catalog; the command menu is not applicable

**Status: IMPLEMENTED (CCB-S3-010 Part 2).**
**Decision.** The help reply is built from `activeIntentList()`, so it lists only enabled
capabilities: a disabled plugin stops advertising itself and a new one appears with no copy
change. `help consent` and `help prices` give topic detail. The native SimpleX command menu was
investigated and NOT adopted — it is a direct-conversation affordance and Cinderella has no
contact address, so the menu would render on a surface no member reaches. A `buildCommandMenu`
producer exists over the same catalog, ready if a direct surface is ever added.
**Rationale.** Help is the first thing anyone tries and the one message that must be true about
what she can do now. A static list drifts the moment anything is toggled. An instruction that
begins with "help"/"hilfe" is forced to HELP in the engine, because "help consent" otherwise
resolves to a PRICE lookup ("help" reads as an asset) and beats HELP on score.
**Evidence.** `src/interaction/help.ts`; `src/interaction/engine.ts` (the help-lead override,
`/help` slash, `answerHelp`); `scripts/verify-interaction.ts` §19 — every listed phrasing, the
catalog-driven list, and the disabled-plugin case; `docs/wire-format.md` §3f for the menu finding.

---

### D-055 — Consent copy states forward-only, public-until-revoked, and final, before confirming

**Status: IMPLEMENTED (CCB-S3-010 Part 1, and Addendum A).**
**Decision.** The publish prompt states all three properties before the member says yes; the
unpublish prompt warns it cannot be undone; the welcome message carries the same three; help
repeats them. All in EN and DE, admin-editable, single-delimiter markup. Written to TODAY's
truth — revocation is final — deliberately NOT mentioning hide or restore, which a later briefing
introduces and which would make the copy false now.
**Rationale.** §1a established that publication is derived and revocation was made final by
Addendum A (undo may only reduce exposure). Property 3 is the one members do not expect and can
regret, so it is stated before they confirm, not after. The suggested wording was corrected
against the verified behaviour rather than copied.
**Evidence.** `src/interaction/settings.ts` (`publishConfirm`, `unpublishConfirm`, `published`,
EN+DE); `src/consent/commands.ts` (`WELCOME_MESSAGE`); `scripts/verify-interaction.ts` §19.

---

### D-053 — Undo may only reduce exposure, never increase it

**Status: IMPLEMENTED (CCB-S3-010 Addendum A).**
**Decision.** A consent action is undoable only if undoing it takes content OUT of public view.
Expressed as a rule — `undoReducesExposure(action)` — rather than as a special case for one
action, so any consent operation added later inherits it instead of being reasoned about again.
Undoing an opt-in still works. Undoing a revocation is refused, and she says why rather than
silently doing nothing.
**Rationale.** `undoLastConsentAction` restored the prior `revoked_at`, so undoing a revocation
cleared it and republished everything the member had just taken back, for the length of the undo
window. That made "revocation is final" false — and it is precisely the sentence a member has to
be able to rely on before they confirm something irreversible.
**Why it costs nothing.** The undo window on a revocation protected a member from their own
mistake using a hidden five-minute timer. CCB-S3-011 Part 2 replaces it with HIDE: a deliberate
choice, reversible for as long as they like, and visible to them. Keeping both would have forced
the copy to explain two overlapping safety nets, one of which nobody can see.
**Evidence.** `src/db/consent-actions.ts` (`undoReducesExposure`, and the guard in
`undoLastConsentAction`); `src/interaction/engine.ts` (the `undoNotRevocation` branch);
`scripts/verify-consent.ts` — asserts that undoing an opt-in still works, that undoing a
revocation is refused, that `revoked_at` is never cleared, and that nothing of that member's is
published afterwards.

---

### D-052 — Fail-closed is right; failing SILENTLY is not

**Status: IMPLEMENTED (CCB-S3-011 Addendum A).**
**Decision.** The metadata gate stays fail-closed — an image whose derivative is missing is
never served unstripped. Three things change around it: a missing derivative is regenerated ON
DEMAND at serve time, a boot check sweeps published media and heals what it can, and anything
still unservable is recorded in a failure log the operator can see.
**Rationale.** The gate turned every generation fault into total invisibility. The live cause
was mundane — the `derived/` tree was created by a one-off remediation script running as root,
the service runs as a non-root user, and every new photograph hit `EACCES` and 404'd — but the
SHAPE of the failure is what matters: the archive looked empty, and nothing anywhere said why.
A safety control that cannot be distinguished from a broken system will be switched off by
somebody trying to make the system work.
**What self-heal does NOT mean.** It retries the strip. It never falls back to serving the
original, so the guarantee is unchanged; an image that genuinely cannot be stripped stays
withheld and is reported.
**Evidence.** `src/media/failures.ts`; `src/media/pipeline.ts` (`ensureDerivative`,
`checkPublishedMedia`); `src/web/front/embed.ts` (`healMissingDerivative`);
`scripts/verify-archive.ts` §10 — which asserts the healed file is still metadata-free and that
an unhealable one stays withheld.

---

### D-050 — A member's instruction is that member's message

**Status: IMPLEMENTED (CCB-S3-009).**
**Decision.** Messages the interaction layer consumes are captured and published on the
ordinary consent rules, classified by kind. Instruction categories default to PUBLISH — the
opposite of bot replies (D-047 era, CCB-S3-007 §3) — because her words need a reason to be
public and an opted-in member's words need a reason not to be. Only the consent mechanics are
excluded: `/publish`, its spoken forms, bare `yes` confirmations, nickname-only messages and
bare disambiguation answers.
**Rationale.** The capture path did `if (await interacted(msg)) continue;` — never persisting
anything she handled. That was correct while an instruction meant `/publish`, which is
plumbing. Natural addressing (CCB-S3-002) made a price question an instruction too, and from
that moment every question a member asked her was discarded. The live archive showed her
answers with nothing above them: she appeared to be answering nobody, at exactly the points
where the conversation was most worth reading.
**Evidence.** `src/capture/handler.ts` (persist now runs BEFORE the dialogue);
`src/interaction/engine.ts` (`MEMBER_CATEGORY_FOR_INTENT`, `lastHandledCategory`);
`migrations/015_member_instructions.sql`; `scripts/verify-archive.ts` §9.

---

### D-051 — Question and answer publish or withhold together

**Status: IMPLEMENTED (CCB-S3-009 §3).**
**Decision.** A reply carries `reply_to_id`, and `message_publish_state` publishes it only if
the message it answers is itself published. Derived, like everything else, so a later
`/unpublish` removes both halves on the next read.
**Rationale.** Publishing half an exchange misrepresents what happened, and the half that
survives is HERS — which reads as her talking about a member who chose not to be quoted. The
three cases that matter all fall out of one rule: an excluded category takes its answer with
it, a non-consenting asker takes her answer with them, and a later revocation takes both.
**Note.** The pairing is also the reason capture had to be reordered: the member's row must
exist before she answers, so the reply has something to point at. `ON DELETE CASCADE` makes the
pair one object, so deleting a question can never orphan its answer.
**Evidence.** `migrations/015_member_instructions.sql` (the `base` CTE and the pair clause);
`src/capture/bot-message.ts` (`replyTo`); `scripts/verify-archive.ts` §9, all four cases.

---

### D-048 — Published media is a stripped derivative; the original is never touched

**Status: IMPLEMENTED (CCB-S3-011 §1).**
**Decision.** Metadata is removed on a COPY, and only the copy is ever served publicly. The
serving gate refuses a strippable format that has no derivative, so the failure mode is
"withheld", never "published unstripped". Orientation is applied to the pixels before the tag
is discarded. Formats with no stripper on this instance are recorded as such rather than
assumed clean.
**Rationale.** Consent covers the content, not the hidden payload — publishing an unmodified
phone photo to an indexed page can disclose where a member lives. Stripping the original
instead would trade a privacy problem for an evidence problem: the operator needs the file as
sent for moderation and for any preserve-and-report obligation.
**What the audit actually found.** Nothing. All 57 captured files were clean, because the
SimpleX client re-encodes images before sending. That is a property of somebody else's client
that could change in any release, and it is not a promise Cinderella was in a position to make.
The control exists so the guarantee is ours.
**Evidence.** `src/media/strip.ts`, `src/media/exif.ts`, `src/media/pipeline.ts`;
`migrations/014_media_derivatives.sql`; `scripts/verify-archive.ts` §8 — which asserts in both
directions, using a hand-built GPS fixture, because `sharp` cannot write a GPS IFD and a fixture
made with it would let the whole section pass by detecting nothing.

---

### D-049 — The filename leak was verified before it was fixed

**Status: NO CHANGE REQUIRED (CCB-S3-011 §1.2).**
**Decision.** No change to public URLs. They have always been
`/embed/<instance>/media/<message-id>`.
**Rationale.** The briefing described member filenames as public and indexable. They are not:
the route is keyed by message id, `content-disposition` carries no filename, the download
attribute is synthesised, and the sitemap, feed and JSON-LD all build the same opaque form. The
original filename exists only on disk and in the operator console, which is precisely the state
the briefing asks for. Rebuilding a working URL scheme to fix a leak that was not there would
have risked every existing link for nothing. A harness check now pins the property so it cannot
regress.
**Evidence.** `src/web/front/embed.ts`, `src/web/front/seo.ts`, `src/web/front/render.ts`;
`scripts/verify-archive.ts` §8 (opaque URL passes, filename URL fails).

---

### D-045 — Carry-over may reuse knowledge, never create it

**Status: IMPLEMENTED (CCB-S3-008 §1).**
**Decision.** An intent inherited from the previous turn may only act on an asset this instance
has ALREADY resolved — the check reads `asset_mappings`, never a provider. A carried lookup
can answer; it can never ask. If the fragment is not a known asset, carry-over does not apply
and the ordinary rules take over, which inside the window with a weak signal means silence.
An admin-editable interjection stop-list and a "contains no letters at all" test sit under
that as a cheap second layer.
**Rationale.** D-040 framed the rule as "read-only intents, short fragments". That was not
enough, and the live group showed why within a day: after two price answers a member wrote
`nice :)))))))`, and she offered a choice between "Nice" and "Bury Nice Token". Applause had
been turned into a symbol, sent to a provider, and made into a question — one keystroke away
from writing a permanent pin. A length bound can never fix this, because an interjection is
short by nature. The correct invariant is about PROVENANCE, not size: a resolution is a
deliberate act that follows an explicit question, so an inferred intent must not be able to
start one.
**Evidence.** `src/interaction/engine.ts` (`isInterjection`, `isPinnedAsset`, the `carried`
branch of `answerPrice`); `src/plugins/crypto-prices/service.ts` (`isPinned`);
`scripts/verify-interaction.ts` §18 — including the live fragment verbatim, asserting both
that she stays silent and that no provider is contacted.

---

### D-046 — A stored secret and a submitted secret are different fields

**Status: IMPLEMENTED (CCB-S3-008 §2).**
**Decision.** A typed API key arrives as `apiKeyInput`; `apiKey` holds only the stored
envelope and is passed through untouched. `applySecretUpdate` additionally refuses to encrypt
a value that is already an envelope, and instances written by the old path are unwrapped and
rewritten once at load.
**Rationale.** `PluginService.load()` fed the stored settings back through the same normalizer
the admin form uses, and the normalizer could not tell them apart — so every boot encrypted
the stored key again. The runtime decrypts exactly once, so each provider was handed a
`v1.…` envelope as its credential. The operator's keys had never worked, from the moment they
were entered, and the only symptom anyone could see was "the markets are out of earshot".
Confirmed on the live host: unwrapping two layers produced a well-formed key for both
providers.
**What this cost.** Every authenticated provider call since CCB-S3-004. The harness did not
catch it because its own assertions submitted the key under the STORAGE field name, which is
the same mistake in miniature — they were rewritten to assert a one-step round trip.
**Evidence.** `src/plugins/secrets.ts` (`isEncrypted`, `unwrapSecret`, `repairSecret`);
`src/plugins/crypto-prices/settings.ts`; `src/plugins/service.ts`;
`scripts/verify-price.ts` §10c.

---

### D-047 — A failure that cannot be told apart from a quiet market is not a failure report

**Status: IMPLEMENTED (CCB-S3-008 §3).**
**Decision.** Every provider attempt is recorded with provider, operation, symbol, outcome,
latency and HTTP status, including attempts that were SKIPPED and why. The admin console shows
per-provider health and the recent failures. Members are told apart: an asset nothing knows
gets "I do not know that one", a throttled chain gets "ask again shortly", and only a genuine
outage gets the markets line. An operator-triggered check reports any pin no enabled provider
can serve.
**Rationale.** One message covered a missing key, a bad pin, a rate limit and an outage alike,
which is how D-046 survived in production: nothing distinguished "your credential is being
rejected" from "the market is quiet". A pin nobody can serve is worse than no pin at all,
because an unpinned symbol is resolved and answered while a bad pin fails silently forever —
the same class of defect migration 012 had to repair by hand.
**Evidence.** `src/plugins/crypto-prices/attempts.ts`; `src/plugins/crypto-prices/service.ts`
(`note`, `unavailableSince`, `checkPins`); `src/web/views/plugins.ts` (provider health);
`scripts/verify-price.ts` §10c.

---

### D-042 — Cinderella publishes on the operator's decision, never on a consent row

**Status: IMPLEMENTED (CCB-S3-007 §1).**
**Decision.** Her own messages are captured and published through a SECOND BRANCH of
`message_publish_state`, gated by the `archive` settings. No consent row is ever written
for her. The obvious shortcut — give the bot a member id and an operator-written consent
row, and change no SQL at all — was considered and rejected.
**Rationale.** `consent` is a first-person record: a member's own decision about their own
words. A row in it that nobody chose would make every reading of that table false, and the
admin console would then offer to "revoke consent" for someone who never gave any. The
saving was one CASE expression; the cost was the meaning of the one table this product
rests on.
**Evidence.** `migrations/013_bot_messages.sql`; `src/archive/settings.ts`;
`scripts/verify-archive.ts` §1 — which asserts no consent row exists for her, and that the
consent table still holds exactly the real members.

---

### D-043 — The name guard lives in the derivation, not at composition time

**Status: IMPLEMENTED (CCB-S3-007 §2).**
**Decision.** Before any message of hers is published, every member name it contains is
resolved and checked against that member's CURRENT consent. The check is a read-time
expression in `published_messages`, not a decision taken when the reply was composed.
Unresolvable and ambiguous names count as non-consenting. Full-text search is closed
separately, through a stored `search_body` with every name replaced unconditionally,
because a generated column cannot consult the `consent` table.
**Rationale.** Composition-time redaction would be a stored flag by another name: it could
not be corrected when a member changes their mind, and a reply type added later would
bypass it silently. Read-time evaluation makes a member's `/unpublish` retroactive over
messages of HERS — the property that actually matters, because her words are the one route
by which a non-consenting member's identity could reach the archive.
**Rejected along the way.** Escaping display names inside SQL. Verified against real
Postgres to produce an invalid backreference for a name like `Ro[b]in.*`, which makes the
pattern throw — redaction failing open. Escaping now happens once in TypeScript
(`escapeRegex`) and is stored pre-escaped.
**Evidence.** `migrations/013_bot_messages.sql` (the LATERAL and its comment block);
`src/archive/redact.ts`; `scripts/verify-archive.ts` §3 and §6.

---

### D-044 — Two of the briefing's publish defaults ship excluded

**Status: IMPLEMENTED (CCB-S3-007 §3, departing from the briefing's table).**
**Decision.** `status` and `search` answers ship EXCLUDED rather than published. Both stay
switchable, and the admin help text states what enabling them publishes.
**Rationale.** The briefing's table classifies replies by kind; it could not see what the
strings contain. Her status answer states how many of a member's messages are NOT public —
private information about a member who may never have opted in, and redacting a name does
not remove a count. Her search answer repeats the member's own query verbatim, which
republishes their words under her byline with no consent anywhere in the path, and makes
her own answer a hit in the next search. The leak guard covers NAMES; neither of these is a
name.
**Evidence.** `src/archive/settings.ts` (`DEFAULT_ARCHIVE` and its header);
`src/interaction/settings.ts` (the two persona strings); `scripts/verify-archive.ts` §4.

---

### D-039 — A question about state is never a request for an action

**Status: IMPLEMENTED (CCB-S3-006 §7a).**
**Decision.** The resolver now distinguishes a STATE QUESTION from an ACTION REQUEST and
re-points the former at `STATUS`. The distinction is not question-versus-command — "can you
publish me?" is a question and a genuine request — it is whether the member is asking what IS
or asking for something to HAPPEN. Openers decide: `what is my`, `am I`, `do you have`,
`how many`, `bin ich`, `wie viele` mark state; `can you`, `please`, `kannst du`
and bare imperatives mark action. `publish status`, `publication status`, `my status`,
`Veröffentlichungsstatus` are registered STATUS phrases, and `statistics`/`stats`/
`Statistik`/`Zahlen` join the STATUS vocabulary.
**Rationale.** Live, `whats my publish status?` produced the PUBLISH confirmation prompt: the
word `publish` outranked STATUS, so a member asking about their own record was shown a
consent prompt for an action they never requested. Consent prompts must appear only because
someone asked for the action; anything else trains members to dismiss them, which is exactly
the wrong reflex for the one prompt that matters.
**Evidence.** `src/interaction/rules.ts` (`isStateQuestion`, STATE/ACTION openers);
`scripts/verify-interaction.ts` §18.

---

### D-040 — Elliptical follow-ups inherit only READ-ONLY intents, and only when short

**Status: IMPLEMENTED (CCB-S3-006 §7c).**
**Decision.** Inside the follow-up window, a message that resolves to UNKNOWN may inherit the
member's previous intent and re-resolve with the new slot: `monero?` after a price answer is
a price question. Two guards make it safe. Only `PRICE` and `SEARCH` are ever remembered or
inherited, so no fragment can become a consent action however it is phrased; and the fragment
must be SHORT (four tokens or fewer), because an elliptical follow-up is short by definition.
Admin-switchable as `intentCarryover`, default on. The follow-up window is also now refreshed
by the slash-command path, which previously sent through the transport without touching it.
**Rationale.** Members wrote `and of monero?` and were ignored entirely, then had to retype
the whole sentence. The read-only restriction is stated as an explicit guard rather than left
as an emergent property, because "no path currently reaches PUBLISH" is not a property anyone
can rely on after the next change. The length bound was added after the harness caught the
first version turning ordinary in-window chatter into price questions — the same
over-eagerness CCB-S3-005 spent a briefing removing.
**Evidence.** `src/interaction/engine.ts` (`CARRY_OVER_MAX_TOKENS`, carry-over block);
`src/interaction/state.ts` (`rememberIntent`); `src/interaction/resolver.ts`
(`carryOverSlots`); `scripts/verify-interaction.ts` §18.

---

### D-041 — Majors are pre-pinned; genuine ambiguity is ranked, capped and auto-resolved on dominance

**Status: IMPLEMENTED (CCB-S3-006 §2, §3, §4, §7e).**
**Decision.** The top assets by market capitalisation are seeded into `asset_mappings` as
operator-locked rows, under BOTH ticker and common name (`btc`/`bitcoin`, `xmr`/`monero`),
so they never disambiguate. When ambiguity is genuine, candidates are ranked by market
capitalisation (pool liquidity for DEX results), capped at a configurable maximum (default 4),
shown with that figure beside each, and AUTO-RESOLVED when the leader exceeds the runner-up by
a configurable factor (default 100x). Filler and quantity words are stripped before symbol
extraction, and a candidate that is already pinned beats an unknown word earlier in the
sentence. Display precision follows magnitude with four significant digits below 1, so a
non-zero price can never render as `0`.
**Rationale.** Live, `btc` offered "Bitcoin AI" and "Bitcoin X" as alternatives to Bitcoin;
`monero` never offered Monero at all; `one real bitcoin` resolved the asset as "real"; and
`1 HEX` displayed as `0 USD` against a true value near $0.00048. A price of zero is not a
rounding artefact to a reader, it is a claim that the thing is worthless.
**Correction (migration 012).** The seed alone was not enough. It used
`ON CONFLICT DO NOTHING`, so on the live instance it skipped the rows members had already
created by answering disambiguation questions — and those rows held the very errors this
decision removes, `HEX` pinned to the PulseChain fork rather than the Ethereum token, and
`BTC`/`ETH`/`BNB` carrying CoinMarketCap ids only, hence unreachable once CoinGecko became
first and CoinMarketCap keyless. A seeded symbol is therefore corrected, not skipped, with
provider ids replaced rather than merged so no wrong id survives; rows an operator authored
(`source = 'manual'`) stay untouched.
**Evidence.** `migrations/011_seed_major_assets.sql`,
`migrations/012_correct_major_pins.sql`; `src/price/format.ts`;
`src/plugins/crypto-prices/service.ts` (`weightOf`, dominance, `preferPinned`);
`src/interaction/rules.ts` (filler stopwords, `looksLikeConversion`);
`scripts/verify-price.ts` §10b.

---

### D-038 — Provider chain with failover, licence-bound attribution, and write-only encrypted keys

**Status: IMPLEMENTED (CCB-S3-004).**
**Decision.** Three adapters behind one interface — CoinMarketCap, CoinGecko, Dexscreener —
tried in an operator-configured order with automatic failover on error, timeout, rate limit,
or "does not know this asset". Each is individually enabled, with its own key, timeout and
request budget. **API keys are write-only**: encrypted at rest with AES-256-GCM under a key
derived from `SESSION_SECRET`, never rendered back into the form, never logged, and never
included in an audit entry. Saving the form with the field blank keeps the stored key;
clearing is an explicit checkbox. **Attribution is bound to the answering provider** and
emitted in the reply.
**Rationale (checked, not assumed).** The providers' current terms were read at build time as
the briefing required. CoinGecko's licence requires the credit "Powered by CoinGecko" wherever
its data appears and requires cached data to be refreshed at least daily; CoinMarketCap
requires "Data provided by CoinMarketCap.com"; Dexscreener requires neither. A chat group has
no footer to put a credit in, so it rides on the reply — and because failover means the
answering provider is not necessarily the first one tried, a static template string would
eventually credit the wrong source, which is both a licence breach and a factual error.
**Caching verdicts.** CoinGecko: permitted, with a 24h refresh ceiling the cache enforces per
provider. CoinMarketCap: caching explicitly carved out of its storage ban. Dexscreener: terms
silent, so treated as transient by policy. No provider is exempt from the cache; CoinGecko is
the one that constrains it.
**Open question, recorded rather than resolved.** Whether CoinMarketCap's FREE tier licenses
showing data to a group is genuinely unclear — its live pricing table now says "Commercial
use" while the personal agreement still says personal use only. The console states this next
to the switch so the operator decides with the facts in front of them.
**Evidence.** `src/plugins/crypto-prices/providers/`; `src/plugins/secrets.ts`;
`src/plugins/crypto-prices/service.ts`; `src/web/views/plugins.ts`;
`scripts/verify-price.ts` §2, §8.

---

### D-035 — Prices resolve through a pinned asset registry, are cached, and fail honestly

**Status: Superseded by D-036 and D-037 (CCB-S3-004, revised briefing).** The first cut shipped a hardcoded, code-level asset registry and a single provider. The revised briefing replaced both: mappings are now resolved lazily and persisted, and the provider is a chain of three adapters. What survives unchanged is the principle — never resolve a price from a bare symbol.
**Decision.** A `PRICE` intent joins the closed catalog. Assets are never resolved by
symbol at the provider: an admin-editable **registry** maps the symbols members type to a
**canonical provider id**, recording chain and contract for tokens. HEX ships pinned to the
original Ethereum token (`hex`, `0x2b591e99afe9f32eaa6214f7b7629768c40eeb39`). A symbol
claimed by two entries produces a question, never a choice. The provider sits behind a
`PriceProvider` interface with CoinGecko as the first implementation; quotes are cached
(default 60s) and price questions carry their own per-member and per-chat rate limit on top
of the reply limit. Asset-to-asset questions are computed as a **cross rate** through the
configured base currency. Provider failure, a missing leg, or an unparseable answer produce
"the markets are out of earshot" — never a stale or invented number.
**Rationale.** Three separate assets on the provider answer to the ticker `HEX` (the
original, the PulseChain copy, and a bridged version), so a symbol lookup is a coin flip
that is usually right, which is the worst kind of wrong in a channel where people discuss
money. Pinning the id makes the answer reproducible and the operator's choice explicit and
reviewable. Caching exists because free price APIs throttle quickly and a group can ask more
often than the tier allows; a separate rate limit exists because a price question costs an
outbound call to a third party, not just a message.
**Notable properties.** `PRICE` is read-only: no confirmation, no consent involvement,
nothing journalled — asserted in the harness rather than assumed. Amounts accept unit words
and both separator conventions (`1 million`, `1m`, `1.000.000`, `1,5`); German
"Billion" is deliberately unsupported because it means 10^12 while English "billion" means
10^9, and guessing would be a factor-of-1000 error about money. The optional disclaimer
ships OFF, following D-025: what a price message must say differs by country, so enabling it
is the operator's decision.
**New outbound dependency.** The instance now makes outbound HTTPS calls to the configured
provider. That is the first egress this product makes; it carries no member data, only asset
ids.
**Evidence.** `src/price/` (`assets.ts`, `provider.ts`, `service.ts`, `amount.ts`);
`src/interaction/rules.ts` (PRICE lexicon + slot extraction); `src/interaction/engine.ts`
(`answerPrice`); `src/web/views/interaction.ts` (Market data card);
`scripts/verify-price.ts` (offline by default, `--live` for the real provider);
`scripts/verify-interaction.ts` §18.

---

### D-034 — Matching the wake word is not being spoken to: forwarded messages, weak signals, and per-message reply language

**Status: IMPLEMENTED (CCB-S3-005).**
**Decision.** Four guards now stand between "her name appeared first" and "she was
addressed", each independently switchable in the console: **forwarded messages never reach
the interaction layer**; an **UNKNOWN result is answered only on a strong address signal**
(a greeting, a direct reply to her, or being mid-conversation) and is otherwise met with
silence; an instruction **longer than 200 characters** is acted on only at high confidence;
and an optional **strict mode** requires a greeting before the name. Every ignored candidate
is recorded in a near-miss log shown on the same admin page. Separately, the reply language
is now detected **from the member's message** by a scored contest between hint sets, is
remembered for the follow-up window, and is pinned for the duration of a confirmation
handshake. Default addressing mode is `relaxed` (operator decision).
**Rationale.** A forwarded announcement beginning "Cinderella now understands plain
language" was answered in the group. The addressing logic was correct as specified; the
specification was wrong. Measuring the incident showed it was worse than it looked: the
first 240 characters of that announcement resolve to **PUBLISH at 0.94 confidence**, and
only a hypothetical marker roughly a thousand characters in turned it into the harmless
not-understood reply. Four of five realistic forwarded announcement texts reach a consent
prompt. So the forwarded guard is a consent-safety control, not a politeness fix. Silence is
the right default in a group: a missed address costs one repeated wake word, an unwanted
interjection costs everyone's attention.
**Root cause of the language bug.** `guessLanguage` asked `tokens.some(isGermanHint)` — a
single hint word anywhere decided the whole message. The English announcement contained
exactly one, `hallo`, in its own example of `Hallo Cinderella` working in any language. One
token in 357 made her answer in German. Replaced by a scored contest between German and
English hint sets requiring both a minimum hit count and a margin, so a lone false friend
cannot win, plus an explicit `confident` flag so callers can fall back deliberately.
**Evidence.** `src/interaction/engine.ts` (guards + `replyLanguage`);
`src/interaction/near-misses.ts`; `src/interaction/text.ts` (`detectLanguage`);
`src/capture/message.ts` (`forwarded`); `src/interaction/settings.ts` (`addressing`,
`replyLanguageMode`); `src/web/views/interaction.ts`; `scripts/verify-interaction.ts` §16–§17.
**Wire-level note.** The forwarded marker is `meta.itemForwarded`, NOT
`meta.forwardedByMember`. The latter is group routing and is set on ordinary messages —
verified in the live SimpleX database, where real `/publish` commands carry it. Keying the
guard off that field would have silently broken consent commands.

---

### D-033 — She answers as a plain group message, and her markup follows SimpleX, not CommonMark

**Status: IMPLEMENTED (CCB-S3-003).**
**Decision.** Bot replies default to a **plain group message**. An admin `replyMode` setting
offers `plain` (default), `mention` (opens with the member's display name, from a localised
and disableable prefix template) and `quote` (the previous quoting behaviour). Consent
confirmation prompts, the slash-command confirmations, and nickname retorts **never quote** in
any mode. Both the interaction engine and the slash-command handler send through one transport,
`sendToChat`, so they cannot diverge again. Separately, all persona copy moved from CommonMark
`**bold**` to SimpleX's `*bold*`, and a harness check fails on any doubled delimiter.
**Rationale.** Quoting made every answer repeat the member's message, so a two-message exchange
rendered as four blocks of text to everyone else in the group; at the wire level 30 of the
bot's 33 sent items were quoting replies. The markup half is a plain defect: SimpleX uses
single-character delimiters and prints doubled ones literally, so the live group saw `**yes**`
with visible asterisks. Both were presentation-only bugs, and the fix deliberately touches no
consent logic — the confirmation handshake, the third-party refusal, the rate limits and the
follow-up window are unchanged, and the only edit inside those paths is a transport flag.
**Evidence.** `src/interaction/reply.ts` (pure `formatOutbound` + `sanitizeDisplayName`);
`src/bot/send.ts`; `src/interaction/settings.ts` (`REPLY_MODES`, `namePrefix`, corrected copy);
`src/consent/commands.ts`; `src/web/views/interaction.ts` ("How she answers" card);
`scripts/verify-interaction.ts` §14; `docs/wire-format.md` §3b–§3c.
**Verification note.** The delimiter set was not assumed. It was established twice
independently — by booting the embedded 6.5.4 core and reading back its own parse output, and
by reading `Simplex.Chat.Markdown` at the matching tag — and every shipped string was then run
through the real parser before release, including the punctuation-adjacent cases (`*ja*,` and
`*Cinderella*.`) that the source reading alone could not settle.

---

### D-032 — Consent decisions are journalled with their prior state, so a member can undo their own

**Status: IMPLEMENTED (CCB-S3-002).**
**Decision.** Every opt-in and opt-out now writes a `consent_actions` row recording the
decision, **how it arrived** (`slash` / `natural` / `admin`), and the consent row exactly as
it stood beforehand. `/publish` and the natural-language path share one write function,
`applyConsentChange`. Undo restores the recorded prior state and stamps the journal row
`undone_at`, so an action is never reverted twice. The journal is provenance ONLY —
`message_publish_state` still derives publication from `consent` alone.
**Rationale.** Undo is not expressible from current state: an opt-in that created the first
consent row and an opt-in that replaced a revoked one leave identical rows behind, yet undoing
them must do different things. Recording the prior state at the moment of the change is the
only way to put it back exactly. Sharing one write path also stops the natural-language route
from drifting away from the slash command it is supposed to mirror.
**Evidence.** `migrations/009_consent_actions.sql`; `src/db/consent-actions.ts`;
`src/consent/apply.ts`; `src/consent/commands.ts:79-104`;
`src/interaction/engine.ts` (`performUndo`); `scripts/verify-interaction.ts` §9, §13.

---

### D-031 — Natural addressing: her name is the wake word, the resolver is a seam, and consent still needs a "yes"

**Status: IMPLEMENTED (CCB-S3-002).**
**Decision.** Members may address Cinderella in plain language. A message counts as addressed
when it **starts with the wake word** (optionally after a greeting), replies directly to one of
her messages, or arrives inside a per-member **follow-up window** (default 60s); slash commands
remain, unchanged and immediate. Anchoring is strict and first-word-only: `Cinderellas Archiv`
and `I think Cinderella is great` are never addresses, and a token that is the wake word plus a
suffix is rejected before fuzzy matching can forgive it. Understanding is a **deterministic
rule engine** over EN+DE keyword and phrase sets with typo tolerance, negation/hypothetical/
quotation guards, and a closed intent catalog. It sits behind `resolveIntent`, which validates
every result against that catalog and falls back to the rules if a future resolver fails.
**PUBLISH/UNPUBLISH always require an explicit confirmation**, and any instruction naming a
third party is refused outright, admin or not. Her chat voice ships as admin-editable persona
strings per language; she refuses to answer to nicknames with a rotating retort and no action.
**Rationale.** Typing `/publish` is a barrier for exactly the members whose consent matters
most, but natural language is ambiguous in a way a consent decision cannot afford to be. The
resolution is to make understanding generous and **acting** strict: she guesses freely at what
was meant, then asks before anything is published. Building the rules behind a one-function
seam means the later local-AI brain is a registration, not a rewrite, with the rules surviving
as the offline fallback. No AI ships in this briefing.
**Rejected.** A wake *phrase* ("hey cinderella") — the bare name works in every language for
free, with greetings as strippable decoration. Substring matching on the name — it cannot tell
`Cinderella,` from `Cinderellas`. Acting on a single high-confidence message — a false positive
publishes someone who never asked, which is the one failure this product cannot have.
**Evidence.** `src/interaction/` (`addressing.ts`, `rules.ts`, `resolver.ts`, `engine.ts`,
`state.ts`, `settings.ts`, `text.ts`); `src/web/views/interaction.ts`;
`src/capture/handler.ts` (`onInteraction` / `isAddressed` hooks);
`scripts/verify-interaction.ts` (105 checks); `scripts/verify-admin-views.ts` §11.

---

### D-030 — Website copy & design rules: no em dashes, dark-only, 40 languages, ecosystem links

**Status: IMPLEMENTED (CCB-S3-001 follow-ups, operator-directed).**
**Decision.** Four operator rules amend the D-029 site: (1) the **em dash is banned** from all
visible site copy in every language; sentences are restructured with commas, colons or periods,
and `verify:site` enforces zero U+2014 on rendered pages. (2) **Dark is the only theme**: the
light theme, the toggle and the `cn-theme` storage were removed entirely. (3) The site ships in
**40 languages** (EN master + DE + 38 machine-translated locales, each marked
"pending native-speaker review" in its `_meta.status`); the header switcher became a
details-dropdown that scales to the full set, and hreflang/sitemap/JSON-LD expand automatically.
(4) The footer gained an **Ecosystem** column linking simplex.chat and matrix.org, with restyled
menu columns. Copy was also expanded ("a bit more text everywhere") and the hero portrait gained
a hover effect; both are locale/CSS-level changes.
**Rationale.** Operator style and product direction. Machine translations are acceptable for the
shop-window stage (same forward-looking doctrine as D-029's copy note); the per-file review
marker keeps the pending-quality state explicit until native review lands.

---

### D-029 — Season 3 website: the operator's template is the design source, ported 1:1 to SSR

**Status: IMPLEMENTED (CCB-S3-001).**
**Decision.** The public site's design source is the operator-authored dark-neon template
(delivered as a self-contained HTML bundle in `tmp/`, not committed); Claude Code ports it
**verbatim** to the existing self-contained SSR machinery — copy into `locales/*.json`
(EN/DE), design tokens + component CSS into [`src/web/site/css.ts`](../src/web/site/css.ts),
lucide icons inlined server-side ([`src/web/site/icons.ts`](../src/web/site/icons.ts)),
webfonts + brand avatar vendored under `assets/site/` and served same-origin, and the
template's React effects re-implemented as small nonce'd vanilla scripts
([`src/web/site/client.ts`](../src/web/site/client.ts)). The site now carries its **own**
token system (ink/cyan/magenta, dark default, `cn-theme` toggle); the shared
`src/web/theme.ts` continues to serve the archive front unchanged. All template pages are
real (Features, Pro, Security, Open Source, Legal); Docs stays a stub. The legal pages are
footer-linked on every page; the Legal Notice carries a **voluntarily appointed Youth
Protection Officer**; Privacy/Terms are rendered drafts, `noindex` and excluded from the
sitemap until the planning chat delivers the final texts. The template's strong
"consent + CSAM screening" copy **stands as authored** (operator decision: the site is a
forward-looking shop window while the software is not yet distributed; the binding point is
first distribution — before any hand-over, CSAM screening must be built or the site comes
down). The D-017/D-023–D-025 building blocks carry over unchanged, still OFF by default.
**Rationale.** The CCB-S2-012 foundation landing was rejected as not good enough (Season 2
close-out Part C); porting the operator's approved design 1:1 — rather than reinterpreting
it — keeps design authority with the operator while preserving the SSR/SEO/i18n/CSP
architecture the foundation established.

---

### D-028 — "Done means deployed": every briefing ends committed, pushed, and live

**Status: IMPLEMENTED (process convention).**
**Decision.** A briefing is not complete until its result is committed to `main`, pushed to
GitHub (`origin/main`), and deployed to the production VPS and verified live. Code changes
deploy with build + migrate + service restart; documentation-only changes deploy by syncing the
VPS git checkout (no build/restart needed). `main`, `origin/main`, and production are kept in
lockstep — there is no gap between "written" and "running."
**Rationale.** The project is a single live product on a shared host; drift between the repo and
production is the most common source of "works on main but not in prod" confusion. Making
deployment part of the definition of done removes that class of error. Formalised at the Season 2
close-out (CCB-S2-016); it had governed every Season 2 briefing already but lacked a number.
Recorded here consistent with the D-001 precedent that process conventions are logged decisions.

---

### D-027 — Retention model: abo-dependent, admin-configurable, default 10 years, auto-delete after expiry

**Status: PLANNED (the deletion mechanism is a Season 3 build).**
**Decision.** Retention of captured/published content is **subscription-dependent** and
**admin-configurable**, defaulting to **10 years**; content is **automatically deleted** once its
retention period expires. The auto-delete mechanism itself is **not yet built** — it is a Season 3
deliverable (§Part D.6 of [`../seasons/SEASON-2-PROTOCOL.md`](../seasons/SEASON-2-PROTOCOL.md)).
Until then nothing auto-expires; existing operator/member deletion (takedown, `/unpublish`,
in-group deletion) is unchanged.
**Rationale.** Data minimisation and GDPR alignment (content should not live forever by default)
balanced against the archive's permanence promise — a long but bounded default (10 years),
overridable per deployment/subscription. Deferring the deletion build to Season 3 keeps the decision
recorded now (so the Privacy Policy and subscription tiers can reference it) without shipping a
half-built eraser. The retention period must also be disclosed in the Privacy Policy (Season 3).

---

### D-026 — Dual-license: AGPL open edition now, a commercial Pro edition later (AGPL caveat)

**Status: PLANNED.**
**Decision.** Cinderella ships as an **open edition under AGPL-3.0** (the current, published
edition). A future **commercial "Pro" edition** will be offered under **separate commercial
terms**. **Caveat (load-bearing):** any Pro edition that still _links_ the AGPL-licensed
`simplex-chat` library remains **AGPL-bound** — a commercial licence for Pro is only possible if
(a) SimpleX grants a commercial library licence for `simplex-chat`, **or** (b) Pro is architected
to **not link** `simplex-chat` (e.g. a separate process / service boundary). This constraint is
decided now so Season 3's multi-tenancy/Pro work (§Part D.7 of the Season 2 protocol) is built with
the licence boundary in mind from the start.
**Rationale.** Open-core: AGPL keeps the community edition open and trustworthy; a paid Pro tier
funds sustainability and customer self-service. The AGPL copyleft reaches anything that links the
covered library, so "commercial terms" for Pro are not free to assert — the caveat records the
only two lawful paths and prevents a Season 3 architecture that quietly violates the SimpleX
licence. No code changes yet; this governs the Pro/multi-tenancy design.

---

### D-025 — Website building blocks (analytics, cookie banner, social share) ship but default OFF; analytics is consent-gated

**Status: IMPLEMENTED.**
**Decision.** The public site's three "building blocks" (CCB-S2-012) are admin-configurable and
**all disabled by default**, persisted as one normalized blob under the `settings` table `site` key
(`src/site/settings.ts`, `SiteService` — cloned from `SecurityService`, so no migration), audited on
every change (`site.update`), edited on the admin **Website** page (`/website`,
`src/web/views/site.ts`). (1) **Visitor analytics** — an operator-supplied HTTPS snippet URL
(first-party preferred); (2) **cookie/consent banner** — self-hosted, inline, nonce'd; (3) **social
share** — pure link builders (X/Facebook/Reddit/WhatsApp/LinkedIn/Email), no third-party script. The
**consent invariant** lives in one predicate, `shouldLoadAnalytics(site)` = analytics enabled **AND**
a script URL **AND** the banner enabled: analytics loads NOTHING until the visitor accepts (the
inline boot injects the `<script src>` only on `cin-consent=granted`), and with the banner off there
is no banner and no tracking at all. The analytics origin is added to the site CSP's
`script-src`/`connect-src` only when consent-gated on. Essential storage — the theme (`sg-theme`) and
the language cookie (`cin-lang`) — needs no consent. The admin page carries the operator-responsibility
note (legal requirements differ by country) and warns if analytics is on with the banner off.
**Rationale.** Max-configurability with a safe default: the operator opts in and owns the legal call,
but the product can never track before consent, and share never phones home. Share/banner being
self-hosted keeps the strict nonce CSP intact. Verified by
[`scripts/verify-site.ts`](../scripts/verify-site.ts) (off-by-default, consent-gate, banner-required,
script-free share, and an escaped-URL breakout test).

---

### D-024 — Website i18n via locale files + per-language URLs; adding a language is a file, not code

**Status: IMPLEMENTED.**
**Decision.** All visible site copy comes from `locales/<code>.json` keyed by string id (CCB-S2-012);
English is primary, German second. The loader (`src/web/site/i18n.ts`, synchronous) scans the
`locales/` directory at startup, so **adding a language is dropping in a file** (with an `_meta`
block) — no code change. URLs are per-language (`/en`, `/de`, `/en/<slug>`), one static route per
loaded locale so nothing greedily shadows the admin paths. `GET /` 302-redirects by the persisted
`cin-lang` cookie → `Accept-Language` → default. A header switcher links the same page across
locales, and every page emits `hreflang` alternates + `x-default` (and an i18n sitemap with
`xhtml:link` alternates). The visitor's choice persists as the functional (essential) `cin-lang`
cookie — no consent needed, like the theme.
**Rationale.** File-driven i18n keeps translation out of the code path and makes new languages a
content task. Per-language URLs + hreflang are the SEO-correct multilingual shape. Verified by
[`scripts/verify-site.ts`](../scripts/verify-site.ts) (negotiation, persistence, switcher, hreflang,
per-locale `og:locale`).

---

### D-023 — A public marketing site owns the domain root; the admin moves to `/dashboard` and stays `noindex`

**Status: IMPLEMENTED.**
**Decision.** The domain root `/` now serves a public, SSR, indexable marketing site (CCB-S2-012) —
the face of the Cinderella bot suite (the archive is one capability under it). It is built in the
**public-front style** (self-contained, inline nonce'd CSS/JS, `html`/`raw` escaping,
`src/web/site/`), NOT the Tailwind admin shell. The shared SimpleGo theme (dark-default light/dark,
`sg-theme` toggle, no-flash boot) was extracted to `src/web/theme.ts` as a single source of truth
consumed by both the archive front and the site (the front's output stayed byte-identical). The admin
dashboard relocated from `/` to `/dashboard` (post-login redirect + nav updated); the operator login
became a discreet header button → the unchanged, hardened, `noindex` admin. The site sets its OWN
headers (indexable + `frame-ancestors 'none'`/`X-Frame-Options: DENY`, unlike the embeddable archive
front) and is exempt from the admin auth/CSRF/IP guards via `isPublicSitePath`. `robots.txt` flipped
from a blanket root `Disallow: /` to `Allow: /` with explicit admin-surface disallows.
**Rationale.** Cinderella is the product identity, not a bot behind a login; the root should sell it
and index. Reusing the front's nonce-CSP shape (not the admin's `unsafe-inline` Tailwind) keeps the
public surface strictly self-contained. Verified by [`scripts/verify-site.ts`](../scripts/verify-site.ts)
(root routing, indexable site vs gated admin) and the unchanged [`scripts/verify-admin.ts`](../scripts/verify-admin.ts) /
[`scripts/verify-public.ts`](../scripts/verify-public.ts).

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
none had drifted; the guard is defense-in-depth against the _classic_ cause (a future
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
> `src/consent/commands.ts:48-59` but is actually _sent_ to the group from the
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

> **Note:** the deprecated "Stage" labels still exist as _historical_ artifacts —
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

> **Note:** this is the _current, implemented_ behaviour and diverges from the
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
