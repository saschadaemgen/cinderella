# CCB-S2-016 — Season 2 Close-Out: Protocol & Handover to Season 3

- **Briefing:** CCB-S2-016
- **Type:** Season close-out (protocol + handover + directive)
- **Project:** Cinderella
- **From:** Planning/Architecture
- **To:** Claude Code

> This document is the committed record of briefing CCB-S2-016. The five living
> documents it references (`architecture`, `security`, `wire-format`,
> `feature-backlog`, `decisions`) live under [`docs/`](../docs/). Season numbering is
> aligned to one (Season 1 = the foundation block, Season 2 = this one); the earlier
> zero-based scheme is retired — see [`../docs/decisions.md`](../docs/decisions.md)
> **D-014**.

---

## Part A — Directive to Claude Code

1. **Commit the Season 2 close-out.** This document lives at
   `seasons/SEASON-2-PROTOCOL.md`, with a Season 2 entry in
   [`SEASON-INDEX.md`](SEASON-INDEX.md). Conventional Commit, `Briefing: CCB-S2-016`,
   pre-push grep first.
2. **Final documentation currency check.** Confirm the five living documents reflect
   the full Season 2 state (CCB-S2-001 … 016); update any that lag and report which
   were already current. (Result recorded in Part E.)
3. **Two decisions numbered.** The dual-license direction (**D-026**) and the
   retention model (**D-027**) are recorded in `decisions.md`; the standing
   "done means deployed" rule is formalised as **D-028** (previously cited but
   unnumbered, consistent with the D-001 process-convention precedent).
4. **"Done means deployed."** This close-out is committed, pushed to GitHub, and
   deployed to the production VPS; `main` and production are in lockstep.
5. Conventional Commit with `Briefing: CCB-S2-016`; pre-push grep.

## Part B — Season 2 Protocol (what shipped, all live)

Season 2 turned the private, capture-only foundation into a **public, discoverable,
safe-by-design product with its own marketing surface**. All of the following is live
in production at `cinderella.simplego.dev`.

- **Public presentation** — README + banner + AGPL-3.0 licence in the house style
  (centered header + badge tiles); an honest alpha-status notice; CSAM wording kept
  honest ("in development, evaluating providers, not in production"). (CCB-S2-001/002,
  013/014)
- **Public archive front** — the `/embed/<id>` route: server-side rendered,
  consent-gated, with a separate consent-gated public media path (unpublished media
  404s). (CCB-S2-003)
- **Full SEO & marketing suite** — schema.org JSON-LD (configurable types), sitemap +
  index, robots, per-instance meta/title templates, OG/Twitter + an auto social image,
  RSS feed, and an analytics hook. All admin-configurable; the consent gate holds
  across every output. (CCB-S2-004)
- **Stream experience** — house-palette light/dark with a visitor toggle (CCB-S2-005);
  live auto-update so recalled items vanish without a refresh (CCB-S2-006);
  cursor-based infinite scroll with DOM windowing and crawlable deep pages
  (CCB-S2-007); inline video with controls, fullscreen, byte-range serving, and an
  admin-toggleable download button (default on) (CCB-S2-008); loading polish — no
  scrollbar flash, a house skeleton, and smooth appends (CCB-S2-010).
- **Content reporting & moderation** — a public report button (reasons + note,
  rate-limited, visible-until-review); an admin notification bar + report queue
  (view / takedown / delete / resolve / dismiss, all audit-logged); and an inert
  "coming later" placeholder for e-mail / SMS / SimpleX alerts. (CCB-S2-009)
- **Auth hardening** — a passkey-login diagnosis (no server regression; the failure
  was client-side) plus an RP-ID/origin startup guard that refuses to boot on a
  mismatch. (CCB-S2-011)
- **Marketing website foundation** — a root-domain site scaffold; i18n (EN/DE via
  locale files + per-language URLs + hreflang + a switcher); a landing page; a
  discreet operator login; and analytics / social-share / cookie-banner as
  configurable, off-by-default building blocks with a per-country
  operator-responsibility note. (CCB-S2-012)

**Key decisions** (see [`../docs/decisions.md`](../docs/decisions.md)): **D-015**
public-front doctrine (maximum functionality, everything admin-configurable);
**D-016** consent-gating absolute on the public front; **D-017** analytics
off-by-default with a per-instance CSP; **D-018** SSE deferred (polling first);
**D-019** inline video; **D-020** infinite scroll; **D-021** content reporting;
**D-022** RP-config guard; **D-023–025** website (SSR/indexable; off-by-default
trackers; share-links, not scripts); plus **D-026** dual-license direction, **D-027**
retention model, and **D-028** the "done means deployed" rule.

**Numbering:** aligned to Season 1 = the first block, Season 2 = this one (the
zero-based scheme is retired — **D-014**).

## Part C — Open items carried into Season 3

- **Operator-owned:** register a second passkey (a YubiKey 5-series is ordered), then
  disable the break-glass path and rotate the leaked break-glass password.
- **Website:** the foundation landing is **rejected as not good enough**. Season 3
  delivers a full redesign (cyber-black / neon-blue, per the Claude Design brief and
  the HTML prototype) plus the remaining pages (Features, Pro, Security, Open Source,
  Legal), with the legal pages footer-linked on every page.
- **Legal texts** (take the time; be thorough): a German *Impressum* (legally binding;
  the English version is done), a Privacy Policy (*Datenschutzerklärung* — GDPR, IONOS
  as processor, disclosure of automated CSAM screening of received media, the
  retention mechanism), and Terms of Service (covering the commercial Pro service).
  All require legal review before commercial launch.
- **Professional-tone pass** over the README intro, website copy, and legal copy (a
  few playful remnants remain).
- **Group-name decision** (candidates: *Cinderella HQ* / *Cinderella Community* /
  *Cinderella AI Suite*).

## Part D — Season 3 plan (the horizon)

1. **The real website** — redesign from the approved direction; build all pages; wire
   the legal pages into the footer everywhere; fill EN/DE content; professional tone.
2. **Legal & compliance** — the three legal texts above, plus a DSA point-of-contact
   and a defined preserve-and-report process for illegal content; lawyer review.
3. **Child-safety / CSAM screening** — architecture agreed: scan every received image
   at receipt (Cinderella decrypts to archive, so screening runs on the decrypted file
   on our own server) **regardless of consent**; publish only with consent; with
   Cloudflare as the served-content backstop. **Preserve-and-report, not just delete.**
   Build this so the README claim becomes true.
4. **AI brain + categorization + video gallery** — the local RTX 3090 model over a
   secure tunnel, decoupled behind one "AI endpoint" address (rented inference addable
   later, no rebuild); a queue-based categorization engine (text / images / video via
   transcript + sampled frames + poster, economical); per-community categories; and a
   YouTube-style video gallery.
5. **Command & moderation system** — private per-member onboarding and moderation via
   SimpleX's member-support scope (knock → private greeting → `/publish` → accept);
   role-gated moderation; admission hardening.
6. **Retention auto-delete** — abo-dependent, admin-configurable, default 10 years;
   automatic deletion after expiry (**D-027**).
7. **Multi-tenancy & Pro** — tenant isolation (a tenant key from the start); a role
   model (operator over all; customers scoped to their tenant); subscription /
   self-service; per-customer login (**D-026**).

## Part E — Status

Season 2 is **content-complete and live in production**: the public archive, the full
SEO suite, the whole stream experience, content reporting, and the website foundation.

**Documentation currency (Part A.2).** All five living documents reflect the full
Season 2 state. `decisions.md` was brought current with the three new entries
(D-026 / D-027 / D-028) and its banner; `feature-backlog.md` gained the Season 3
retention + dual-license/Pro planned items. `architecture.md`, `security.md` and
`wire-format.md` were already current (last substantive update CCB-S2-012; nothing in
CCB-S2-013 … 016 changed their subject matter).

Season 3 is about **the real website, the legal/compliance backbone, child-safety
screening, and the AI capabilities** (categorization, gallery, local brain) — the
parts that make Cinderella a suite, safely and lawfully.
