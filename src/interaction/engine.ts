/**
 * The dialogue engine (CCB-S3-002 §4) — where an understood instruction becomes
 * an action, or, far more often, becomes a question.
 *
 * The division of labour is strict and deliberate:
 *
 *   addressing.ts  decides whether she was spoken to
 *   resolver.ts    decides what was probably meant   (never executes anything)
 *   engine.ts      decides what to do about it       (this file)
 *   consent/apply  performs the consent change       (the existing, tested path)
 *
 * The engine holds no consent SQL of its own. Every opt-in and opt-out it causes
 * goes through the same `applyConsentChange` the `/publish` command uses, so the
 * natural-language path cannot drift away from the slash path, and the consent
 * rules are enforced in exactly one place.
 *
 * Two safety properties are worth reading twice:
 *
 *  - **A consent change never happens on one message.** PUBLISH and UNPUBLISH
 *    always propose and wait for an affirmative answer inside the follow-up
 *    window (§4.1). Slash commands are untouched by this and stay immediate.
 *  - **Consent is first-person, always.** If the instruction names or points at
 *    somebody else she refuses and does nothing (§4.2) — the requester being an
 *    admin makes no difference, because there is no admin concept in this path
 *    at all: the member id acted on is always the sender's own.
 */

import { log } from '../log.js';
import { status } from '../web/status.js';
import type { Queryable } from '../db/pool.js';
import { countPublishedMatching } from '../db/public-archive.js';
import { memberArchiveCounts } from '../db/member-stats.js';
import { undoLastConsentAction } from '../db/consent-actions.js';
import { applyConsentChange } from '../consent/apply.js';
import type { CapturedMessage } from '../capture/message.js';
import { detectAddress } from './addressing.js';
import { resolveIntent } from './resolver.js';
import { ConversationState, type PendingConfirmation } from './state.js';
import {
  DEFAULT_INTERACTION,
  fillPersona,
  type InteractionSettings,
  type PersonaKey,
} from './settings.js';
import { fuzzyEquals, guessLanguage, normTokens } from './text.js';
import { formatOutbound, type OutboundReply } from './reply.js';

export interface InteractionDeps {
  db: Queryable;
  /** Live settings — read per message, never cached across edits. */
  settings: () => InteractionSettings;
  /**
   * Sends a reply in the chat the message came from. `opts.quote` decides
   * whether it appears as a quoting reply (CCB-S3-003).
   */
  send: (msg: CapturedMessage, text: string, opts: { quote: boolean }) => Promise<void>;
  /** Injectable clock (harness). */
  now?: () => number;
  /** Injectable randomness for retort rotation (harness). */
  random?: () => number;
}

interface ReplyOptions {
  /**
   * Whether this reply opens/refreshes the follow-up window (§2). True for
   * everything except nickname retorts, which must never start a conversation.
   */
  openWindow?: boolean;
  /**
   * Whether this reply may be dropped by the rate limiter. Consent OUTCOMES are
   * exempt: silently changing what is published and not saying so would be the
   * one failure mode this product cannot have. The handshake makes them rare
   * (two messages per change), so exempting them cannot be used to flood.
   */
  bypassLimit?: boolean;
  /**
   * Never quote, whatever `replyMode` says (CCB-S3-003 §1). Set on the consent
   * confirmation prompts: they may carry a name prefix so the member knows the
   * prompt is theirs, but must not repeat their message back at the group.
   */
  neverQuote?: boolean;
}

/**
 * Minimum confidence to act on a message that did NOT name her — one heard only
 * because the follow-up window was open. Set above the single-keyword score so
 * that only a real, multi-word instruction carries inside the window.
 */
const IMPLICIT_MIN_CONFIDENCE = 0.8;

export class InteractionEngine {
  private readonly state = new ConversationState();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly deps: InteractionDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.random = deps.random ?? Math.random;
  }

  /**
   * Handles one captured group message.
   *
   * Returns true when the message was a CONTROL message — something said to
   * Cinderella rather than to the group — in which case the caller must not
   * archive it. Returns false when the message is ordinary group content, which
   * includes anything she decided to stay silent about.
   */
  async handle(msg: CapturedMessage): Promise<boolean> {
    const s = this.deps.settings();
    if (!s.naturalAddressing) return false;
    // Media and files are content, never instructions — a caption that happens
    // to say "publish me" is not a consent decision.
    if (msg.type !== 'text' || msg.file) return false;
    // Command-shaped messages belong to the slash path, and only to it. Without
    // this, a member inside the follow-up window could still trigger `/publish`
    // through the conversational route after the operator had switched slash
    // commands OFF — a toggle that silently only half-applies is worse than no
    // toggle. Addressing her by name (`Cinderella /publish`) is unaffected: such
    // a message does not start with the slash.
    if (msg.text.trimStart().startsWith('/')) return false;

    const now = this.now();
    this.state.prune(now);

    const address = detectAddress(msg.text, s);

    // Nicknames (§6): a retort, and nothing else. Never resolved, never acted
    // on, never opens the follow-up window.
    if (address.kind === 'nickname') {
      return this.handleNickname(msg, s, now);
    }

    let instruction: string;
    let explicit: boolean;

    if (address.kind === 'wake') {
      this.state.resetNicknameStreak(msg.groupId, msg.senderMemberId);
      instruction = address.instruction;
      explicit = true;
    } else if (msg.quotedFromBot) {
      // A direct reply to one of her messages needs no wake word (§1.2).
      instruction = msg.text;
      explicit = true;
    } else if (this.state.inFollowUp(msg.groupId, msg.senderMemberId, now)) {
      // Mid-conversation (§2).
      instruction = msg.text;
      explicit = false;
    } else {
      return false;
    }

    return this.dispatch(msg, s, instruction, explicit, now);
  }

  /**
   * Was this message addressed to her by name or nickname? Side-effect free, so
   * it is safe to ask about a message EDIT (which must not re-run the dialogue
   * but must not be archived either).
   */
  isExplicitAddress(msg: CapturedMessage): boolean {
    const s = this.deps.settings();
    if (!s.naturalAddressing) return false;
    if (msg.type !== 'text' || msg.file) return false;
    return detectAddress(msg.text, s).kind !== 'none';
  }

  /* ── Dispatch ──────────────────────────────────────────────────────────── */

  private async dispatch(
    msg: CapturedMessage,
    s: InteractionSettings,
    instruction: string,
    explicit: boolean,
    now: number,
  ): Promise<boolean> {
    const pending = this.state.getPending(msg.groupId, msg.senderMemberId, now);

    // An outstanding offer is answered before anything else is considered.
    if (pending) {
      if (this.matchesList(instruction, s.affirmations)) {
        return this.performConsentChange(msg, s, pending);
      }
      if (this.matchesList(instruction, s.declines)) {
        this.state.clearPending(msg.groupId, msg.senderMemberId);
        await this.reply(msg, s, pending.lang, 'cancelled', {});
        return true;
      }
    }

    // Inside the follow-up window she is listening to messages that were never
    // marked for her, so the bar to ACT on one is higher than for a message that
    // says her name. A bare keyword is not enough there — "I'll publish the
    // photos later" is a member talking to the group, and interrupting it with a
    // consent prompt is exactly the unwanted interjection §1 warns against. A
    // multi-word instruction ("publish me") still scores well above this, and
    // affirmations are handled before resolution, so "yes" is unaffected.
    const threshold = explicit
      ? s.confidenceThreshold
      : Math.max(s.confidenceThreshold, IMPLICIT_MIN_CONFIDENCE);

    const result = await resolveIntent(instruction, {
      threshold,
      defaultLanguage: s.defaultLanguage,
    });
    const lang = result.lang;

    // A real new instruction supersedes an unanswered offer. Anything she did
    // NOT understand leaves the offer standing — a member who says "one moment"
    // mid-confirmation should still be able to say "yes" afterwards.
    if (pending && result.intent !== 'UNKNOWN') {
      this.state.clearPending(msg.groupId, msg.senderMemberId);
    }

    switch (result.intent) {
      case 'PUBLISH':
      case 'UNPUBLISH': {
        const target = result.slots.targetName;
        if (target !== undefined) {
          // §4.2 — refuse, take no action, regardless of who is asking.
          log.info(
            `Interaction: refused a third-party consent request from member ${msg.senderMemberId}.`,
          );
          await this.reply(msg, s, lang, 'refuseThirdParty', { name: target });
          return true;
        }
        const followUpMs = s.followUpSeconds * 1000;
        this.state.setPending(msg.groupId, msg.senderMemberId, {
          intent: result.intent,
          lang,
          // The offer lives exactly as long as the conversation does.
          expiresAt: now + Math.max(followUpMs, 15_000),
        });
        // §1 — a confirmation prompt may carry a name prefix so the member knows
        // the prompt is theirs, but must never quote them back to the group.
        await this.reply(
          msg,
          s,
          lang,
          result.intent === 'PUBLISH' ? 'publishConfirm' : 'unpublishConfirm',
          {},
          { neverQuote: true },
        );
        return true;
      }

      case 'STATUS': {
        // Kept to one line on purpose (§4.6): there is no private channel to
        // move a personal answer into, so it says as little as it can.
        const counts = await memberArchiveCounts(this.deps.db, msg.senderMemberId);
        await this.reply(msg, s, lang, 'status', {
          total: counts.total,
          public: counts.published,
        });
        return true;
      }

      case 'SEARCH': {
        const query = result.slots.query;
        if (!query) {
          await this.reply(msg, s, lang, 'notUnderstood', {});
          return true;
        }
        const n = await countPublishedMatching(this.deps.db, query);
        await this.reply(msg, s, lang, 'searchResult', { n, query });
        return true;
      }

      case 'HELP':
        await this.reply(msg, s, lang, 'help', { wake: s.wakeWord });
        return true;

      case 'UNDO':
        return this.performUndo(msg, s, lang);

      case 'UNKNOWN':
      default:
        // Inside the follow-up window an unrecognised message is far more likely
        // to be ordinary conversation than a failed instruction, so she says
        // nothing and lets it be archived like any other message.
        if (!explicit) return false;
        await this.reply(msg, s, lang, 'notUnderstood', {});
        return true;
    }
  }

  /* ── Actions ───────────────────────────────────────────────────────────── */

  private async performConsentChange(
    msg: CapturedMessage,
    s: InteractionSettings,
    pending: PendingConfirmation,
  ): Promise<boolean> {
    const action = pending.intent === 'PUBLISH' ? 'opt_in' : 'opt_out';
    try {
      await applyConsentChange(this.deps.db, {
        memberId: msg.senderMemberId,
        at: msg.sentAt,
        action,
        source: 'natural',
      });
    } catch (err) {
      // Never let a consent decision fail quietly — it is the product's legal
      // backbone. The offer stays open so the member can simply say yes again.
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Interaction: ${action} failed for member ${msg.senderMemberId}: ${message}`);
      status.error(`Consent (natural language) ${action} failed: ${message}`);
      await this.reply(msg, s, pending.lang, 'notUnderstood', {});
      return true;
    }

    this.state.clearPending(msg.groupId, msg.senderMemberId);
    log.info(
      `Interaction: ${action} recorded for member ${msg.senderMemberId} via natural language.`,
    );
    await this.reply(
      msg,
      s,
      pending.lang,
      pending.intent === 'PUBLISH' ? 'published' : 'unpublished',
      {},
      { bypassLimit: true },
    );
    return true;
  }

  private async performUndo(
    msg: CapturedMessage,
    s: InteractionSettings,
    lang: string,
  ): Promise<boolean> {
    const notBefore =
      s.undoWindowSeconds > 0
        ? new Date(new Date(msg.sentAt).getTime() - s.undoWindowSeconds * 1000).toISOString()
        : null;

    let undone = null;
    try {
      // Scoped to the sender's own member id — there is no shape of this call
      // that reaches somebody else's decision (§4.4).
      undone = await undoLastConsentAction(this.deps.db, msg.senderMemberId, msg.sentAt, notBefore);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Interaction: undo failed for member ${msg.senderMemberId}: ${message}`);
      status.error(`Consent undo failed: ${message}`);
      await this.reply(msg, s, lang, 'undoNothing', {});
      return true;
    }

    if (undone) {
      log.info(
        `Interaction: undid ${undone.action} for member ${msg.senderMemberId} (action ${undone.id}).`,
      );
    }
    await this.reply(
      msg,
      s,
      lang,
      undone ? 'undo' : 'undoNothing',
      {},
      {
        bypassLimit: undone !== null,
      },
    );
    return true;
  }

  private async handleNickname(
    msg: CapturedMessage,
    s: InteractionSettings,
    now: number,
  ): Promise<boolean> {
    // The instruction is DISCARDED, not resolved (§6). Nothing below reads it.
    const allowed = this.state.noteNickname(
      msg.groupId,
      msg.senderMemberId,
      now,
      s.nicknames.spamLimit,
    );
    if (!allowed) {
      log.debug(
        `Interaction: nickname anti-spam limit reached for member ${msg.senderMemberId}; staying silent.`,
      );
      return true;
    }

    const lang = guessLanguage(msg.text, s.defaultLanguage);
    const list = this.retorts(s, lang);
    const index = this.state.pickRetort(msg.groupId, list.length, this.random);
    const retort = index >= 0 ? list[index] : undefined;
    if (retort) {
      // A retort is a snub, not an address: no name prefix (that would read as
      // her talking TO the member, contradicting "never opens a conversation")
      // and no quote.
      await this.sendReply(msg, s, { text: retort, quote: false }, { openWindow: false });
    }
    return true;
  }

  /* ── Replies ───────────────────────────────────────────────────────────── */

  private persona(s: InteractionSettings, lang: string, key: PersonaKey): string {
    const strings =
      s.persona[lang] ??
      s.persona[s.defaultLanguage] ??
      s.persona['en'] ??
      DEFAULT_INTERACTION.persona['en'];
    return strings?.[key] ?? (DEFAULT_INTERACTION.persona['en'] as Record<PersonaKey, string>)[key];
  }

  private retorts(s: InteractionSettings, lang: string): string[] {
    return (
      s.retorts[lang] ??
      s.retorts[s.defaultLanguage] ??
      s.retorts['en'] ??
      (DEFAULT_INTERACTION.retorts['en'] as string[])
    );
  }

  /** The prefix template for a language, or null when prefixing is switched off. */
  private prefixTemplate(s: InteractionSettings, lang: string): string | null {
    if (!s.namePrefix.enabled) return null;
    const t = s.namePrefix.templates;
    return t[lang] ?? t[s.defaultLanguage] ?? t['en'] ?? null;
  }

  private async reply(
    msg: CapturedMessage,
    s: InteractionSettings,
    lang: string,
    key: PersonaKey,
    vars: Record<string, string | number>,
    opts: ReplyOptions = {},
  ): Promise<void> {
    // The body's own placeholders are filled FIRST and separately from the name
    // prefix — see the {name} footgun note in reply.ts. Formatting deliberately
    // happens here rather than inside sendReply's try/catch, so a broken prefix
    // template fails loudly instead of being swallowed as a failed send.
    const body = fillPersona(this.persona(s, lang, key), vars);
    const out = formatOutbound(body, {
      mode: s.replyMode,
      prefixTemplate: this.prefixTemplate(s, lang),
      displayName: msg.senderDisplayName,
      allowQuote: opts.neverQuote !== true,
    });
    await this.sendReply(msg, s, out, opts);
  }

  private async sendReply(
    msg: CapturedMessage,
    s: InteractionSettings,
    out: OutboundReply,
    opts: ReplyOptions,
  ): Promise<void> {
    const now = this.now();
    const openWindow = opts.openWindow !== false;

    if (opts.bypassLimit) {
      this.state.noteReply(msg.groupId, msg.senderMemberId, now);
    } else if (
      !this.state.allowReply(
        msg.groupId,
        msg.senderMemberId,
        now,
        s.replyLimitPerMember,
        s.replyLimitPerChat,
      )
    ) {
      log.debug(
        `Interaction: reply rate limit hit for member ${msg.senderMemberId} in group ${msg.groupId}; staying silent.`,
      );
      return;
    }

    try {
      await this.deps.send(msg, out.text, { quote: out.quote });
    } catch (err) {
      log.warn(
        `Interaction: failed to reply to member ${msg.senderMemberId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // §2 — the window refreshes on every reply she actually sends.
    if (openWindow) {
      this.state.openFollowUp(msg.groupId, msg.senderMemberId, now, s.followUpSeconds * 1000);
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */

  /**
   * Does a short answer begin with one of the configured words? Used for the
   * affirmation and decline lists, which are fuzzy-matched like everything else
   * (`jup`, `yeah`, `klar`) but anchored at the start and length-bounded, so a
   * long sentence that happens to contain "ok" is not read as consent.
   */
  private matchesList(instruction: string, list: string[]): boolean {
    const tokens = normTokens(instruction);
    if (tokens.length === 0) return false;
    for (const entry of list) {
      const pat = normTokens(entry);
      if (pat.length === 0 || pat.length > tokens.length) continue;
      if (tokens.length > pat.length + 2) continue;
      let ok = true;
      for (let i = 0; i < pat.length; i++) {
        if (!fuzzyEquals(tokens[i] as string, pat[i] as string)) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }
}
