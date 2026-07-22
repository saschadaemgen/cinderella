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
import { carryOverSlots, resolveIntent } from './resolver.js';
import { ConversationState, type PendingChoice, type PendingConfirmation } from './state.js';
import {
  NEAR_MISS_EXCERPT,
  recordNearMiss,
  recentNearMisses,
  type NearMiss,
  type NearMissReason,
} from './near-misses.js';
import {
  DEFAULT_INTERACTION,
  fillPersona,
  type InteractionSettings,
  type PersonaKey,
} from './settings.js';
import { detectLanguage, fuzzyEquals, normTokens } from './text.js';
import type { PriceOutcome } from '../plugins/crypto-prices/service.js';
import { formatAmount, formatValue, describeAge } from '../price/format.js';
import { candidateMetric } from '../plugins/crypto-prices/service.js';
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
  /**
   * Market data (CCB-S3-004), injected by the plugin. Absent when the plugin is
   * disabled — in which case PRICE is not in the active catalog either, so this
   * is belt and braces rather than the only guard.
   */
  prices?: {
    price(
      base: string,
      quote: string | undefined,
      amount: number,
      scope?: string,
      alternates?: string[],
    ): Promise<PriceOutcome>;
    pin(
      symbol: string,
      candidate: { id: string; symbol: string; name: string; chain?: string; contract?: string },
      provider: string,
      source: 'member-choice',
    ): Promise<unknown>;
  };
  /** Live plugin settings for the price feature. */
  priceSettings?: () => {
    rateLimitPerMember: number;
    rateLimitPerChat: number;
    disclaimer: string;
  };
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
  /** Appended to the reply on its own line (the price disclaimer). */
  suffix?: string;
  /**
   * Never quote, whatever `replyMode` says (CCB-S3-003 §1). Set on the consent
   * confirmation prompts: they may carry a name prefix so the member knows the
   * prompt is theirs, but must not repeat their message back at the group.
   */
  neverQuote?: boolean;
}

/**
 * Matches a member's reply to one of the offered assets: a number ("2"), the
 * asset's name, or its chain. Deliberately strict — a wrong pin is permanent
 * until an operator changes it, so anything unrecognised leaves the question
 * open rather than guessing.
 */
function matchChoice(
  instruction: string,
  choice: PendingChoice,
): PendingChoice['options'][number] | undefined {
  const t = instruction.trim().toLowerCase();
  if (!t) return undefined;
  const asIndex = Number.parseInt(t, 10);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= choice.options.length) {
    return choice.options[asIndex - 1];
  }
  for (const o of choice.options) {
    if (o.name.toLowerCase() === t) return o;
    if (o.chain && o.chain.toLowerCase() === t) return o;
  }
  // A distinctive word, e.g. "pulsechain" out of "HEX (PulseChain)".
  const hits = choice.options.filter(
    (o) => o.name.toLowerCase().includes(t) || (o.chain ?? '').toLowerCase().includes(t),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Minimum confidence to act on a message that did NOT name her — one heard only
 * because the follow-up window was open. Set above the single-keyword score so
 * that only a real, multi-word instruction carries inside the window.
 */
const IMPLICIT_MIN_CONFIDENCE = 0.8;

/** Longest fragment that still counts as an elliptical follow-up (§7c). */
const CARRY_OVER_MAX_TOKENS = 4;

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

    // A FORWARDED message is content someone is sharing, not someone speaking to
    // her (CCB-S3-005 §1). This guard is not cosmetic: a forwarded announcement
    // whose first words are her name and which quotes the commands it documents
    // resolves to PUBLISH at high confidence, which would post a consent
    // confirmation prompt to the whole group. Checked BEFORE addressing, so no
    // other guard has to be right for this one to hold.
    if (msg.forwarded && s.addressing.ignoreForwarded) {
      this.noteNearMiss(msg, s, now, 'forwarded', msg.text, undefined);
      return false;
    }

    const address = detectAddress(msg.text, s);

    // Nicknames (§6): a retort, and nothing else. Never resolved, never acted
    // on, never opens the follow-up window.
    if (address.kind === 'nickname') {
      return this.handleNickname(msg, s, now);
    }

    const inWindow = this.state.inFollowUp(msg.groupId, msg.senderMemberId, now);

    let instruction: string;
    let explicit: boolean;
    // A STRONG signal means she can be confident she was actually addressed, and
    // is the difference between answering "I did not quite catch that" and
    // staying out of it (§2). A bare name at the start of a message is the weak
    // case — it is how announcements, quotes and third-person talk begin.
    let strong: boolean;

    if (address.kind === 'wake') {
      this.state.resetNicknameStreak(msg.groupId, msg.senderMemberId);
      instruction = address.instruction;
      explicit = true;
      strong = address.greeted && s.addressing.strongSignalGreeting;
    } else if (msg.quotedFromBot) {
      // A direct reply to one of her messages needs no wake word (§1.2).
      instruction = msg.text;
      explicit = true;
      strong = s.addressing.strongSignalReply;
    } else if (inWindow) {
      // Mid-conversation (§2).
      instruction = msg.text;
      explicit = false;
      strong = s.addressing.strongSignalWindow;
    } else {
      // In strict mode a bare leading name is not an address. Log it, so the
      // operator can see what strict mode is costing them rather than guessing.
      if (s.addressing.mode === 'strict' && address.kind === 'none') {
        const relaxed = detectAddress(msg.text, {
          ...s,
          addressing: { ...s.addressing, mode: 'relaxed' },
        });
        if (relaxed.kind === 'wake') {
          this.noteNearMiss(msg, s, now, 'strict-mode-no-greeting', relaxed.instruction, undefined);
        }
      }
      return false;
    }

    // Arriving inside the window is a strong signal in its own right, whichever
    // way she was addressed.
    if (inWindow && s.addressing.strongSignalWindow) strong = true;

    return this.dispatch(msg, s, instruction, explicit, strong, now);
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
    strong: boolean,
    now: number,
  ): Promise<boolean> {
    const pending = this.state.getPending(msg.groupId, msg.senderMemberId, now);
    // The language of THIS message, decided before anything is resolved, so the
    // not-understood reply is covered too (§6).
    const lang = this.replyLanguage(msg, s, instruction, pending, now);

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

    // A pending "which HEX did you mean?" is answered before anything else is
    // resolved — the reply is a bare "1" or a name, which resolves to nothing.
    const choice = this.state.getPendingChoice(msg.groupId, msg.senderMemberId, now);
    if (choice && (await this.resolveChoice(msg, s, lang, instruction, choice, now))) {
      return true;
    }

    let result = await resolveIntent(instruction, {
      threshold,
      defaultLanguage: lang,
    });

    // §7c — an elliptical follow-up inside the window inherits the previous
    // READ-ONLY intent: "monero?" after a price answer is a price question. The
    // guard is structural: only PRICE and SEARCH can be inherited, so no
    // fragment can ever become a consent action, however it is phrased.
    let carried = false;
    if (
      result.intent === 'UNKNOWN' &&
      s.intentCarryover &&
      // An elliptical follow-up is SHORT — "monero?", "and of monero?". Without
      // this bound, any ordinary sentence inside the window that happened to
      // contain a noun became a price question, which is the same
      // over-eagerness CCB-S3-005 spent a whole briefing removing.
      normTokens(instruction).length <= CARRY_OVER_MAX_TOKENS &&
      this.state.inFollowUp(msg.groupId, msg.senderMemberId, now)
    ) {
      const previous = this.state.rememberedIntent(msg.groupId, msg.senderMemberId, now);
      if (previous === 'PRICE' || previous === 'SEARCH') {
        const inherited = carryOverSlots(instruction, previous);
        if (inherited) {
          result = { ...inherited, lang };
          carried = true;
        }
      }
    }

    // The LENGTH GUARD (§3). A command is short. Long-form text that merely opens
    // with her name — an announcement, a pasted article — is only acted on when
    // the resolver is very sure, and is otherwise ignored rather than answered.
    if (
      !carried &&
      instruction.length > s.addressing.maxInstructionLength &&
      result.confidence < s.addressing.lengthGuardConfidence
    ) {
      this.noteNearMiss(msg, s, now, 'too-long', instruction, result);
      return false;
    }

    // A real new instruction supersedes an unanswered offer. Anything she did
    // NOT understand leaves the offer standing — a member who says "one moment"
    // mid-confirmation should still be able to say "yes" afterwards.
    if (pending && result.intent !== 'UNKNOWN') {
      this.state.clearPending(msg.groupId, msg.senderMemberId);
    }

    // Only READ-ONLY intents are remembered (§7c). Storing a consent intent here
    // is what would make a later bare "yes" dangerous, so it never happens.
    if (result.intent === 'PRICE' || result.intent === 'SEARCH') {
      this.state.rememberIntent(msg.groupId, msg.senderMemberId, result.intent);
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

      case 'PRICE':
        return this.answerPrice(msg, s, lang, result.slots, now);

      case 'UNKNOWN':
      default:
        // Inside the follow-up window an unrecognised message is far more likely
        // to be ordinary conversation than a failed instruction, so she says
        // nothing and lets it be archived like any other message.
        if (!explicit) return false;
        // §2 — "I did not quite catch that" is only appropriate when she is
        // confident she was being addressed at all. A bare leading name is not
        // that: it is how a forwarded announcement, a quote, or a sentence about
        // her begins. Weak signal means stay out of it, and leave a trace.
        if (s.addressing.silenceOnUnknown && !strong) {
          this.noteNearMiss(msg, s, now, 'weak-signal-unknown', instruction, result);
          return false;
        }
        await this.reply(msg, s, lang, 'notUnderstood', {});
        return true;
    }
  }

  /**
   * Which language to answer in (§6), in order of authority:
   *
   *  1. `fixed` mode — always the configured default.
   *  2. An OPEN confirmation offer — its language wins, so a prompt and its
   *     result can never come back in different languages mid-handshake.
   *  3. Confident detection from THIS message.
   *  4. The language the exchange has been running in (a bare `yes` carries no
   *     signal of its own).
   *  5. The configured default.
   *
   * Only languages with real persona copy are offered: the map is the shipped
   * and operator-edited set, never the machine-translated website locales.
   */
  private replyLanguage(
    msg: CapturedMessage,
    s: InteractionSettings,
    instruction: string,
    pending: PendingConfirmation | undefined,
    now: number,
  ): string {
    const available = (code: string | undefined): string | undefined =>
      code && s.persona[code] ? code : undefined;

    const fallback = available(s.defaultLanguage) ?? 'en';
    if (s.replyLanguageMode === 'fixed') return fallback;
    if (pending) return available(pending.lang) ?? fallback;

    // Detect from the member's own words, not from which keyword set matched —
    // that is what left an English message answered in German.
    const guess = detectLanguage(instruction || msg.text, fallback);
    if (guess.confident) {
      const lang = available(guess.lang) ?? fallback;
      if (s.rememberMemberLanguage) {
        this.state.rememberLanguage(msg.groupId, msg.senderMemberId, lang);
      }
      return lang;
    }

    if (s.rememberMemberLanguage) {
      const remembered = available(
        this.state.rememberedLanguage(msg.groupId, msg.senderMemberId, now),
      );
      if (remembered) return remembered;
    }
    return fallback;
  }

  /** Records an ignored candidate so the guards are visible, not invisible (§5). */
  private noteNearMiss(
    msg: CapturedMessage,
    s: InteractionSettings,
    now: number,
    reason: NearMissReason,
    text: string,
    result: { intent: string; confidence: number } | undefined,
  ): void {
    log.debug(
      `Interaction: ignored a message from ${msg.senderMemberId} (${reason})` +
        `${result ? ` — ${result.intent} @ ${result.confidence.toFixed(2)}` : ''}.`,
    );
    if (!s.addressing.logNearMisses) return;
    const entry: NearMiss = {
      at: now,
      groupId: msg.groupId,
      who: msg.senderDisplayName,
      reason,
      excerpt: text.replace(/\s+/g, ' ').trim().slice(0, NEAR_MISS_EXCERPT),
      intent: result?.intent,
      confidence: result?.confidence,
    };
    recordNearMiss(entry);
  }

  /**
   * Records that SOMETHING replied to this member, refreshing their follow-up
   * window (CCB-S3-006 §7c). The engine's own replies do this inside sendReply;
   * this is for the slash-command path, which sends through the shared transport
   * without going through the engine at all. Without it, a member who used
   * `/publish` had no window and their next message was ignored.
   */
  noteExternalReply(groupId: number, memberId: string): void {
    const s = this.deps.settings();
    this.state.openFollowUp(groupId, memberId, this.now(), s.followUpSeconds * 1000);
  }

  /** Test hook: seed the remembered intent that drives carry-over (§7c). */
  rememberIntentForTest(groupId: number, memberId: string, intent: 'PRICE' | 'SEARCH'): void {
    this.state.rememberIntent(groupId, memberId, intent);
  }

  /** Recent ignored candidates, for the admin console. */
  nearMisses(limit?: number): NearMiss[] {
    return recentNearMisses(limit);
  }

  /**
   * Answers a price question (CCB-S3-004). Read-only: no confirmation, no
   * consent involvement, nothing journalled — it is a lookup, and the only state
   * it touches is a cache, a rate-limit counter, and the pinned mapping table.
   */
  private async answerPrice(
    msg: CapturedMessage,
    s: InteractionSettings,
    lang: string,
    slots: { base?: string; quote?: string; amount?: number; baseAlternates?: string[] },
    now: number,
  ): Promise<boolean> {
    const prices = this.deps.prices;
    const cfg = this.deps.priceSettings?.();
    const base = slots.base;
    if (!prices || !cfg) {
      // The plugin is off or unconfigured. PRICE should not even be in the
      // active catalog in that case, so this is the second line of defence.
      await this.reply(msg, s, lang, 'priceUnavailable', {});
      return true;
    }
    if (!base) {
      await this.reply(msg, s, lang, 'notUnderstood', {});
      return true;
    }

    // A price question costs an outbound call to a throttled third party, so it
    // has its own budget on top of the reply limit.
    if (
      !this.state.allowPrice(
        msg.groupId,
        msg.senderMemberId,
        now,
        cfg.rateLimitPerMember,
        cfg.rateLimitPerChat,
      )
    ) {
      log.debug(`Price: rate limit hit for member ${msg.senderMemberId}; staying silent.`);
      return true;
    }

    // Alternates let the service prefer an already-pinned asset word (§3).
    const outcome = await prices.price(
      base,
      slots.quote,
      slots.amount ?? 1,
      '*',
      slots.baseAlternates,
    );

    switch (outcome.kind) {
      case 'unknown-asset':
        await this.reply(msg, s, lang, 'priceUnknownAsset', { symbol: outcome.symbol });
        return true;

      case 'ambiguous': {
        // Ask, never choose — and remember the options so the member's answer
        // can be pinned globally and nobody is asked again (§1).
        const options = outcome.options.slice(0, 5);
        this.state.setPendingChoice(msg.groupId, msg.senderMemberId, {
          symbol: outcome.symbol,
          options: options.map((o) => ({
            id: o.id,
            symbol: o.symbol,
            name: o.name,
            ...(o.chain ? { chain: o.chain } : {}),
            ...(o.contract ? { contract: o.contract } : {}),
            provider: outcome.provider,
          })),
          expiresAt: now + Math.max(s.followUpSeconds * 1000, 60_000),
        });
        // One candidate per line, numbered, with the figure that actually tells
        // a real asset from a clone (§6). A comma-separated run was unreadable.
        await this.reply(msg, s, lang, 'priceAmbiguous', {
          symbol: outcome.symbol,
          options: options
            .map((o, i) => {
              const parts = [`*${i + 1}*`, o.name];
              if (o.chain) parts.push(`_${o.chain}_`);
              const metric = candidateMetric(o);
              if (metric) parts.push(metric);
              return parts.join(' · ');
            })
            .join('\n'),
        });
        return true;
      }

      case 'unavailable':
        // Honest failure. Never a stale or invented number.
        await this.reply(msg, s, lang, 'priceUnavailable', {});
        return true;

      default: {
        const quoteDecimals = 'decimals' in outcome.quote ? outcome.quote.decimals : 8;
        // Attribution and disclaimer each get their own line (§6); the credit
        // names the provider that actually answered, never a fixed string.
        const suffix = [
          outcome.attribution ? `🔗 ${outcome.attribution}` : '',
          cfg.disclaimer ? `⚠️ ${cfg.disclaimer}` : '',
        ]
          .filter((x) => x)
          .join('\n');
        // Secondary facts: where it trades, and how old the figure is.
        const detail = [
          outcome.kind === 'conversion'
            ? `via _${s.defaultLanguage === 'de' ? 'USD' : 'USD'}_ cross rate`
            : '',
          'chain' in outcome.base && outcome.base.chain ? `_${outcome.base.chain}_` : '',
          describeAge(outcome.at, now, lang),
        ]
          .filter((x) => x)
          .join(' · ');
        await this.reply(
          msg,
          s,
          lang,
          outcome.kind === 'conversion' ? 'conversion' : 'price',
          {
            amount: formatAmount(outcome.amount),
            base: outcome.base.symbol,
            quote: outcome.quote.symbol,
            value: formatValue(outcome.value, quoteDecimals),
            detail,
          },
          { suffix },
        );
        return true;
      }
    }
  }

  /**
   * Handles a member picking one of the assets she offered. The answer is pinned
   * GLOBALLY, so the question is asked once per symbol for the whole instance
   * rather than once per member (§1).
   */
  private async resolveChoice(
    msg: CapturedMessage,
    s: InteractionSettings,
    lang: string,
    instruction: string,
    choice: PendingChoice,
    now: number,
  ): Promise<boolean> {
    const picked = matchChoice(instruction, choice);
    if (!picked) return false;

    this.state.clearPendingChoice(msg.groupId, msg.senderMemberId);
    const prices = this.deps.prices;
    if (!prices) return false;
    try {
      await prices.pin(choice.symbol, picked, picked.provider, 'member-choice');
      log.info(`Price: "${choice.symbol}" pinned to ${picked.name} by a member's choice.`);
    } catch (err) {
      log.error(
        `Price: could not pin "${choice.symbol}": ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.reply(msg, s, lang, 'priceUnavailable', {});
      return true;
    }
    // Answer the original question now that the ambiguity is settled.
    return this.answerPrice(msg, s, lang, { base: choice.symbol }, now);
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

    const lang = this.replyLanguage(msg, s, msg.text, undefined, now);
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
    const suffix = opts.suffix?.trim();
    const body = suffix
      ? `${fillPersona(this.persona(s, lang, key), vars)}\n${suffix}`
      : fillPersona(this.persona(s, lang, key), vars);
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
