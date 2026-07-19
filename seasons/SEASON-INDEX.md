# Cinderella — Season Index

The unit of work is the **Season**, numbered from **0**. Each season is authorised
by numbered briefings (`CCB-S<season>-<NNN>`) and closes with a protocol document
under `seasons/`. The earlier "Stages 0–7" framing is deprecated.

| Season | Title | Status | Close-out |
|--------|-------|--------|-----------|
| 0 | Foundation — consent-based SimpleX→web archive | Content-complete, in production | [SEASON-0-PROTOCOL.md](SEASON-0-PROTOCOL.md) |

## Season 0 — Foundation

**Delivered and live** at `cinderella.simplego.dev`, bot active in the "Cyb3rD3sk"
group: capture pipeline (text/image/video/voice/link/file → PostgreSQL + on-disk
media), consent gating (`/publish` / `/unpublish`, forward-only, deletion-aware),
the responsive admin console (dashboard, Messages + takedown, Consent, Settings,
Embed management), an appless public passkey-secured console over Let's Encrypt TLS
with the full hardening suite, PostgreSQL-backed sessions, reliable XFTP media, and
the SDK-native avatar. See [SEASON-0-PROTOCOL.md](SEASON-0-PROTOCOL.md) and the
living documents under [`../docs/`](../docs/).

**Season 1 (planned):** public embed front (`/embed/<instance-id>`), command &
moderation system, local AI brain (RTX 3090 over a tunnel), and multi-tenancy for
customer self-service.
