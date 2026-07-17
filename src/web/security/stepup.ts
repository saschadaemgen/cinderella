/**
 * Whether the current session must pass a passkey step-up before a sensitive
 * action (A4.5). Mirrors the server-side enforcement in the preHandler so the
 * UI can prompt proactively. Never requires step-up when no passkeys exist (so
 * break-glass bootstrap is not locked out).
 */

import { countCredentials } from '../../db/webauthn.js';
import type { ViewContext } from '../server.js';
import type { AuthedSession } from '../session.js';
import { STEP_UP_WINDOW_MS } from './routes.js';

export async function needsStepUp(
  ctx: Pick<ViewContext, 'db' | 'security'>,
  session: AuthedSession | null,
): Promise<boolean> {
  if (!session) return false;
  if (!ctx.security.get().session.stepUpForSensitive) return false;
  if (Date.now() - session.lastStepUpAt <= STEP_UP_WINDOW_MS) return false;
  return (await countCredentials(ctx.db)) > 0;
}
