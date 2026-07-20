/**
 * Cinderella admin console server (A3, hardened per A4).
 *
 * Public, appless: served at the configured hostname over real TLS (nginx →
 * Fastify on 127.0.0.1). Primary auth is passkeys (WebAuthn); an admin-toggleable
 * Argon2id break-glass path remains. Every A4.5 control is enforced here and
 * configured in the console. Fastify never binds a public interface.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import type { AdminConfig, Config } from '../config.js';
import type { Queryable } from '../db/pool.js';
import type { SettingsService } from '../settings/service.js';
import type { SecurityService } from '../security/settings.js';
import { log } from '../log.js';
import { GlobalRateLimiter, LoginRateLimiter } from './auth.js';
import { html, page, setNavItems, type SafeHtml } from './html.js';
import { icon } from './icons.js';
import { applySecurityHeaders } from './security/headers.js';
import { ipAllowed } from './security/access.js';
import { ChallengeStore } from './security/webauthn.js';
import { registerAuthRoutes, STEP_UP_WINDOW_MS } from './security/routes.js';
import { countCredentials } from '../db/webauthn.js';
import { SessionStore, csrfOk, readSession, type AuthedSession } from './session.js';
import { registerPublicEmbed, isEmbedPath } from './front/embed.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: AuthedSession | null;
  }
}

/** Everything routes/views need. Built once in buildServer. */
export interface AdminContext {
  db: Queryable;
  adminCfg: AdminConfig;
  cfg: Config;
  settings: SettingsService;
  security: SecurityService;
  sessions: SessionStore;
  loginLimiter: LoginRateLimiter;
  challenges: ChallengeStore;
}

export interface ViewContext {
  db: Queryable;
  adminCfg: AdminConfig;
  cfg: Config;
  settings: SettingsService;
  security: SecurityService;
  sessions: SessionStore;
}

export interface ServerDeps {
  db: Queryable;
  adminCfg: AdminConfig;
  cfg: Config;
  settings: SettingsService;
  security: SecurityService;
  mediaRoot: string;
  registerViews?: (app: FastifyInstance, ctx: ViewContext) => void;
}

function isMutating(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

/** Sensitive = any state change except logout and the WebAuthn ceremonies. */
function isSensitive(method: string, path: string): boolean {
  if (!isMutating(method)) return false;
  if (path === '/logout') return false;
  if (path.startsWith('/webauthn/')) return false;
  return true;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { db, adminCfg, cfg, settings, security } = deps;
  const app = Fastify({ trustProxy: 'loopback', logger: false });

  const sessions = new SessionStore(db, () => {
    const s = security.get().session;
    return { idleMs: s.idleTimeoutMinutes * 60000, absoluteMs: s.absoluteMaxHours * 3600000 };
  });
  const loginLimiter = new LoginRateLimiter(() => {
    const r = security.get().rateLimit;
    return {
      maxAttempts: r.loginMaxAttempts,
      windowMs: r.loginWindowMinutes * 60000,
      lockoutMs: r.lockoutMinutes * 60000,
    };
  });
  const globalLimiter = new GlobalRateLimiter(() => security.get().rateLimit.globalPerMinute);
  const challenges = new ChallengeStore();

  const ctx: AdminContext = {
    db,
    adminCfg,
    cfg,
    settings,
    security,
    sessions,
    loginLimiter,
    challenges,
  };

  void app.register(fastifyCookie, { secret: adminCfg.sessionSecret });
  void app.register(fastifyFormbody);

  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  void app.register(fastifyStatic, {
    root: join(projectRoot, 'public', 'assets'),
    prefix: '/assets/',
    index: false,
  });
  void app.register(fastifyStatic, {
    root: deps.mediaRoot,
    prefix: '/media/',
    index: false,
    decorateReply: false,
  });

  app.decorateRequest('session', null);

  // Security headers (configurable) on every response — EXCEPT the public archive
  // front, which must be embeddable + indexable and sets its own headers (the
  // admin strict headers are frame-DENY + noindex + no-store).
  app.addHook('onSend', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (isEmbedPath(path)) return;
    applySecurityHeaders(reply, security.get());
  });

  // Global rate limit + IP access policy + session read + auth guard.
  app.addHook('onRequest', async (req, reply) => {
    loginLimiter.prune();
    globalLimiter.prune();
    challenges.prune();

    const path = req.url.split('?')[0] ?? req.url;

    // The public archive front is a public surface: it is exempt from the admin
    // rate limit, the admin IP allow/deny policy, and the auth guard. (A
    // public-appropriate rate limit + caching are the flagged follow-up.)
    const isEmbed = isEmbedPath(path);

    // Global request-rate limit (assets + public front excluded).
    if (!path.startsWith('/assets/') && !isEmbed && !globalLimiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'rate limit exceeded' });
    }

    // Optional IP allow/deny for the ADMIN surface only (health + assets + public
    // front exempt — the public archive must reach everyone).
    if (path !== '/healthz' && !path.startsWith('/assets/') && !isEmbed) {
      const { mode, list } = security.get().ipAccess;
      if (!ipAllowed(req.ip, mode, list)) {
        log.warn(`Blocked admin request from ${req.ip} by IP ${mode}list.`);
        return reply.code(403).send({ error: 'forbidden' });
      }
    }

    req.session = await readSession(req, sessions);

    const isPublic =
      isEmbed ||
      path === '/login' ||
      path === '/healthz' ||
      path === '/favicon.ico' ||
      path.startsWith('/assets/') ||
      path.startsWith('/webauthn/login/');
    if (isPublic || req.session) return;

    if (req.method === 'GET' && !req.headers['hx-request']) {
      return reply.redirect('/login');
    }
    return reply.code(401).send({ error: 'unauthorized' });
  });

  // CSRF + step-up guard on state-changing requests.
  app.addHook('preHandler', async (req, reply) => {
    if (!isMutating(req.method)) return;
    const path = req.url.split('?')[0] ?? req.url;
    if (path === '/login' || path.startsWith('/webauthn/login/')) return; // own guards
    if (!req.session || !csrfOk(req, req.session)) {
      return reply.code(403).send({ error: 'invalid csrf token' });
    }
    // Step-up: sensitive mutations require a fresh passkey re-verification when
    // enabled AND at least one passkey exists (else it would lock out bootstrap).
    if (isSensitive(req.method, path) && security.get().session.stepUpForSensitive) {
      const fresh = Date.now() - req.session.lastStepUpAt <= STEP_UP_WINDOW_MS;
      if (!fresh && (await countCredentials(db)) > 0) {
        reply.header('x-step-up-required', '1');
        return reply.code(403).send({ error: 'step-up required' });
      }
    }
  });

  app.get('/healthz', () => ({ ok: true }));
  // Answer the browser's favicon probe directly so it never 302s through /login
  // (which would rotate the login-CSRF cookie mid-login).
  app.get('/favicon.ico', (_req, reply) => reply.code(204).send());

  // Auth routes (login page, WebAuthn ceremonies, break-glass, logout, step-up).
  registerAuthRoutes(app, ctx);

  // Public archive front (CCB-S2-003) — no auth; consent-gated data + media.
  const viewCtx: ViewContext = { db, adminCfg, cfg, settings, security, sessions };
  registerPublicEmbed(app, viewCtx);

  if (deps.registerViews) {
    deps.registerViews(app, viewCtx);
  } else {
    // Minimal authed landing (used by the foundation harness; production always
    // registers the full views).
    app.get('/', (req, reply) => {
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

export function registerNav(): void {
  setNavItems([
    { key: 'dashboard', href: '/', label: 'Dashboard', icon: icon('dashboard') },
    { key: 'messages', href: '/messages', label: 'Messages', icon: icon('messages') },
    { key: 'consent', href: '/consent', label: 'Consent', icon: icon('consent') },
    { key: 'settings', href: '/settings', label: 'Settings', icon: icon('settings') },
    { key: 'security', href: '/security', label: 'Security', icon: icon('shield') },
    { key: 'embeds', href: '/embeds', label: 'Embeds', icon: icon('embed') },
  ]);
}

/** Convenience re-export for callers that render inside the shell. */
export type { SafeHtml };
export type SecurityHeaderFn = (reply: FastifyReply, req: FastifyRequest) => void;

export async function startAdminServer(deps: ServerDeps): Promise<FastifyInstance> {
  registerNav();
  const app = buildServer(deps);
  // Housekeeping: sweep abandoned expired sessions periodically. get() already
  // evicts on access, so this only reaps sessions never touched again.
  const sweeper = new SessionStore(deps.db, () => {
    const s = deps.security.get().session;
    return { idleMs: s.idleTimeoutMinutes * 60000, absoluteMs: s.absoluteMaxHours * 3600000 };
  });
  const pruneTimer = setInterval(() => void sweeper.prune().catch(() => undefined), 30 * 60 * 1000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  await app.listen({ host: '127.0.0.1', port: deps.adminCfg.adminPort });
  log.info(
    `Admin console listening on 127.0.0.1:${deps.adminCfg.adminPort} (public via nginx TLS).`,
  );
  return app;
}
