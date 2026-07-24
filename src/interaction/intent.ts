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

/**
 * Intents that are always available, whatever plugins are installed. The consent
 * intents live here because they are the product, not a capability bolted onto it.
 */
export const CORE_INTENTS: readonly Intent[] = [
  'PUBLISH',
  'UNPUBLISH',
  'STATUS',
  'SEARCH',
  'HELP',
  'UNDO',
  'UNKNOWN',
];

/**
 * The catalog as it stands RIGHT NOW: the core intents plus whatever enabled
 * plugins contribute (CCB-S3-004 §0).
 *
 * `INTENTS` above is the compile-time closed set — it is what makes an invented
 * intent a type error. This is the runtime subset, and it is what the resolver
 * seam validates against, so a disabled plugin's intent is not merely unhandled
 * but absent: nothing can resolve to it.
 */
let activeIntents = new Set<Intent>(CORE_INTENTS);

/** Replaces the active catalog. Called whenever plugin enablement changes. */
export function setActiveIntents(extra: readonly Intent[]): void {
  activeIntents = new Set<Intent>([...CORE_INTENTS, ...extra]);
}

export function isActiveIntent(v: unknown): v is Intent {
  return isIntent(v) && activeIntents.has(v);
}

export function activeIntentList(): Intent[] {
  return [...activeIntents];
}

/** Intents that change consent, and therefore always require confirmation (§4.1). */
export const CONSENT_INTENTS: readonly Intent[] = ['PUBLISH', 'UNPUBLISH'];

export interface IntentSlots {
  /** SEARCH: what the member is looking for. */
  query?: string;
  /** PRICE: the asset being asked about, as the member wrote it. */
  base?: string;
  /**
   * PRICE: other words in the message that could be the asset, best first
   * (CCB-S3-006 §3). The resolver cannot know which symbols exist — that is the
   * registry's business — so it offers candidates and the price service prefers
   * whichever is already pinned. "one real bitcoin" therefore resolves to
   * Bitcoin rather than to an unknown token called "real".
   */
  baseAlternates?: string[];
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
  /**
   * True when `lang` came from an UNAMBIGUOUS keyword-set match (CCB-S3-005
   * Addendum A): the winning language's best score strictly beat every other
   * language's. That is authoritative evidence of the member's language — stronger
   * than statistical detection, and independent of message length — so the engine
   * answers in `lang` rather than re-detecting. False (or absent) for UNKNOWN, for
   * a language-ambiguous match (a keyword identical in both, e.g. `status`/`undo`),
   * and for the conversion / carry-over paths, where the weighted contest and the
   * default stand as before.
   */
  langMatched?: boolean;
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
