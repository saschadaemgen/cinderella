/**
 * Session + CSRF handling for the admin console (A3 §2/§4, extended in A4.5).
 *
 * Server-side session store keyed by a random 256-bit id carried in a SIGNED
 * cookie (HMAC with SESSION_SECRET); cookie flags HttpOnly, Secure,
 * SameSite=Strict, Path=/. Idle + absolute lifetimes are admin-configurable.
 * Tracks the auth method (passkey/password) and the last passkey step-up, and
 * supports a single-session (log-out-others) policy.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE = 'cinderella_session';

export type AuthMethod = 'passkey' | 'password';

export interface SessionLifetimes {
  idleMs: number;
  absoluteMs: number;
}

interface SessionData {
  username: string;
  csrfToken: string;
  authMethod: AuthMethod;
  createdAt: number;
  lastSeenAt: number;
  /** Last time a passkey step-up succeeded (passkey login counts). */
  lastStepUpAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionData>();

  constructor(private readonly lifetimes: () => SessionLifetimes) {}

  create(username: string, authMethod: AuthMethod): { id: string; csrfToken: string } {
    const id = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const now = Date.now();
    this.sessions.set(id, {
      username,
      csrfToken,
      authMethod,
      createdAt: now,
      lastSeenAt: now,
      // A passkey login is itself a fresh step-up; a password login is not.
      lastStepUpAt: authMethod === 'passkey' ? now : 0,
    });
    return { id, csrfToken };
  }

  get(id: string): SessionData | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const now = Date.now();
    const { idleMs, absoluteMs } = this.lifetimes();
    if (now - s.lastSeenAt > idleMs || now - s.createdAt > absoluteMs) {
      this.sessions.delete(id);
      return null;
    }
    s.lastSeenAt = now;
    return s;
  }

  markStepUp(id: string): void {
    const s = this.sessions.get(id);
    if (s) s.lastStepUpAt = Date.now();
  }

  destroy(id: string): void {
    this.sessions.delete(id);
  }

  /** Single-session policy: drop every session except the given one. */
  destroyOthers(exceptId: string): number {
    let n = 0;
    for (const id of [...this.sessions.keys()]) {
      if (id !== exceptId) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }

  count(): number {
    return this.sessions.size;
  }

  prune(): void {
    const now = Date.now();
    const { idleMs, absoluteMs } = this.lifetimes();
    for (const [id, s] of this.sessions) {
      if (now - s.lastSeenAt > idleMs || now - s.createdAt > absoluteMs) this.sessions.delete(id);
    }
  }
}

export interface AuthedSession {
  sessionId: string;
  username: string;
  csrfToken: string;
  authMethod: AuthMethod;
  lastStepUpAt: number;
}

export function readSession(req: FastifyRequest, store: SessionStore): AuthedSession | null {
  const rawCookie = req.cookies[SESSION_COOKIE];
  if (!rawCookie) return null;
  const unsigned = req.unsignCookie(rawCookie);
  if (!unsigned.valid || !unsigned.value) return null;
  const session = store.get(unsigned.value);
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

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
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
  return constantTimeEquals(token, session.csrfToken);
}
