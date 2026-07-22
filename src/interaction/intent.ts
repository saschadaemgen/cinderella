/**
 * The intent contract (CCB-S3-002 §3, §8).
 *
 * This file defines WHAT a resolver may say, not HOW it decides. The rule engine
 * in `rules.ts` is one implementation; a later briefing swaps in a local AI brain
 * behind the same signature with the rules as the automatic fallback. Callers
 * import `resolver.ts` and never the engine directly, so that swap touches no
 * caller.
 *
 * The catalog is CLOSED: nothing outside {@link INTENTS} may ever be produced.
 * `resolver.ts` re-validates every result against it, which matters most for the
 * AI implementation — a model that invents an intent must be treated as having
 * said UNKNOWN, not as having authorised something.
 *
 * A resolver NEVER executes anything. It reports what it believes was meant;
 * the engine performs the action and the existing consent code enforces the
 * rules. That separation is mandatory and must survive the AI swap.
 */

export const INTENTS = [
  'PUBLISH', // opt in
  'UNPUBLISH', // opt out / withdraw
  'STATUS', // what do you have on me
  'SEARCH', // find something in the archive
  'HELP', // what can you do
  'UNDO', // revert the last action
  'PRICE', // what is an asset worth (CCB-S3-004)
  'UNKNOWN', // not understood
] as const;

export type Intent = (typeof INTENTS)[number];

/** Intents that change consent, and therefore always require confirmation (§4.1). */
export const CONSENT_INTENTS: readonly Intent[] = ['PUBLISH', 'UNPUBLISH'];

export interface IntentSlots {
  /** SEARCH: what the member is looking for. */
  query?: string;
  /** PRICE: the asset being asked about, as the member wrote it. */
  base?: string;
  /** PRICE: the currency or asset to express it in. Defaults to the configured one. */
  quote?: string;
  /** PRICE: how much of the base asset. Defaults to 1. */
  amount?: number;
  /**
   * PUBLISH/UNPUBLISH: another member the instruction appears to target. Its
   * presence means REFUSE (§4.2) — consent is first-person only, even for admins.
   */
  targetName?: string;
}

export interface IntentResult {
  intent: Intent;
  /** 0..1. Below the context threshold the engine must treat this as UNKNOWN. */
  confidence: number;
  slots: IntentSlots;
  /** Language the instruction appeared to be in — persona replies follow it. */
  lang: string;
}

export interface IntentContext {
  /** Confidence below which a result must be reported as UNKNOWN. */
  threshold: number;
  /** Language to assume when the instruction gives no clue. */
  defaultLanguage: string;
}

export interface IntentResolver {
  /** Identifies the implementation in logs (`rules`, later `ai`). */
  readonly name: string;
  resolve(text: string, ctx: IntentContext): Promise<IntentResult>;
}

export function unknownResult(lang: string): IntentResult {
  return { intent: 'UNKNOWN', confidence: 0, slots: {}, lang };
}

/** True when `v` is a member of the closed catalog. */
export function isIntent(v: unknown): v is Intent {
  return typeof v === 'string' && (INTENTS as readonly string[]).includes(v);
}
