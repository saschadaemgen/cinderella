# Cinderella — SimpleX Wire-Format Findings

> _Living document — Cinderella, Season 1. Ground truth is the code in this repository; where an earlier briefing outline diverged from the code, the divergence is noted inline. Maintained under the CCB briefing scheme; last updated under **CCB-S1-019**._

This document records the SimpleX protocol and SDK behaviours that materially affect Cinderella's implementation. Everything below is verified against the code in this repo; where the working outline and the code disagree, the code wins and the divergence is called out inline and collected at the end.

Sources read: `src/bot/avatar.ts`, `src/bot/client.ts`, `src/consent/commands.ts`, `src/capture/handler.ts`, `src/capture/message.ts`, `src/bot/files.ts`, `src/index.ts`, `migrations/002_consent.sql`, and the SDK source `node_modules/simplex-chat/src/bot.ts` (simplex-chat 6.5.4).

## 1. Profile image is a small square JPEG data URI, budgeted to fit the profile envelope

The bot avatar is not a file reference — it is a base64 `data:` URI carried literally inside the SimpleX profile. SimpleX profile images ride inside the profile message envelope (documented in the code as ~15,610 bytes encoded), so the image must be kept small or the core silently declines to propagate it.

`buildAvatarDataUri` (`src/bot/avatar.ts:41`) downscales the source to a **square JPEG** and drops resolution then quality until the encoded URI fits a byte budget. The relevant constants (`src/bot/avatar.ts:36-38`):

- `MAX_DATA_URI_CHARS = 12000` — the enforced budget, deliberately kept "comfortably under" the ~15,610-byte envelope rather than at it.
- `SIZES = [192, 160, 128]` — pixel dimensions tried largest-first.
- `QUALITIES = [72, 64, 56, 48, 40]` — JPEG quality steps tried within each size.

The MIME type emitted is **`image/jpg`** (not `image/jpeg`), i.e. the literal prefix is `data:image/jpg;base64,` (`src/bot/avatar.ts:50`). Sharp is invoked with `.rotate()` to honour EXIF orientation and `.resize(px, px, { fit: 'cover', position: 'centre' })` for the square crop. JPEG is used deliberately — the file header comment (`src/bot/avatar.ts:19`) notes PNG "renders blurry."

> Note: the outline says "~192px square JPEG." That is the *starting* size only. The code will step down to 160px or 128px, and reduce quality, if 192px does not fit `MAX_DATA_URI_CHARS`. If nothing fits, `buildAvatarDataUri` returns the smallest URI it produced anyway (`src/bot/avatar.ts:56`) and `loadAvatarDataUri` logs a warning that it may not propagate (`src/bot/avatar.ts:73-79`).

> Note: the outline's "~15,610-byte profile message envelope" appears in the code only as an explanatory comment (`src/bot/avatar.ts:17`, `35`). The value actually enforced in code is the 12000-**character** URI budget, not a 15,610-byte check.

## 2. Member-profile updates reach contacts immediately, but groups only on the next group send

This is the single most important SimpleX wire-format fact for the avatar feature, and the code is built entirely around it.

**bot.run reconciles the whole profile, image included.** The boot profile passed to `bot.run` carries the image inline (`src/bot/client.ts:80-107`). The SDK's `updateBotUserProfile` (`node_modules/simplex-chat/src/bot.ts:199-214`) deep-compares (`fast-deep-equal`) the config profile against the stored profile via `util.fromLocalProfile(user.profile)`, and when they differ **and** `updateProfile` is true, calls `apiUpdateProfile(userId, profile)` with the *full* profile — image included. So Cinderella sets the image on first run and self-heals it on any boot where the stored profile differs.

- Critical subtlety encoded in `client.ts`: the boot profile only includes the `image` key when an avatar file was actually loaded (`...(image ? { image } : {})`, `src/bot/client.ts:86`), and `updateProfile` is set to `image !== undefined` (`src/bot/client.ts:103`). This is because a profile object *without* an image would deep-differ from a stored profile *with* one, causing the SDK to wipe the avatar on every avatar-less boot. The header comment (`src/bot/avatar.ts:8-11`) documents that an earlier `updateProfile:false` + separate re-apply approach "fought the SDK" and blanked the avatar every boot.

**`apiUpdateProfile` only notifies direct CONTACTS.** The bot is a consent bot with no open contact address (`createAddress: false`, `src/bot/client.ts:92`) and therefore effectively zero direct contacts. So the profile update alone reaches nobody in the group.

**Groups receive the profile only when the bot next sends a group message.** The SimpleX core piggybacks the member-profile update (an `XInfo` protocol message) onto the next outgoing group message, gating on `userMemberProfileSentAt < userMemberProfileUpdatedAt` — setting the avatar advances the "updated" side (`src/bot/avatar.ts:92-96`). `flushAvatarToGroups` (`src/bot/avatar.ts:103`) forces this: it reads the active user's image, computes a sha256 marker of it, and if that marker has not already been flushed (a `settings` row keyed `avatarGroupFlushMarker`, `src/bot/avatar.ts:85`) it sends **one** minimal group message — the literal `FLUSH_MESSAGE = '🕯️✨'` (`src/bot/avatar.ts:87`) — to every group. After a successful send it records the marker so restarts do not spam the group. This is wired into startup at `src/index.ts:109-116`, after capture is registered.

> Note on terminology: the outline (and `avatar.ts`) describe the gate as `user_member_profile_sent_at < user_member_profile_updated_at`. That is the SimpleX core's own (SQLite) column semantics; the SDK-facing comment spells the same thing in camelCase. Both refer to the core's internal state, not to any column in Cinderella's Postgres schema.

## 3. Consent commands are recognised on GROUP messages only, by exact string match

Consent is the product's legal backbone, and the command surface is deliberately narrow.

**Only group messages are parsed at all.** `parseGroupMessage` (`src/capture/message.ts:116`) returns `null` unless the item is a group chat (`chatInfo.type === 'group'`), in the receive direction (`chatItem.chatDir.type === 'groupRcv'` — a real member's message, never the bot's own sends or system events), and carries real message content (`content.type === 'rcvMsgContent'`). Direct/local chats and group-event items are dropped before any command logic runs.

**Command recognition is exact-match.** `parseConsentCommand` (`src/consent/commands.ts:19-24`) trims and lowercases the text and matches it against exactly `/publish` or `/unpublish`. Anything else (a command with trailing words, an inline mention) returns `null` and is treated as ordinary content.

**A command must be plain text with no attachment.** In the capture handler, `commandFor` only calls `parseConsentCommand` when `msg.type === 'text' && !msg.file` (`src/capture/handler.ts:102-103`). Recognised commands are routed to the `onCommand` hook and are explicitly **not persisted** as archive content (`src/capture/handler.ts:124-139`).

> Divergence worth recording: Cinderella does **not** use the SDK's built-in command mechanism. The SDK offers `onCommands` + `util.ciBotCommand` (`node_modules/simplex-chat/src/bot.ts:41`, `123-140`) for keyword dispatch, but Cinderella ignores it and does its own parsing inside the capture handler. (Confirmed: a grep of `src/` for `onCommands`/`ciBotCommand` returns no usages.) This is consistent — Cinderella subscribes to the raw `newChatItems` event itself — but means the SDK's command-parsing rules do not apply here; the exact-match rule above is Cinderella's own.

## 4. There is no private per-member channel — consent is group-only, and confirmations are public

The outline references "the member-support scope as the only private per-member channel." **That channel is not implemented in the current code.** This is a Season 2 concept, not present in the codebase.

Evidence:

- `parseGroupMessage` discards every non-group item (`src/capture/message.ts:119-123`), so no direct/DM message ever reaches consent handling.
- A grep of `src/` finds no member-support scope, no `directRcv` handling, and no direct-contact message path (the only `src/` hit for any of these terms is `createAddress: false`). The only `contactConnected`/`contactDeletedByContact` handlers are the SDK's own log lines (`node_modules/simplex-chat/src/bot.ts:143-148`); the bot deliberately creates no contact address (`createAddress: false`, `src/bot/client.ts:92`).
- The confirmation reply is sent with `apiSendTextReply(msg.raw, text)` (`src/consent/commands.ts:63`), where `msg.raw` is the original **group** chat item. So the `/publish` / `/unpublish` acknowledgements (`PUBLISH_REPLY`, `UNPUBLISH_REPLY`, `FAILURE_REPLY`; `src/consent/commands.ts:26`, `32`, `38`) are posted **into the group, visibly to everyone** — they are not private DMs.

> Divergence, explicit: outline says a private per-member support channel is the mechanism; the code has **no private per-member channel at all**. Consent is entirely group-scoped, and even the consent confirmations are public group replies. Treat "member-support / private DM" as *planned / not yet implemented*.

## 5. SimpleX has no persistent user identity — consent is bound to a stable-but-not-durable member id

SimpleX does not give a member a durable, cross-session identity. A member who leaves and rejoins a group is issued a **new** group member id. Cinderella's schema is designed around exactly this.

`migrations/002_consent.sql:1-13` binds consent to the **stable group member id** (`consent.member_id TEXT PRIMARY KEY`, line 7), never the display name (which can collide across members and is mutable). The migration's own comment states the consequence directly: "A member who leaves and rejoins gets a new member id, so consent does not carry over — that is intended (fresh consent on rejoin)." (`migrations/002_consent.sql:3-4`)

Consequences that follow from this, all visible in code:

- **No durable bans / no durable identity.** Because the id is regenerated on rejoin, there is no stable handle to ban or to carry consent across a leave/rejoin. Consent is intentionally re-requested.
- **The id is used everywhere consent matters.** Capture records `senderMemberId` from `member.memberId` (`src/capture/message.ts:137`, and the field is documented "Stable group member id (NOT the display name)" at `message.ts:46`). The consent handler records opt-in/opt-out against `msg.senderMemberId` (`src/consent/commands.ts:83`, `87`), and the publish-state view joins `messages.sender_member_id` to `consent.member_id` (`migrations/002_consent.sql:35`).
- **Publication is derived, forward-only.** The `message_publish_state` view (`migrations/002_consent.sql:21-35`) computes `published` live from: not deleted, a consent row exists, `revoked_at IS NULL`, and `sent_at >= opted_in_at`. Opt-in timestamps use the group-message clock domain (`opted_in_at` is the `/publish` message's timestamp, per the column comment at `migrations/002_consent.sql:8-10`), so "from the moment you say yes, forward only" is enforced at the id+timestamp level, not by a stored flag.

## Appendix: related file-transfer wire behaviour (context)

Not in the outline, but relevant to the same "what SimpleX actually puts on the wire" theme and verified in `src/bot/files.ts`: SimpleX media is **preview-only until downloaded**. An incoming image/video/file carries only metadata plus a base64 thumbnail inline; the real bytes move over XFTP and must be *received* per file (`files.ts:1-15`, `receive` at `files.ts:68`). Receipts are issued with `storeEncrypted: false` so the file lands readable for the media store, and `userApprovedRelays: true` (`files.ts:98`). XFTP relays expire files after ~48h, so late/failed receipts are surfaced rather than retried forever (`files.ts:8`). `rcvFileWarning` is treated as transient (the transfer continues), while `rcvFileError` is terminal (`files.ts:154-172`, and the subscription wiring at `src/bot/client.ts:116-120`).

## Summary of divergences from the outline

1. **Private per-member channel does not exist.** The outline's "member-support scope as the only private per-member channel" is not implemented. Consent is group-only; there is no direct/DM path (`src/capture/message.ts:119-123`), and consent confirmations are posted publicly into the group as group replies (`src/consent/commands.ts:63`). Planned / not yet implemented.
2. **Avatar size is a range, not a fixed 192px.** The outline's "~192px square JPEG" is the starting size; the code steps down through 160px/128px and five quality levels to fit budget (`SIZES`/`QUALITIES`, `src/bot/avatar.ts:37-38`).
3. **The enforced budget is 12000 URI characters, not the ~15,610-byte envelope.** The 15,610 figure is only an explanatory comment (`src/bot/avatar.ts:17`, `35`); the actual check is `MAX_DATA_URI_CHARS = 12000` (`src/bot/avatar.ts:36`, `52`, `73`).
4. **MIME type is `image/jpg`, not `image/jpeg`.** Literal prefix `data:image/jpg;base64,` (`src/bot/avatar.ts:50`).
5. **Consent commands do not use the SDK's command dispatch.** The outline implies command handling; the code ignores the SDK's `onCommands`/`ciBotCommand` path and parses `/publish`/`/unpublish` itself in the capture handler with an exact string match plus a no-attachment guard (`src/capture/handler.ts:102-103`, `src/consent/commands.ts:19-24`).
