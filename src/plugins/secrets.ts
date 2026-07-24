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
 * What the admin console is allowed to see. Never the value — only whether one is
 * set, at most its length, and (the CCB-S3-023 distinction) whether a value IS
 * stored but cannot be decrypted. "Nothing stored" (a choice) and "stored but
 * unusable" (a fault, e.g. a rotated SESSION_SECRET) used to be indistinguishable
 * here, so the console showed "no key" for a key that was actually present but
 * dead. They are now separate states.
 */
export function describeSecret(stored: string): {
  set: boolean;
  length: number;
  undecryptable: boolean;
} {
  if (!stored) return { set: false, length: 0, undecryptable: false };
  const v = decryptSecret(stored);
  // Something IS stored, but it did not decrypt (rotated secret, or corruption).
  if (v === '') return { set: true, length: 0, undecryptable: true };
  return { set: true, length: v.length, undecryptable: false };
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
  // Encrypt unconditionally, INCLUDING a submitted value that happens to look
  // like an envelope. The double-encryption defect is prevented structurally now
  // (a stored key never arrives here — it comes in under `apiKey`, a typed one
  // under `apiKeyInput`), so the only thing that can reach this line is something
  // an operator typed. Passing such a value through unencrypted to "avoid double
  // encryption" would put a live credential in the settings table in clear, which
  // is the failure this module exists to prevent — and a wrongly doubled key is
  // recoverable by `repairSecret`, whereas a leaked one is not.
  return encryptSecret(v);
}

/**
 * Does this look like something {@link encryptSecret} produced?
 *
 * This exists because of a live defect worth remembering (CCB-S3-008 §2).
 * `PluginService.load()` passes the STORED settings back through the same
 * normalizer the admin form uses, and the normalizer treated `apiKey` as a
 * freshly typed key. So every boot wrapped the stored ciphertext in another
 * layer, and the runtime — which decrypts exactly once — handed the provider an
 * envelope instead of a key. The operator's keys had never once worked, and the
 * only symptom was "the markets are out of earshot".
 *
 * The structural fix is that a submitted key now arrives under its own field
 * name (`apiKeyInput`), so storage shape and form shape are no longer the same
 * field. This check is the belt to that pair of braces, and it is what lets an
 * instance that already has doubled keys heal itself.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts[0] === VERSION;
}

/**
 * Unwraps a value that was encrypted more than once, returning the real
 * plaintext and how many layers had to come off.
 *
 * Used to repair instances written by the buggy path. Bounded, because a
 * plaintext that merely LOOKS like an envelope must not send this spinning.
 */
export function unwrapSecret(stored: string): { value: string; layers: number } {
  let value = stored;
  let layers = 0;
  while (layers < 8 && isEncrypted(value)) {
    const inner = decryptSecret(value);
    if (!inner) break;
    value = inner;
    layers++;
  }
  return { value, layers };
}

/**
 * Re-encrypts a stored secret so it carries exactly ONE layer. Returns null when
 * nothing needed repairing, so the caller can tell whether to write anything —
 * and can say so in a log line without ever naming the value.
 */
export function repairSecret(stored: string): string | null {
  if (!stored || !isEncrypted(stored)) return null;
  const { value, layers } = unwrapSecret(stored);
  if (layers <= 1 || !value) return null;
  // If what came out is STILL an envelope, unwrapping did not finish — either it
  // hit the bound, or an inner layer will not decrypt (a rotated SESSION_SECRET).
  // Re-encrypting that would store an unusable credential while telling the
  // operator it had been repaired, which is worse than leaving it alone.
  if (isEncrypted(value)) return null;
  return encryptSecret(value);
}

/**
 * How many layers of encryption a stored value carries. 0 for something that was
 * never encrypted, 1 for a healthy secret, more for one written by the doubled
 * path. Callers use this to decide whether to REWRITE the setting — comparing
 * ciphertext strings cannot, because every encryption uses a fresh IV and so
 * every comparison would differ.
 */
export function secretLayers(stored: string): number {
  return unwrapSecret(stored).layers;
}
