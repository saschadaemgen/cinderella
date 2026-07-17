/**
 * WebAuthn credential + break-glass TOTP persistence (Addendum 4 / A4.3, A4.4).
 */

import type { Queryable } from './pool.js';

export interface StoredCredential {
  id: number;
  credentialId: string; // base64url
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  aaguid: string | null;
  name: string;
  backedUp: boolean;
  deviceType: string | null;
  locked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

interface CredRow {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  aaguid: string | null;
  name: string;
  backed_up: boolean;
  device_type: string | null;
  locked: boolean;
  created_at: string;
  last_used_at: string | null;
}

function toCred(r: CredRow): StoredCredential {
  return {
    id: Number(r.id),
    credentialId: r.credential_id,
    publicKey: new Uint8Array(r.public_key),
    counter: Number(r.counter),
    transports: r.transports,
    aaguid: r.aaguid,
    name: r.name,
    backedUp: r.backed_up,
    deviceType: r.device_type,
    locked: r.locked,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export async function listCredentials(db: Queryable): Promise<StoredCredential[]> {
  const { rows } = await db.query<CredRow>(
    `SELECT * FROM webauthn_credentials ORDER BY created_at`,
  );
  return rows.map(toCred);
}

export async function countCredentials(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM webauthn_credentials WHERE locked = FALSE`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function getCredentialById(
  db: Queryable,
  credentialId: string,
): Promise<StoredCredential | null> {
  const { rows } = await db.query<CredRow>(
    `SELECT * FROM webauthn_credentials WHERE credential_id = $1`,
    [credentialId],
  );
  return rows[0] ? toCred(rows[0]) : null;
}

export interface NewCredential {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  aaguid: string | null;
  name: string;
  backedUp: boolean;
  deviceType: string | null;
}

export async function insertCredential(db: Queryable, c: NewCredential): Promise<void> {
  await db.query(
    `INSERT INTO webauthn_credentials
       (credential_id, public_key, counter, transports, aaguid, name, backed_up, device_type)
     VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8)`,
    [
      c.credentialId,
      Buffer.from(c.publicKey),
      c.counter,
      c.transports,
      c.aaguid,
      c.name,
      c.backedUp,
      c.deviceType,
    ],
  );
}

export async function updateCredentialCounter(
  db: Queryable,
  credentialId: string,
  counter: number,
): Promise<void> {
  await db.query(
    `UPDATE webauthn_credentials SET counter = $2, last_used_at = now() WHERE credential_id = $1`,
    [credentialId, counter],
  );
}

export async function lockCredential(db: Queryable, credentialId: string): Promise<void> {
  await db.query(`UPDATE webauthn_credentials SET locked = TRUE WHERE credential_id = $1`, [
    credentialId,
  ]);
}

export async function renameCredential(db: Queryable, id: number, name: string): Promise<boolean> {
  const { rowCount } = await db.query(`UPDATE webauthn_credentials SET name = $2 WHERE id = $1`, [
    id,
    name.slice(0, 80),
  ]);
  return (rowCount ?? 0) > 0;
}

export async function deleteCredential(db: Queryable, id: number): Promise<boolean> {
  const { rowCount } = await db.query(`DELETE FROM webauthn_credentials WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

// --- Break-glass TOTP ---

export interface TotpState {
  secret: string;
  enabled: boolean;
}

export async function getTotp(db: Queryable): Promise<TotpState | null> {
  const { rows } = await db.query<{ secret: string; enabled: boolean }>(
    `SELECT secret, enabled FROM admin_totp WHERE id = TRUE`,
  );
  return rows[0] ?? null;
}

export async function setTotpSecret(db: Queryable, secret: string): Promise<void> {
  await db.query(
    `INSERT INTO admin_totp (id, secret, enabled) VALUES (TRUE, $1, FALSE)
     ON CONFLICT (id) DO UPDATE SET secret = EXCLUDED.secret, enabled = FALSE, created_at = now()`,
    [secret],
  );
}

export async function setTotpEnabled(db: Queryable, enabled: boolean): Promise<void> {
  await db.query(`UPDATE admin_totp SET enabled = $1 WHERE id = TRUE`, [enabled]);
}
