/**
 * Write-only secret storage for plugin settings (CCB-S3-004 §7).
 *
 * Provider API keys are the operator's property and a liability if leaked. The
 * rules this module enforces:
 *
 *  - **Encrypted at rest.** The `settings` table is a plain JSONB store that ends
 *    up in every database backup; a key sitting there in clear would be in every
 *    copy of that backup too.
 *  - **Never rendered back.** The admin form shows whether a key is SET, not what
 *    it is. Submitting the form without touching the field leaves the stored key
 *    alone; clearing it is an explicit, separate act.
 *  - **Never logged.** Nothing here returns a decrypted value except
 *    {@link decryptSecret}, which is called only at the moment a request is
 *    built. {@link describeSecret} is what everything else uses.
 *
 * The encryption key is derived from `SESSION_SECRET` (already required, already
 * `0600` root-owned in production) with scrypt and a fixed, non-secret info
 * string. Deriving rather than reusing means the stored ciphertext is not
 * decryptable with the session secret alone, and it avoids asking the operator to
 * manage a second secret for a third-party read-only key. The consequence, worth
 * stating plainly: rotating `SESSION_SECRET` makes stored plugin keys
 * undecryptable and they must be re-entered.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { log } from '../log.js';

const ALGO = 'aes-256-gcm';
const VERSION = 'v1';
/** Fixed and non-secret: it separates this key from any other use of the secret. */
const SALT = 'cinderella/plugin-secrets/v1';

let cachedKey: Buffer | undefined;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env['SESSION_SECRET'];
  if (!secret) {
    throw new Error('SESSION_SECRET is required to store plugin secrets.');
  }
  cachedKey = scryptSync(secret, SALT, 32);
  return cachedKey;
}

/** Test hook — forget the derived key (e.g. after changing the env in a harness). */
export function resetSecretKey(): void {
  cachedKey = undefined;
}

/**
 * Encrypts a secret for storage. The result is opaque and safe to keep in the
 * settings JSON: `v1.<iv>.<tag>.<ciphertext>`, all base64url.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ct.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a stored secret. Returns '' when there is nothing stored or the value
 * cannot be decrypted — a wrong key must degrade to "no key configured", not to
 * a crash in the middle of answering a member.
 */
export function decryptSecret(stored: string): string {
  if (!stored) return '';
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) return '';
  try {
    const decipher = createDecipheriv(ALGO, key(), Buffer.from(parts[1] as string, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2] as string, 'base64url'));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(parts[3] as string, 'base64url')),
      decipher.final(),
    ]);
    return pt.toString('utf8');
  } catch {
    // Deliberately no detail: a decryption failure must not describe the value.
    log.warn('A stored plugin secret could not be decrypted; treating it as unset.');
    return '';
  }
}

/** True when a secret is present and decryptable. */
export function hasSecret(stored: string): boolean {
  return decryptSecret(stored) !== '';
}

/**
 * What the admin console is allowed to see. Never the value — only whether one
 * is set and, at most, its length, which is enough for an operator to tell a
 * pasted key from a pasted newline.
 */
export function describeSecret(stored: string): { set: boolean; length: number } {
  const v = decryptSecret(stored);
  return { set: v !== '', length: v.length };
}

/**
 * Applies a form submission to a stored secret.
 *
 * - `clear` wins: the key is removed.
 * - A non-empty submitted value replaces it.
 * - An EMPTY submitted value leaves the existing key untouched, which is what
 *   makes the field write-only: the form can be saved repeatedly without the
 *   operator having to re-paste the key each time.
 */
export function applySecretUpdate(current: string, submitted: string, clear: boolean): string {
  if (clear) return '';
  const v = submitted.trim();
  if (!v) return current;
  return encryptSecret(v);
}
