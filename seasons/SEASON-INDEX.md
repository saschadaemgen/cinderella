# Cinderella — Season Index

The unit of work is the **Season**, numbered from **1**. Seasons 1 and 2 are complete
and in production; Season 3 is next. Each season is authorised by numbered briefings
(`CCB-S<season>-<NNN>`) and closes with a protocol document under `seasons/`. The
earlier zero-based scheme and the "Stages 0–7" framing are deprecated — see
[`../docs/decisions.md`](../docs/decisions.md) **D-014**.

> **Numbering note.** All briefing ids are renumbered to `CCB-S1-<NNN>` (canonical
> and authoritative — see [`CCB-REGISTER.md`](CCB-REGISTER.md)). Commit messages for
> pre-alignment work retain their original `CCB-S0-<NNN>` ids in git history
> (historical artifacts, not rewritten).

| Season | Title | Status | Close-out |
|--------|-------|--------|-----------|
| 1 | Foundation — consent-based SimpleX→web archive | Content-complete, in production | [SEASON-1-PROTOCOL.md](SEASON-1-PROTOCOL.md) |
| 2 | Public product — archive front, SEO, stream experience, reporting, website foundation | Content-complete, in production | [SEASON-2-PROTOCOL.md](SEASON-2-PROTOCOL.md) |
| 3 | The real website, legal & compliance, CSAM screening, AI brain & categorization | Next | — |

## Season 1 — Foundation

**Delivered and live** at `cinderella.simplego.dev`, bot active in the "Cyb3rD3sk"
group: capture pipeline (text/image/video/voice/link/file → PostgreSQL + on-disk
media), consent gating (`/publish` / `/unpublish`, forward-only, deletion-aware),
the responsive admin console (dashboard, Messages + takedown, Consent, Settings,
Embed management), an appless public passkey-secured console over Let's Encrypt TLS
with the full hardening suite, PostgreSQL-backed sessions, reliable XFTP media, and
the SDK-native avatar. See [SEASON-1-PROTOCOL.md](SEASON-1-PROTOCOL.md) and the
living documents under [`../docs/`](../docs/).

**Season 2 (planned, from the Season 1 vantage point):** public embed front
(`/embed/<instance-id>`), command & moderation system, local AI brain (RTX 3090 over
a tunnel), and multi-tenancy for customer self-service. _(Season 2 as actually
delivered is recorded below; command/moderation, the AI brain and multi-tenancy moved
to Season 3.)_

## Season 2 — Public product

**Delivered and live** at `cinderella.simplego.dev`: the consent-gated public archive
front (`/embed/<id>`, SSR, with a separate consent-gated media path); the full SEO &
marketing suite (schema.org JSON-LD, sitemaps, robots, OG/Twitter + auto social image,
RSS, analytics hook — all admin-configurable); the stream experience (house-palette
light/dark toggle, live auto-update, cursor-based infinite scroll with DOM windowing,
inline video, loading polish); content reporting & moderation (public report button +
audit-logged admin review queue); auth hardening (RP-ID/origin startup guard); and the
marketing website foundation at the domain root (i18n EN/DE, landing page, discreet
operator login, off-by-default analytics/share/cookie-banner building blocks). See
[SEASON-2-PROTOCOL.md](SEASON-2-PROTOCOL.md) and the living documents under
[`../docs/`](../docs/).

**Season 3 (planned):** the real website (redesign + all pages + footer-linked legal);
the legal & compliance backbone (Impressum, Privacy Policy, Terms, DSA contact,
preserve-and-report); child-safety CSAM screening at receipt; the AI brain +
categorization engine + video gallery; the command & moderation system; retention
auto-delete (D-027); and multi-tenancy & Pro (D-026).
