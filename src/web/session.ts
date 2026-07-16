/**
 * Session + CSRF handling for the admin console (A3 §2/§4).
 *
 * Design: server-side in-memory session store keyed by a random 256-bit id,
 * carried in a SIGNED cookie (@fastify/cookie, HMAC with SESSION_SECRET).
 * Cookie flags: HttpOnly, Secure, SameSite=Strict, Path=/.
 *
 * A single operator account means an in-memory store is appropriate: sessions
 * simply require a fresh login after a process restart.
 *
 * CSRF: a per-session random token, embedded in every form (`_csrf` field) and
 * exposed to htmx via a request header. Every state-changing request must carry
 * a token matching the session's (constant-time comparison).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'cinderella_session';

/** Idle timeout: sessions expire after this long without a request. */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12h

interface SessionData {
  username: string;
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  create(username: string): { id: string; csrfToken: string } {
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const now = Date.now();
    this.sessions.set(id, { username, csrfToken, createdAt: now, lastSeenAt: now });
    return { id, csrfToken };
  }

  /** Returns the session for an id, refreshing its idle timer; null if invalid/expired. */
  get(id: string): SessionData | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = Date.now();
    if (now - s.lastSeenAt > SESSION_IDLE_MS) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeenAt = now;
    return s;
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  /** Removes expired sessions (called opportunistically). */
  prune(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > SESSION_IDLE_MS) this.sessions.delete(id);
    }
  }
}

export interface AuthedSession {
  sessionId: string;
  username: string;
  csrfToken: string;
}

/** Reads and validates the signed session cookie. Null when not authenticated. */
export function readSession(req: FastifyRequest, store: SessionStore): AuthedSession | null {
  const rawCookie = req.cookies[SESSION_COOKIE];
  if (!rawCookie) return null;
  const unsigned = req.unsignCookie(rawCookie);
  if (!unsigned.valid || !unsigned.value) return null;
  const session = store.get(unsigned.value);
  if (!session) return null;
  return { sessionId: unsigned.value, username: session.username, csrfToken: session.csrfToken };
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
    maxAge: SESSION_IDLE_MS / 1000,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Extracts the CSRF token from a request: the `_csrf` form field or the
 * `x-csrf-token` header (used by htmx via hx-headers).
 */
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

/** True when the request carries a CSRF token matching the session's. */
export function csrfOk(req: FastifyRequest, session: AuthedSession): boolean {
  const token = requestCsrfToken(req);
  if (!token) return false;
  return constantTimeEquals(token, session.csrfToken);
}
