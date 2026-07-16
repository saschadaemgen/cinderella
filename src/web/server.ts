/**
 * Cinderella admin console server (A3).
 *
 * Binds to 127.0.0.1 ONLY — nginx terminates TLS and reverse-proxies to this
 * port (deploy/nginx-admin.conf). Treats the network as hostile: single
 * Argon2id-verified operator account, signed HttpOnly/Secure/SameSite=Strict
 * session cookie, login rate limiting, CSRF on every state-changing request,
 * strict security headers, and no secrets ever rendered.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import type { AdminConfig } from '../config.js';
import type { Queryable } from '../db/pool.js';
import { log } from '../log.js';
import { LoginRateLimiter, verifyCredentials } from './auth.js';
import { html, page, setNavItems, type SafeHtml } from './html.js';
import { icon } from './icons.js';
import {
  SessionStore,
  clearSessionCookie,
  csrfOk,
  readSession,
  setSessionCookie,
  type AuthedSession,
} from './session.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: AuthedSession | null;
  }
}

export interface ServerDeps {
  db: Queryable;
  adminCfg: AdminConfig;
  /** Absolute path to the media store (thumbnails). */
  mediaRoot: string;
  /**
   * Registers the admin views (dashboard, messages, …). Kept injectable so the
   * foundation is testable stand-alone.
   */
  registerViews?: (app: FastifyInstance, ctx: ViewContext) => void;
}

export interface ViewContext {
  db: Queryable;
  adminCfg: AdminConfig;
}

const LOGIN_CSRF_COOKIE = 'cinderella_login_csrf';

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function securityHeaders(reply: FastifyReply): void {
  reply.header(
    'content-security-policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
  );
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('cache-control', 'no-store');
}

function loginPage(csrfToken: string, error?: string): string {
  const body: SafeHtml = html`
    <div class="mx-auto mt-12 w-full max-w-sm sm:mt-24">
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 class="mb-1 text-xl font-semibold tracking-tight">🕯️ Cinderella</h1>
        <p class="mb-6 text-sm text-slate-500">Operator console — sign in</p>
        ${
          error
            ? html`<p
                class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                ${error}
              </p>`
            : html``
        }
        <form method="post" action="/login" class="flex flex-col gap-4">
          <input type="hidden" name="_csrf" value="${csrfToken}" />
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-slate-700">Username</span>
            <input
              name="username"
              autocomplete="username"
              required
              class="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-sm font-medium text-slate-700">Password</span>
            <input
              name="password"
              type="password"
              autocomplete="current-password"
              required
              class="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            class="mt-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  `;
  return page({ title: 'Sign in', body, chrome: false });
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, adminCfg } = deps;
  const app = Fastify({ trustProxy: true, logger: false });
  const sessions = new SessionStore();
  const limiter = new LoginRateLimiter();

  void app.register(fastifyCookie, { secret: adminCfg.sessionSecret });
  void app.register(fastifyFormbody);

  // Static assets (Tailwind CSS + htmx), built by `npm run assets`.
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  void app.register(fastifyStatic, {
    root: join(projectRoot, 'public', 'assets'),
    prefix: '/assets/',
    index: false,
  });
  // Media thumbnails — served ONLY behind the auth guard below.
  void app.register(fastifyStatic, {
    root: deps.mediaRoot,
    prefix: '/media/',
    index: false,
    decorateReply: false,
  });

  app.decorateRequest('session', null);

  // --- Security headers on every response ---
  app.addHook('onSend', async (_req, reply) => {
    securityHeaders(reply);
  });

  // --- Auth guard ---
  app.addHook('onRequest', async (req, reply) => {
    sessions.prune();
    limiter.prune();
    req.session = readSession(req, sessions);

    const path = req.url.split('?')[0] ?? req.url;
    const isPublic = path === '/login' || path === '/healthz' || path.startsWith('/assets/');
    if (isPublic || req.session) return;

    if (req.method === 'GET' && !req.headers['hx-request']) {
      return reply.redirect('/login');
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  // --- CSRF guard on every state-changing request (except login itself) ---
  app.addHook('preHandler', async (req, reply) => {
    if (!isMutating(req.method)) return;
    const path = req.url.split('?')[0] ?? req.url;
    if (path === '/login') return; // guarded by the login-CSRF cookie below
    if (!req.session || !csrfOk(req, req.session)) {
      return reply.code(403).send({ error: 'invalid csrf token' });
    }
  });

  // --- Login / logout ---
  app.get('/login', async (req, reply) => {
    if (req.session) return reply.redirect('/');
    // Pre-session CSRF: double-submit via a signed cookie.
    const token = randomBytes(32).toString('hex');
    reply.setCookie(LOGIN_CSRF_COOKIE, token, {
      path: '/login',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      signed: true,
      maxAge: 600,
    });
    reply.type('text/html');
    return loginPage(token);
  });

  app.post('/login', async (req, reply) => {
    reply.type('text/html');
    const client = req.ip;

    if (limiter.isLocked(client)) {
      reply.code(429);
      return loginPage('', 'Too many attempts. Try again later.');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const formToken = typeof body['_csrf'] === 'string' ? body['_csrf'] : '';

    // Login CSRF (double-submit): form token must match the signed cookie.
    const cookieRaw = req.cookies[LOGIN_CSRF_COOKIE];
    const unsigned = cookieRaw
      ? req.unsignCookie(cookieRaw)
      : { valid: false as const, value: null };
    const cookieToken = unsigned.valid && unsigned.value ? unsigned.value : '';
    const tokenOk =
      formToken.length > 0 &&
      cookieToken.length === formToken.length &&
      timingSafeEqual(Buffer.from(formToken), Buffer.from(cookieToken));
    if (!tokenOk) {
      reply.code(403);
      return loginPage('', 'Session expired. Please try again.');
    }

    const ok = await verifyCredentials(adminCfg, username, password);
    if (!ok) {
      limiter.recordFailure(client);
      log.warn(`Failed admin login attempt from ${client}.`);
      reply.code(401);
      // Fresh token for the retry form.
      const retryToken = randomBytes(32).toString('hex');
      reply.setCookie(LOGIN_CSRF_COOKIE, retryToken, {
        path: '/login',
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
        signed: true,
        maxAge: 600,
      });
      return loginPage(retryToken, 'Invalid credentials.');
    }

    limiter.recordSuccess(client);
    reply.clearCookie(LOGIN_CSRF_COOKIE, { path: '/login' });
    const { id } = sessions.create(username);
    setSessionCookie(reply, id);
    log.info(`Admin login: ${username} from ${client}.`);
    return reply.redirect('/');
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) sessions.destroy(req.session.sessionId);
    clearSessionCookie(reply);
    return reply.redirect('/login');
  });

  app.get('/healthz', () => ({ ok: true }));

  // --- Views ---
  if (deps.registerViews) {
    deps.registerViews(app, { db, adminCfg });
  } else {
    app.get('/', async (req, reply) => {
      reply.type('text/html');
      return page({
        title: 'Home',
        active: 'dashboard',
        csrfToken: req.session?.csrfToken ?? '',
        body: html`<h1 class="text-xl font-semibold">Welcome, ${req.session?.username}.</h1>`,
      });
    });
  }

  return app;
}

/** Registers the standard nav (called once before building pages). */
export function registerNav(): void {
  setNavItems([
    { key: 'dashboard', href: '/', label: 'Dashboard', icon: icon('dashboard') },
    { key: 'messages', href: '/messages', label: 'Messages', icon: icon('messages') },
    { key: 'consent', href: '/consent', label: 'Consent', icon: icon('consent') },
    { key: 'settings', href: '/settings', label: 'Settings', icon: icon('settings') },
    { key: 'embeds', href: '/embeds', label: 'Embeds', icon: icon('embed') },
  ]);
}

/** Starts the admin server on 127.0.0.1 (never a public interface — A3 §1). */
export async function startAdminServer(deps: ServerDeps): Promise<FastifyInstance> {
  registerNav();
  const app = buildServer(deps);
  await app.listen({ host: '127.0.0.1', port: deps.adminCfg.adminPort });
  log.info(
    `Admin console listening on 127.0.0.1:${deps.adminCfg.adminPort} (proxy via nginx TLS).`,
  );
  return app;
}
