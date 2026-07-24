/**
 * Break-glass password authentication + rate limiting (A3 §2/§3, A4.5).
 *
 * The password path is a configurable break-glass fallback (A4.4). Passkeys are
 * the primary factor. Login attempts are rate-limited per client with a lockout;
 * thresholds are admin-configurable. Optional TOTP second factor on the password
 * path. A separate global request-rate limiter can be enabled.
 */

import { timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import type { AdminConfig } from '../config.js';
import { log } from '../log.js';

export interface RateLimitConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

interface FailureState {
  failures: number[];
  lockedUntil: number;
}

/** Per-client login failure tracker with configurable lockout. */
export class LoginRateLimiter {
  private readonly byClient = new Map<string, FailureState>();

  constructor(private readonly cfg: () => RateLimitConfig) {}

  isLocked(client: string): boolean {
    const s = this.byClient.get(client);
    return s ? s.lockedUntil > Date.now() : false;
  }

  recordFailure(client: string): boolean {
    const { maxAttempts, windowMs, lockoutMs } = this.cfg();
    const now = Date.now();
    const s = this.byClient.get(client) ?? { failures: [], lockedUntil: 0 };
    s.failures = s.failures.filter((t) => now - t < windowMs);
    s.failures.push(now);
    let lockedNow = false;
    if (s.failures.length >= maxAttempts) {
      s.lockedUntil = now + lockoutMs;
      s.failures = [];
      lockedNow = true;
      log.warn(`Admin login locked out for client ${client} (too many failures).`);
    }
    this.byClient.set(client, s);
    return lockedNow;
  }

  recordSuccess(client: string): void {
    this.byClient.delete(client);
  }

  prune(): void {
    const now = Date.now();
    const { windowMs } = this.cfg();
    for (const [client, s] of this.byClient) {
      if (s.lockedUntil < now && s.failures.every((t) => now - t >= windowMs)) {
        this.byClient.delete(client);
      }
    }
  }
}

/** Optional global per-client request-rate limiter (fixed 60s window). */
export class GlobalRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly perMinute: () => number) {}

  /** Returns true if the request is allowed. `0` per-minute disables the limiter. */
  allow(client: string): boolean {
    const limit = this.perMinute();
    if (limit <= 0) return true;
    const now = Date.now();
    const arr = (this.hits.get(client) ?? []).filter((t) => now - t < 60000);
    arr.push(now);
    this.hits.set(client, arr);
    return arr.length <= limit;
  }

  prune(): void {
    const now = Date.now();
    for (const [client, arr] of this.hits) {
      const kept = arr.filter((t) => now - t < 60000);
      if (kept.length === 0) this.hits.delete(client);
      else this.hits.set(client, kept);
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verifies operator password credentials. Always runs Argon2 verification (even
 * for a wrong username, against the real hash) so timing does not reveal whether
 * the username exists.
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
  } catch (err) {
    // Keep the fail-closed deny, but make a MALFORMED stored hash diagnosable: a
    // verify throw (a corrupt ADMIN_PASSWORD_HASH) otherwise reads exactly like a
    // wrong password, so break-glass recovery looks like a typo (CCB-S3-023).
    passwordOk = false;
    log.error(
      `Break-glass password verification threw (is ADMIN_PASSWORD_HASH a valid Argon2id hash?): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return usernameOk && passwordOk;
}

/** Verifies a TOTP token against a base32 secret (±1 step tolerance). */
export function verifyTotp(secret: string, token: string): boolean {
  try {
    authenticator.options = { window: 1 };
    return authenticator.verify({ token: token.replace(/\s+/g, ''), secret });
  } catch (err) {
    // A malformed stored secret otherwise reads as a wrong code (CCB-S3-023).
    log.warn(
      `TOTP verification threw (malformed secret or token): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export function newTotpSecret(): string {
  return authenticator.generateSecret();
}

export function totpKeyUri(secret: string, account: string, issuer: string): string {
  return authenticator.keyuri(account, issuer, secret);
}
