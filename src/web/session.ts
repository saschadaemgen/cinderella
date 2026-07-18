/**
 * Session + CSRF handling for the admin console (A3 §2/§4, A4.5).
 *
 * Sessions are persisted in PostgreSQL (the `admin_sessions` table) so they
 * SURVIVE service restarts and deploys — previously an in-memory store logged the
 * operator out on every `systemctl restart`. The session id lives in a SIGNED
 * cookie (HMAC with the fixed SESSION_SECRET); cookie flags HttpOnly, Secure,
 * SameSite=Strict, Path=/. Idle timeout is sliding (refreshed each request);
 * there is also an absolute max age. Both are admin-configurable.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db/pool.js';

export const SESSION_COOKIE = 'cinderella_session';

export type AuthMethod = 'passkey' | 'password';

export interface SessionLifetimes {
  idleMs: number;
  absoluteMs: number;
}

interface SessionRow {
  id: string;
  username: string;
  csrf_token: string;
  auth_method: string;
  created_at: string;
  last_seen_at: string;
  last_step_up_at: string | null;
}

export interface SessionData {
  username: string;
  csrfToken: string;
  authMethod: AuthMethod;
  createdAt: number;
  lastSeenAt: number;
  lastStepUpAt: number;
}

function toData(r: SessionRow): SessionData {
  return {
    username: r.username,
    csrfToken: r.csrf_token,
    authMethod: r.auth_method === 'passkey' ? 'passkey' : 'password',
    createdAt: new Date(r.created_at).getTime(),
    lastSeenAt: new Date(r.last_seen_at).getTime(),
    lastStepUpAt: r.last_step_up_at ? new Date(r.last_step_up_at).getTime() : 0,
  };
}

export class SessionStore {
  constructor(
    private readonly db: Queryable,
    private readonly lifetimes: () => SessionLifetimes,
  ) {}

  async create(
    username: string,
    authMethod: AuthMethod,
  ): Promise<{ id: string; csrfToken: string }> {
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    // A passkey login is itself a fresh step-up; a password login is not.
    const stepUp = authMethod === 'passkey' ? 'now()' : 'NULL';
    await this.db.query(
      `INSERT INTO admin_sessions (id, username, csrf_token, auth_method, last_step_up_at)
       VALUES ($1, $2, $3, $4, ${stepUp})`,
      [id, username, csrfToken, authMethod],
    );
    return { id, csrfToken };
  }

  /** Returns the session if valid (and refreshes its idle timer); else null. */
  async get(id: string): Promise<SessionData | null> {
    const { rows } = await this.db.query<SessionRow>(`SELECT * FROM admin_sessions WHERE id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (!row) return null;
    const data = toData(row);
    const now = Date.now();
    const { idleMs, absoluteMs } = this.lifetimes();
    if (now - data.lastSeenAt > idleMs || now - data.createdAt > absoluteMs) {
      await this.db.query(`DELETE FROM admin_sessions WHERE id = $1`, [id]);
      return null;
    }
    // Sliding idle expiry.
    await this.db.query(`UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1`, [id]);
    data.lastSeenAt = now;
    return data;
  }

  async markStepUp(id: string): Promise<void> {
    await this.db.query(`UPDATE admin_sessions SET last_step_up_at = now() WHERE id = $1`, [id]);
  }

  async destroy(id: string): Promise<void> {
    await this.db.query(`DELETE FROM admin_sessions WHERE id = $1`, [id]);
  }

  /** Single-session policy: drop every session except the given one. */
  async destroyOthers(exceptId: string): Promise<number> {
    const { rowCount } = await this.db.query(`DELETE FROM admin_sessions WHERE id <> $1`, [
      exceptId,
    ]);
    return rowCount ?? 0;
  }

  async count(): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(`SELECT count(*) AS n FROM admin_sessions`);
    return Number(rows[0]?.n ?? 0);
  }

  /** Removes expired sessions (called opportunistically). */
  async prune(): Promise<void> {
    const { idleMs, absoluteMs } = this.lifetimes();
    await this.db.query(
      `DELETE FROM admin_sessions
       WHERE now() - last_seen_at > ($1 || ' milliseconds')::interval
          OR now() - created_at   > ($2 || ' milliseconds')::interval`,
      [String(idleMs), String(absoluteMs)],
    );
  }
}

export interface AuthedSession {
  sessionId: string;
  username: string;
  csrfToken: string;
  authMethod: AuthMethod;
  lastStepUpAt: number;
}

export async function readSession(
  req: FastifyRequest,
  store: SessionStore,
): Promise<AuthedSession | null> {
  const rawCookie = req.cookies[SESSION_COOKIE];
  if (!rawCookie) return null;
  const unsigned = req.unsignCookie(rawCookie);
  if (!unsigned.valid || !unsigned.value) return null;
  const session = await store.get(unsigned.value);
  if (!session) return null;
  return {
    sessionId: unsigned.value,
    username: session.username,
    csrfToken: session.csrfToken,
    authMethod: session.authMethod,
    lastStepUpAt: session.lastStepUpAt,
  };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string, maxAgeMs: number): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function requestCsrfToken(req: FastifyRequest): string | null {
  const header = req.headers['x-csrf-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const body: unknown = req.body;
  if (body && typeof body === 'object' && '_csrf' in body) {
    const field = (body as Record<string, unknown>)['_csrf'];
    if (typeof field === 'string' && field.length > 0) return field;
  }
  return null;
}

export function csrfOk(req: FastifyRequest, session: AuthedSession): boolean {
  const token = requestCsrfToken(req);
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(session.csrfToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
