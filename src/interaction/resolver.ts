/**
 * The resolver seam (CCB-S3-002 §8).
 *
 * Every caller goes through {@link resolveIntent}. Nothing outside this file
 * imports the rule engine, so a later briefing can register a local AI brain
 * with {@link setIntentResolver} and change no caller at all — with the rule
 * engine staying registered as the automatic fallback for when the AI endpoint
 * is unreachable, slow, or returns something outside the closed catalog.
 *
 * The catalog is enforced HERE rather than trusted from the implementation. A
 * resolver that invents an intent, returns a confidence outside 0..1, or throws
 * is treated as having said UNKNOWN. The catalog is the ACTIVE one, so an intent
 * whose plugin is switched off is rejected the same way an invented one is. For a rule engine that is belt-and-braces;
 * for a model it is the difference between "I did not understand" and an
 * unauthorised publish.
 */

import { log } from '../log.js';
import {
  isActiveIntent,
  unknownResult,
  type IntentContext,
  type IntentResolver,
  type IntentResult,
  type IntentSlots,
} from './intent.js';
import { priceSlotsFor, ruleResolver } from './rules.js';

let active: IntentResolver = ruleResolver;
/** Fallback used when `active` fails. Always the deterministic engine. */
const fallback: IntentResolver = ruleResolver;

/** Swaps in another implementation (the AI brain, in a later briefing). */
export function setIntentResolver(resolver: IntentResolver): void {
  active = resolver;
  log.info(`Intent resolver set to "${resolver.name}".`);
}

/** Restores the deterministic rule engine as the active resolver. */
export function resetIntentResolver(): void {
  active = ruleResolver;
}

export function activeResolverName(): string {
  return active.name;
}

/** Coerces any resolver's output into a valid, in-catalog result. */
function sanitize(raw: unknown, lang: string): IntentResult {
  if (!raw || typeof raw !== 'object') return unknownResult(lang);
  const r = raw as Record<string, unknown>;
  // Validated against the ACTIVE catalog, not just the compile-time one: an
  // intent belonging to a disabled plugin is treated exactly like an invented
  // one (CCB-S3-004 §0).
  if (!isActiveIntent(r['intent'])) return unknownResult(lang);

  const confidence =
    typeof r['confidence'] === 'number' && Number.isFinite(r['confidence'])
      ? Math.min(1, Math.max(0, r['confidence']))
      : 0;

  const rawSlots = (r['slots'] ?? {}) as Record<string, unknown>;
  const slots: IntentSlots = {};
  if (typeof rawSlots['query'] === 'string' && rawSlots['query'].trim()) {
    slots.query = rawSlots['query'].trim().slice(0, 200);
  }
  if (typeof rawSlots['targetName'] === 'string' && rawSlots['targetName'].trim()) {
    slots.targetName = rawSlots['targetName'].trim().slice(0, 80);
  }
  if (Array.isArray(rawSlots['baseAlternates'])) {
    const alts = (rawSlots['baseAlternates'] as unknown[])
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
      .map((v) => v.trim().slice(0, 40))
      .slice(0, 8);
    if (alts.length > 0) slots.baseAlternates = alts;
  }
  for (const key of ['base', 'quote'] as const) {
    const v = rawSlots[key];
    if (typeof v === 'string' && v.trim()) slots[key] = v.trim().slice(0, 40);
  }
  // An amount that is not a finite positive number is dropped rather than
  // coerced — the caller's default of 1 is always safe, a NaN never is.
  if (typeof rawSlots['amount'] === 'number' && Number.isFinite(rawSlots['amount'])) {
    const a = rawSlots['amount'];
    if (a > 0 && a <= 1e15) slots.amount = a;
  }

  return {
    intent: r['intent'],
    confidence,
    slots,
    lang: typeof r['lang'] === 'string' && r['lang'] ? r['lang'] : lang,
  };
}

/**
 * Slots for an elliptical follow-up that inherits a previous intent
 * (CCB-S3-006 §7c). Kept behind the seam so callers still never import the rule
 * engine, and restricted to READ-ONLY intents by its own signature — there is no
 * argument value that yields PUBLISH or UNPUBLISH.
 */
export function carryOverSlots(text: string, intent: 'PRICE' | 'SEARCH'): IntentResult | null {
  if (intent === 'SEARCH') {
    const q = text.trim();
    return q ? { intent: 'SEARCH', confidence: 0.7, slots: { query: q }, lang: 'en' } : null;
  }
  const slots = priceSlotsFor(text);
  if (!slots.base) return null;
  return { intent: 'PRICE', confidence: 0.7, slots, lang: 'en' };
}

/**
 * Resolves an instruction into an intent. Never throws, never executes anything,
 * and never returns anything outside the closed catalog.
 */
export async function resolveIntent(text: string, ctx: IntentContext): Promise<IntentResult> {
  try {
    return sanitize(await active.resolve(text, ctx), ctx.defaultLanguage);
  } catch (err) {
    log.warn(
      `Intent resolver "${active.name}" failed (${
        err instanceof Error ? err.message : String(err)
      }); falling back to "${fallback.name}".`,
    );
  }
  try {
    return sanitize(await fallback.resolve(text, ctx), ctx.defaultLanguage);
  } catch (err) {
    log.error(
      `Fallback intent resolver failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return unknownResult(ctx.defaultLanguage);
  }
}
