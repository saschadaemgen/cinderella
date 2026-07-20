# Cinderella — Claude Code Briefing Register (Season 1)

*Supersedes the earlier "Season 0" register. Internal and public season numbering
are now aligned: the first completed block is **Season 1**; the next is **Season 2**.
The previous zero-based scheme is retired (see [`../docs/decisions.md`](../docs/decisions.md)
**D-014**, superseding D-011).*

## Numbering convention

- Every Claude Code Briefing carries a unique identifier: **`CCB-S<season>-<NNN>`** —
  season-bound, zero-padded, sequential (e.g. `CCB-S1-001`).
- The identifier appears in the briefing header and in the Conventional Commit
  message of the resulting work, so every change is traceable end to end:
  commit → briefing → decision.
- **Seasons are numbered from one, internal and public aligned.** The first
  completed block is Season 1. The "Stages 0–7" framing from early implementation
  reports remains deprecated; the unit is the Season.
- **Documentation checkpoint (standing rule, [`../CLAUDE.md`](../CLAUDE.md)):** every
  briefing includes a mandatory documentation step — on completing the work, Claude
  Code updates whichever of the five living docs the change affects, grounded in the
  actual code, or states "no documentation change" in the report. Never skipped
  silently.
- Briefings are written in a professional, publication-ready style.

> **The `ID` column is authoritative.** Briefings delivered before the alignment
> were committed with their pre-alignment `CCB-S0-<NNN>` ids; those ids survive in
> git history and are **not** rewritten. The canonical id is the `CCB-S1-<NNN>`
> value here. Old planning-chat source filenames also keep their original names.

## Register — Season 1

| ID | Title | Type | Status | Source file |
|----|-------|------|--------|-------------|
| CCB-S1-001 | Foundation: repo scaffold, capture pipeline, persistence, consent gating | Briefing | Delivered | CINDERELLA-S0-CC-BRIEFING.md |
| CCB-S1-002 | Admin/config console; in-process SDK topology correction; embed data model; responsive-by-default | Addendum | Delivered | CINDERELLA-S0-ADDENDUM-1.md |
| CCB-S1-003 | VPS live deployment: systemd hardening, non-root service, secrets handling | Addendum | Delivered | CINDERELLA-S0-ADDENDUM-2.md |
| CCB-S1-004 | WireGuard-only admin access | Addendum | Superseded by CCB-S1-005 | CINDERELLA-S0-ADDENDUM-3.md |
| CCB-S1-005 | Appless public console: Let's Encrypt HTTP-01, native WebAuthn passkeys, full hardening controls | Addendum | Delivered | CINDERELLA-S0-ADDENDUM-4.md |
| CCB-S1-006 | Login-failure hotfix: session persistence and reverse-proxy headers | Hotfix | Delivered | CINDERELLA-HOTFIX-login.md |
| CCB-S1-007 | Group onboarding, avatar application, live capture acceptance | Briefing | Delivered | CINDERELLA-CONNECT-BRIEFING.md |
| CCB-S1-008 | Avatar-not-applied and premature-logout hotfix: PostgreSQL-backed sessions | Hotfix | Delivered | CINDERELLA-HOTFIX-avatar-session.md |
| CCB-S1-009 | XFTP media-download hotfix (initial) | Hotfix | Superseded by CCB-S1-010 | CINDERELLA-HOTFIX-xftp-media.md |
| CCB-S1-010 | XFTP media "missing" hotfix — root cause: EXDEV cross-device rename | Hotfix | Delivered | CINDERELLA-HOTFIX-xftp-media-v2.md |
| CCB-S1-011 | Avatar re-apply-on-startup hotfix | Hotfix | Delivered | CINDERELLA-HOTFIX-avatar-persist.md |
| CCB-S1-012 | Avatar-propagation diagnosis | Diagnosis | Delivered | CINDERELLA-DIAG-avatar-propagation.md |
| CCB-S1-013 | Avatar for all members via desktop set + on-wire capture | Briefing | Superseded by CCB-S1-014/015 | CINDERELLA-BRIEFING-avatar-allmembers.md |
| CCB-S1-014 | Avatar fix: group-message flush (SimpleX core-source finding) | Fix | Delivered | CINDERELLA-AVATAR-FIX-group-message.md |
| CCB-S1-015 | Avatar fix: SDK-native — image carried in the `bot.run` profile | Fix | Delivered | CINDERELLA-AVATAR-FIX-sdk-native.md |
| CCB-S1-016 | Admin Messages actions and state-model hotfix | Hotfix | Delivered | CINDERELLA-HOTFIX-messages-actions.md |
| CCB-S1-017 | Season close-out: protocol & handover | Briefing | Delivered | CCB-S0-017-season-0-closeout.md |
| CCB-S1-018 | Read-only VPS deploy key (replace git-bundle deploys) | Briefing | Issued — awaiting operator's GitHub deploy-key step | CCB-S0-018-vps-deploy-key.md |
| CCB-S1-019 | Numbering alignment, doc relabel, and standing documentation-maintenance rule | Briefing | Delivered | CCB-S1-019-renumber-docrule.md |

## Planning documents (not Claude Code Briefings — they inform Season 2)

- **Command & Moderation Concept** — CINDERELLA-CONCEPT-commands-moderation.md
- Supporting research (SimpleX bot capabilities, avatar propagation, secure
  remote-access options) — reference material, not briefings.

## Notes

- **Numbering change:** the season label was realigned from the retired zero-based
  scheme to Season 1 (this block) / Season 2 (next). Old delivered filenames retain
  their original descriptive names; the authoritative id is the `CCB-S1-NNN` column
  above. Commit messages for pre-alignment work carry the original `CCB-S0-<NNN>`
  ids in git history (historical artifacts, not rewritten).
- **Supersessions:** CCB-S1-004 (WireGuard) → CCB-S1-005 (appless public console);
  CCB-S1-009 (XFTP v1) → CCB-S1-010 (EXDEV root cause); CCB-S1-013 (desktop-set
  avatar) → CCB-S1-014 / CCB-S1-015 (core-source finding, then SDK-native).
- From here, ids are allocated at the moment a briefing is issued.
