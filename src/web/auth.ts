/**
 * Operator authentication (A3 §2/§3): single account, username from env,
 * Argon2id-hashed password from env. Login attempts are rate-limited per client
 * with a lockout window; failures return a generic message; comparisons are
 * constant-time (username) / Argon2 verification (password).
 */

import { timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import type { AdminConfig } from '../config.js';
import { log } from '../log.js';

/** Max failed attempts per client within the window before lockout. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min

interface FailureState {
  failures: number[];
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly byClient = new Map<string, FailureState>();

  /** True when this client is currently locked out. */
  isLocked(client: string): boolean {
    const s = this.byClient.get(client);
    if (!s) return false;
    if (s.lockedUntil > Date.now()) return true;
    return false;
  }

  recordFailure(client: string): void {
    const now = Date.now();
    const s = this.byClient.get(client) ?? { failures: [], lockedUntil: 0 };
    s.failures = s.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
    s.failures.push(now);
    if (s.failures.length >= MAX_FAILURES) {
      s.lockedUntil = now + LOCKOUT_MS;
      s.failures = [];
      log.warn(`Admin login locked out for client ${client} (too many failures).`);
    }
    this.byClient.set(client, s);
  }

  recordSuccess(client: string): void {
    this.byClient.delete(client);
  }

  /** Prunes stale entries (called opportunistically). */
  prune(): void {
    const now = Date.now();
    for (const [client, s] of this.byClient) {
      if (s.lockedUntil < now && s.failures.every((t) => now - t >= FAILURE_WINDOW_MS)) {
        this.byClient.delete(client);
      }
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Length leak is acceptable for usernames; pad to avoid throwing.
  if (ab.length !== bb.length) {
    // Still burn a comparison so the timing profile stays flat.
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verifies operator credentials. Always runs the Argon2 verification (against a
 * dummy hash when the username is wrong) so response timing does not reveal
 * whether the username exists.
 */
export async function verifyCredentials(
  cfg: Pick<AdminConfig, 'adminUsername' | 'adminPasswordHash'>,
  username: string,
  password: string,
): Promise<boolean> {
  const usernameOk = constantTimeEquals(username, cfg.adminUsername);
  let passwordOk = false;
  try {
    passwordOk = await argon2.verify(cfg.adminPasswordHash, password);
  } catch {
    passwordOk = false;
  }
  return usernameOk && passwordOk;
}
