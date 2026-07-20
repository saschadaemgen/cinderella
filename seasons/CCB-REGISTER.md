# Cinderella — Claude Code Briefing Register (Season 1)

Every Claude Code Briefing carries a unique id **`CCB-S<season>-<NNN>`** —
sequential, zero-padded. The id appears in the briefing, and in the Conventional
Commit message of the resulting work, so each change is traceable end to end:
commit → briefing → decision.

> **Numbering note.** The completed first block is **Season 1** (see
> [`../docs/decisions.md`](../docs/decisions.md) **D-014**; the earlier zero-based
> scheme is retired). Briefing ids issued **before** the alignment keep their
> historical `CCB-S0-<NNN>` prefix and are **authoritative** — they are not
> rewritten (the ids are embedded in commit messages). From `CCB-S1-019` onward the
> id carries the aligned season number. **The id column below is authoritative.**

## Register

| ID | Title | Type | Status |
|----|-------|------|--------|
| CCB-S0-001 | Foundation: repo scaffold, capture pipeline, persistence, consent gating | Briefing | Delivered |
| CCB-S0-002 | Admin/config console; in-process SDK topology correction; embed data model; responsive-by-default | Addendum | Delivered |
| CCB-S0-003 | VPS live deployment: systemd hardening, non-root service, secrets handling | Addendum | Delivered |
| CCB-S0-004 | WireGuard-only admin access | Addendum | Superseded by CCB-S0-005 |
| CCB-S0-005 | Appless public console: Let's Encrypt HTTP-01, native WebAuthn passkeys, full hardening controls | Addendum | Delivered |
| CCB-S0-006 | Login-failure hotfix: session persistence and reverse-proxy headers | Hotfix | Delivered |
| CCB-S0-007 | Group onboarding, avatar application, live capture acceptance | Briefing | Delivered |
| CCB-S0-008 | Avatar-not-applied and premature-logout hotfix: PostgreSQL-backed sessions | Hotfix | Delivered |
| CCB-S0-009 | XFTP media-download hotfix (initial) | Hotfix | Superseded by CCB-S0-010 |
| CCB-S0-010 | XFTP media "missing" hotfix — root cause: EXDEV cross-device rename between `/tmp` and the data volume | Hotfix | Delivered |
| CCB-S0-011 | Avatar re-apply-on-startup hotfix | Hotfix | Delivered |
| CCB-S0-012 | Avatar-propagation diagnosis | Diagnosis | Delivered |
| CCB-S0-013 | Avatar for all members via desktop set + on-wire capture | Briefing | Superseded by CCB-S0-014/015 |
| CCB-S0-014 | Avatar fix: group-message flush (SimpleX core-source finding) | Fix | Delivered |
| CCB-S0-015 | Avatar fix: SDK-native — image carried in the `bot.run` profile | Fix | Delivered |
| CCB-S0-016 | Admin Messages actions and state-model hotfix | Hotfix | Delivered |
| CCB-S0-017 | Season close-out: protocol + the five living documents | Briefing | Delivered |
| CCB-S0-018 | Read-only deploy key for the VPS (replace git-bundle deploys) | Infrastructure | In progress (awaiting operator GitHub step) |
| CCB-S1-019 | Numbering alignment, doc relabel, standing documentation-maintenance rule | Housekeeping | Delivered |

## Notes

- **Supersessions:** CCB-S0-004 (WireGuard) → CCB-S0-005 (appless public console);
  CCB-S0-009 (XFTP v1) → CCB-S0-010 (EXDEV root cause); CCB-S0-013 (desktop-set
  avatar) → CCB-S0-014 / CCB-S0-015 (core-source finding, then SDK-native).
- Planning documents (Command & Moderation Concept, supporting research) inform
  Season 2 and are not Claude Code Briefings.
- From here, ids are allocated at the moment a briefing is issued.
