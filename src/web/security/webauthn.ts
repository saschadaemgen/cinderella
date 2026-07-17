/**
 * WebAuthn / passkey ceremonies (Addendum 4 / A4.3), native via
 * @simplewebauthn/server. Passwordless, usernameless discoverable-credential
 * login is the primary factor; the Argon2id password is a break-glass path.
 *
 * Challenges are held server-side in a short-lived in-memory store keyed by a
 * random id carried in a signed cookie — works for both the pre-session login
 * ceremony and the authenticated registration ceremony.
 */

import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AdminConfig } from '../../config.js';
import type { Queryable } from '../../db/pool.js';
import { writeAudit } from '../../db/audit.js';
import {
  getCredentialById,
  insertCredential,
  listCredentials,
  lockCredential,
  updateCredentialCounter,
  type StoredCredential,
} from '../../db/webauthn.js';
import type { SecuritySettings } from '../../security/settings.js';
import { log } from '../../log.js';

export interface RpConfig {
  rpID: string;
  rpName: string;
  origin: string;
}

export function rpConfig(cfg: AdminConfig): RpConfig {
  return { rpID: cfg.rpId, rpName: cfg.rpName, origin: cfg.webauthnOrigin };
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

interface ChallengeEntry {
  challenge: string;
  purpose: 'register' | 'login';
  createdAt: number;
}

/** Short-lived challenge store (in-memory, single process). */
export class ChallengeStore {
  private readonly map = new Map<string, ChallengeEntry>();

  put(challenge: string, purpose: 'register' | 'login'): string {
    const id = randomBytes(24).toString('hex');
    this.map.set(id, { challenge, purpose, createdAt: Date.now() });
    return id;
  }

  take(id: string, purpose: 'register' | 'login'): string | null {
    const e = this.map.get(id);
    if (!e) return null;
    this.map.delete(id);
    if (e.purpose !== purpose) return null;
    if (Date.now() - e.createdAt > CHALLENGE_TTL_MS) return null;
    return e.challenge;
  }

  prune(): void {
    const now = Date.now();
    for (const [id, e] of this.map) {
      if (now - e.createdAt > CHALLENGE_TTL_MS) this.map.delete(id);
    }
  }
}

/**
 * The cloned-authenticator signal: a valid assertion whose signature counter did
 * not advance. Mirrors @simplewebauthn's own check (which throws on the live
 * path, caught in completeAuthentication to lock + audit). Exported for tests.
 */
export function isCounterRegression(storedCounter: number, newCounter: number): boolean {
  return (newCounter > 0 || storedCounter > 0) && newCounter <= storedCounter;
}

/** attestationType for the library (it supports none/direct/enterprise, not indirect). */
function attestationType(a: SecuritySettings['passkey']['attestation']): 'none' | 'direct' {
  return a === 'direct' ? 'direct' : 'none';
}

export async function buildRegistrationOptions(
  db: Queryable,
  cfg: AdminConfig,
  sec: SecuritySettings,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const rp = rpConfig(cfg);
  const existing = await listCredentials(db);
  return generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpID,
    userName: cfg.adminUsername,
    userID: new TextEncoder().encode(cfg.adminUsername),
    attestationType: attestationType(sec.passkey.attestation),
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      residentKey: sec.passkey.residentKey,
      userVerification: sec.passkey.userVerification,
      requireResidentKey: sec.passkey.residentKey === 'required',
    },
  });
}

export interface RegistrationResult {
  ok: boolean;
  error?: string;
}

export async function completeRegistration(
  db: Queryable,
  cfg: AdminConfig,
  sec: SecuritySettings,
  expectedChallenge: string,
  response: RegistrationResponseJSON,
  name: string,
  actor: string,
): Promise<RegistrationResult> {
  const rp = rpConfig(cfg);
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: sec.passkey.userVerification === 'required',
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'verification failed' };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { ok: false, error: 'registration could not be verified' };
  }
  const info = verification.registrationInfo;
  const aaguid = info.aaguid || null;

  // Enforce the AAGUID allowlist if configured.
  if (
    sec.passkey.allowedAaguids.length > 0 &&
    (!aaguid || !sec.passkey.allowedAaguids.includes(aaguid.toLowerCase()))
  ) {
    await writeAudit(db, actor, 'passkey.register_rejected', `aaguid:${aaguid ?? 'unknown'}`, {
      reason: 'aaguid not in allowlist',
    });
    return { ok: false, error: 'This authenticator model is not on the allowlist.' };
  }

  await insertCredential(db, {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (info.credential.transports as string[] | undefined) ?? [],
    aaguid,
    name: name.trim().slice(0, 80) || 'passkey',
    backedUp: info.credentialBackedUp,
    deviceType: info.credentialDeviceType,
  });
  await writeAudit(
    db,
    actor,
    'passkey.register',
    `credential:${info.credential.id.slice(0, 12)}…`,
    {
      name,
      aaguid,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    },
  );
  return { ok: true };
}

export function buildAuthenticationOptions(
  cfg: AdminConfig,
  sec: SecuritySettings,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const rp = rpConfig(cfg);
  // Usernameless: empty allowCredentials lets the user pick any resident key.
  return generateAuthenticationOptions({
    rpID: rp.rpID,
    userVerification: sec.passkey.userVerification,
    allowCredentials: [],
  });
}

export interface AuthResult {
  ok: boolean;
  credential?: StoredCredential;
  reason?: 'unknown-credential' | 'locked' | 'counter-regression' | 'verification-failed';
}

export async function completeAuthentication(
  db: Queryable,
  cfg: AdminConfig,
  sec: SecuritySettings,
  expectedChallenge: string,
  response: AuthenticationResponseJSON,
): Promise<AuthResult> {
  const rp = rpConfig(cfg);
  const stored = await getCredentialById(db, response.id);
  if (!stored) return { ok: false, reason: 'unknown-credential' };
  if (stored.locked) return { ok: false, reason: 'locked' };

  try {
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: sec.passkey.userVerification === 'required',
      credential: {
        id: stored.credentialId,
        // Copy via the ArrayLike overload so the buffer type is ArrayBuffer (not
        // the ArrayBufferLike a Node Buffer carries) — required by the lib types.
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports as never,
      },
    });
    if (!verification.verified) return { ok: false, reason: 'verification-failed' };
    await updateCredentialCounter(
      db,
      stored.credentialId,
      verification.authenticationInfo.newCounter,
    );
    return { ok: true, credential: stored };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A valid assertion whose counter regressed is a cloned-authenticator signal.
    if (/counter value/i.test(msg)) {
      await lockCredential(db, stored.credentialId);
      await writeAudit(
        db,
        'system',
        'passkey.counter_regression',
        `credential:${stored.credentialId.slice(0, 12)}…`,
        {
          storedCounter: stored.counter,
          message: msg,
        },
      );
      log.error(
        `Passkey counter regression — credential locked (${stored.credentialId.slice(0, 12)}…).`,
      );
      return { ok: false, reason: 'counter-regression' };
    }
    return { ok: false, reason: 'verification-failed' };
  }
}
