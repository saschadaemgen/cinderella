/**
 * Provider attempt diagnostics (CCB-S3-008 §3).
 *
 * Every market-data failure told the operator and the member the same thing —
 * "the markets are out of earshot" — whether the cause was a missing key, a bad
 * pin, a rate limit or an outage. That is not enough to act on, and it is how a
 * live instance ran for hours sending providers a credential that could never
 * have worked: the symptom was indistinguishable from a quiet market.
 *
 * So each attempt is recorded with the provider, what was asked, how long it
 * took, and how it ended. The admin console shows the recent ones next to the
 * provider chain, in the same spirit as the near-miss log: an invisible failure
 * is indistinguishable from a broken bot.
 *
 * IN MEMORY ONLY, capped, and never containing a key or a member's words — only
 * the symbol asked about, which is a ticker.
 */

/** How an attempt ended. */
export type AttemptOutcome =
  /** The provider answered with what was asked for. */
  | 'ok'
  /** It answered, and does not know this asset. Not a fault. */
  | 'not-found'
  /** Rejected the credential — a key that is missing, wrong, or unsupported. */
  | 'unauthorized'
  /** The provider throttled us. */
  | 'throttled'
  /** OUR OWN per-provider budget stopped the call before it was made. */
  | 'skipped-rate-limit'
  /** No id for this provider, or no chain/contract it could use. */
  | 'skipped-no-id'
  /** Timed out, DNS, connection reset, or any non-HTTP failure. */
  | 'unreachable'
  /** Answered, but not in a shape we could use. */
  | 'bad-response';

export interface ProviderAttempt {
  /**
   * Epoch ms, always from the real clock — see {@link recordAttempt}.
   */
  at: number;
  provider: string;
  /** `resolve` (which asset is this?) or `quote` (what is it worth?). */
  op: 'resolve' | 'quote';
  /** The ticker asked about. Never a member's own words. */
  symbol: string;
  outcome: AttemptOutcome;
  /** Round-trip in ms; 0 for an attempt that was never made. */
  ms: number;
  /** HTTP status where there was one. */
  status?: number;
  /** Short cause, safe to display. Never contains a credential. */
  detail?: string;
}

/** How many to keep. Diagnostics, not history. */
const LIMIT = 60;

const buffer: ProviderAttempt[] = [];

/**
 * Records one attempt.
 *
 * The timestamp is taken HERE from the wall clock rather than from the service's
 * injectable clock. The buffer is process-global and the admin page renders ages
 * against `Date.now()`, so a harness or preview instance running on a fake clock
 * would otherwise write entries dated 1970 (or the year 33658) into the same
 * buffer a real instance reads, and every age and every "since" window would be
 * nonsense.
 */
export function recordAttempt(a: ProviderAttempt): void {
  buffer.push({ ...a, at: Date.now() });
  if (buffer.length > LIMIT) buffer.splice(0, buffer.length - LIMIT);
}

/** Newest first. */
export function recentAttempts(limit = LIMIT): ProviderAttempt[] {
  return buffer.slice(-limit).reverse();
}

/** Only the ones an operator needs to see. */
export function recentFailures(limit = 20): ProviderAttempt[] {
  return buffer
    .filter((a) => a.outcome !== 'ok' && a.outcome !== 'not-found')
    .slice(-limit)
    .reverse();
}

export function clearAttempts(): void {
  buffer.length = 0;
}

/**
 * Classifies a failure into something an operator can act on.
 *
 * The distinction that matters most is `unauthorized`: it is the only outcome
 * that means "you must go and change a setting", and it was previously
 * indistinguishable from a quiet market.
 */
export function classifyFailure(message: string): { outcome: AttemptOutcome; status?: number } {
  const m = message.toLowerCase();
  const statusMatch = /http (\d{3})/.exec(m);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 401 || status === 403) {
    return status !== undefined ? { outcome: 'unauthorized', status } : { outcome: 'unauthorized' };
  }
  if (status === 429) return { outcome: 'throttled', status };
  if (status !== undefined && status >= 500) return { outcome: 'unreachable', status };
  if (status !== undefined) return { outcome: 'bad-response', status };
  if (m.includes('timeout') || m.includes('timed out') || m.includes('abort')) {
    return { outcome: 'unreachable' };
  }
  // Anchored, not substring-matched. `'no '` used to match "no route to host"
  // and "DNS: no answer", and a not-found is EXCLUDED from the failure list and
  // from the health counters — so a real outage showed as zero failures and
  // "last failure: never". These are the exact strings the adapters throw.
  if (m === 'id not priced' || m.startsWith('no ') || m.endsWith('id pinned')) {
    return { outcome: 'not-found' };
  }
  return { outcome: 'unreachable' };
}

/** Per-provider summary for the admin console. */
export interface ProviderHealth {
  provider: string;
  lastOk: number | undefined;
  lastFail: number | undefined;
  lastFailOutcome: AttemptOutcome | undefined;
  lastFailDetail: string | undefined;
  /** Attempts recorded in the buffer, and how many of them succeeded. */
  attempts: number;
  ok: number;
}

export function providerHealth(providers: readonly string[]): ProviderHealth[] {
  return providers.map((provider) => {
    const mine = buffer.filter((a) => a.provider === provider);
    const oks = mine.filter((a) => a.outcome === 'ok');
    const fails = mine.filter((a) => a.outcome !== 'ok' && a.outcome !== 'not-found');
    const lastFail = fails[fails.length - 1];
    const h: ProviderHealth = {
      provider,
      lastOk: oks[oks.length - 1]?.at,
      lastFail: lastFail?.at,
      lastFailOutcome: lastFail?.outcome,
      lastFailDetail: lastFail?.detail,
      attempts: mine.length,
      ok: oks.length,
    };
    return h;
  });
}
