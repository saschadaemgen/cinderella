# Cinderella — Season Index

The unit of work is the **Season**, numbered from **1** (the first completed block
is Season 1; the next is Season 2). Each season is authorised by numbered briefings
(`CCB-S<season>-<NNN>`) and closes with a protocol document under `seasons/`. The
earlier zero-based scheme and the "Stages 0–7" framing are deprecated — see
[`../docs/decisions.md`](../docs/decisions.md) **D-014**.

> **Numbering note.** Briefing ids issued before the alignment (up to `CCB-S0-018`)
> keep their historical `CCB-S0-<NNN>` prefix and remain authoritative; from
> `CCB-S1-019` onward the id carries the aligned season number. See
> [`CCB-REGISTER.md`](CCB-REGISTER.md).

| Season | Title | Status | Close-out |
|--------|-------|--------|-----------|
| 1 | Foundation — consent-based SimpleX→web archive | Content-complete, in production | [SEASON-1-PROTOCOL.md](SEASON-1-PROTOCOL.md) |
| 2 | Public display, command & moderation, AI brain, multi-tenancy | Next | — |

## Season 1 — Foundation

**Delivered and live** at `cinderella.simplego.dev`, bot active in the "Cyb3rD3sk"
group: capture pipeline (text/image/video/voice/link/file → PostgreSQL + on-disk
media), consent gating (`/publish` / `/unpublish`, forward-only, deletion-aware),
the responsive admin console (dashboard, Messages + takedown, Consent, Settings,
Embed management), an appless public passkey-secured console over Let's Encrypt TLS
with the full hardening suite, PostgreSQL-backed sessions, reliable XFTP media, and
the SDK-native avatar. See [SEASON-1-PROTOCOL.md](SEASON-1-PROTOCOL.md) and the
living documents under [`../docs/`](../docs/).

**Season 2 (planned):** public embed front (`/embed/<instance-id>`), command &
moderation system, local AI brain (RTX 3090 over a tunnel), and multi-tenancy for
customer self-service.
