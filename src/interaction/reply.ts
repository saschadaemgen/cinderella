/**
 * Outbound reply presentation (CCB-S3-003).
 *
 * One pure function decides how a finished reply body reaches the group: whether
 * it quotes the message that triggered it, and whether it opens with the
 * member's name. Keeping it pure — no SDK, no database, no clock — is what lets
 * the harness assert the presentation rules directly instead of inferring them
 * from a mock.
 *
 * Why quoting stopped being the default: SimpleX renders a reply by repeating
 * the quoted message above the answer. For a bot that answers most things in one
 * line, that doubles the volume of every exchange and reads as assembled noise
 * to the members who are not part of it.
 *
 * THE {name} FOOTGUN. Two different values can fill `{name}` in this pipeline:
 * the third-party refusal fills it with the person the instruction targeted, and
 * the mention prefix fills it with the sender. They must never be filled in the
 * same pass. This function therefore takes an ALREADY-RENDERED body and only
 * prepends to it — it never runs a template over the combined string. Any
 * refactor that concatenates first and interpolates afterwards reintroduces a
 * bug where a refusal could name the wrong person.
 */

import { fillPersona } from './settings.js';
import type { ReplyMode } from './settings.js';

export interface OutboundReply {
  /** Exactly what goes on the wire. */
  text: string;
  /** Whether to send it as a quoting reply. */
  quote: boolean;
  /**
   * The member name this reply put into the text via the prefix, exactly as it
   * was embedded — absent when nothing was prefixed (CCB-S3-007 §2).
   *
   * The leak guard needs the literal string, not the raw display name: what the
   * prefix inserts is the SANITIZED name, and redaction has to match the text
   * that is actually there.
   */
  prefixName?: string;
}

export interface FormatOptions {
  mode: ReplyMode;
  /** The prefix template, or null when prefixing is off. */
  prefixTemplate: string | null;
  /** The member's display name — untrusted input. */
  displayName: string;
  /**
   * False for messages that must never quote whatever the mode says, i.e. the
   * consent confirmation prompts (§1) and the slash-command confirmations.
   */
  allowQuote?: boolean;
}

/**
 * Display names are member-controlled, and SimpleX parses formatting in the text
 * we send. A name is not allowed to break the reply out of one line, run to an
 * arbitrary length, or — the case that actually matters — open a formatting span
 * that swallows the rest of the sentence.
 *
 * Verified against the real 6.5.4 parser: a name like `#Robin#` renders as a
 * SECRET (spoiler) span, which would hide the very name the prefix exists to
 * show. Single stray delimiters are harmless, but stripping the pairing
 * characters outright is cheaper and more predictable than reimplementing the
 * parser's pairing rules here. `_` is deliberately KEPT: underscores inside a
 * word do not italicise (`snake_case_word` stays literal), and they are common
 * in real names.
 */
const NAME_FORMATTING_CHARS = /[*~`#]/g;

export function sanitizeDisplayName(name: string): string {
  return name
    .replace(/[\r\n\t]+/g, ' ')
    .replace(NAME_FORMATTING_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64)
    .trim();
}

/**
 * Turns a rendered reply body into the message that will actually be sent.
 * `body` must already have had its own placeholders filled.
 */
export function formatOutbound(body: string, opts: FormatOptions): OutboundReply {
  const quote = opts.mode === 'quote' && opts.allowQuote !== false;

  if (opts.mode !== 'mention' || !opts.prefixTemplate) {
    return { text: body, quote };
  }

  const name = sanitizeDisplayName(opts.displayName);
  if (!name) return { text: body, quote };

  // The template is stored trimmed, so the separating space is added here — one
  // place, so a saved prefix can never run into the sentence.
  const prefix = fillPersona(opts.prefixTemplate, { name }).trim();
  if (!prefix) return { text: body, quote };

  return { text: `${prefix} ${body}`, quote, prefixName: name };
}
