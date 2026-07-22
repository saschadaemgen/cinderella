/**
 * The single write path for a consent decision (CCB-S3-002).
 *
 * `/publish` and `Cinderella, publish me` must be the SAME decision recorded the
 * same way — the only difference being the `source` stamped on it. Routing both
 * through here means the natural-language layer cannot drift from the slash
 * command, and it is why the interaction engine holds no consent SQL of its own:
 * it decides what the member meant, this decides what that does to the database.
 *
 * Each change captures the consent row as it stood beforehand and journals it,
 * which is what makes {@link undoLastConsentAction} able to put things back
 * exactly (see `db/consent-actions.ts`).
 */

import { recordOptIn, recordOptOut } from '../db/consent.js';
import {
  journalConsentAction,
  readConsentState,
  type ConsentAction,
  type ConsentSource,
} from '../db/consent-actions.js';
import type { Queryable } from '../db/pool.js';

export interface ConsentChange {
  memberId: string;
  /** Group-message timestamp of the triggering message (ISO 8601). */
  at: string;
  action: ConsentAction;
  source: ConsentSource;
}

export interface ConsentChangeResult {
  /** For an opt-out: whether there was an active consent to revoke. */
  hadActive: boolean;
}

/**
 * Applies a consent decision and journals what it replaced. Consent is always
 * first-person — the caller passes the member id of whoever sent the message,
 * and there is no parameter here for acting on somebody else's behalf.
 */
export async function applyConsentChange(
  db: Queryable,
  change: ConsentChange,
): Promise<ConsentChangeResult> {
  const prior = await readConsentState(db, change.memberId);

  let hadActive = false;
  if (change.action === 'opt_in') {
    await recordOptIn(db, change.memberId, change.at);
    hadActive = prior.existed && prior.revokedAt === null;
  } else {
    hadActive = await recordOptOut(db, change.memberId, change.at);
  }

  await journalConsentAction(db, {
    memberId: change.memberId,
    action: change.action,
    source: change.source,
    at: change.at,
    prior,
  });

  return { hadActive };
}
