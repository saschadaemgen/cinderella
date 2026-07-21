/**
 * Authentication routes (Addendum 4): passkey-first login page, WebAuthn
 * ceremonies (login / register / step-up), the admin-toggleable Argon2id
 * break-glass path (optional TOTP), logout. All security events are audited.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { AdminContext } from '../server.js';
import { verifyCredentials, verifyTotp } from '../auth.js';
import { writeAudit } from '../../db/audit.js';
import { countCredentials, getTotp } from '../../db/webauthn.js';
import { html, page, type SafeHtml } from '../html.js';
import { clearSessionCookie, setSessionCookie, type AuthMethod } from '../session.js';
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  completeAuthentication,
  completeRegistration,
} from './webauthn.js';
import { alertSecurityEvent } from './alert.js';

/** How long a passkey step-up stays valid for sensitive actions. */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

const WA_COOKIE = 'cinderella_wa';
const LOGIN_CSRF_COOKIE = 'cinderella_login_csrf';

function setChallengeCookie(reply: FastifyReply, id: string): void {
  reply.setCookie(WA_COOKIE, id, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
    maxAge: 300,
  });
}

function readChallengeCookie(req: FastifyRequest): string | null {
  const raw = req.cookies[WA_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  return u.valid && u.value ? u.value : null;
}

function setFreshLoginToken(reply: FastifyReply): string {
  const token = randomBytes(32).toString('hex');
  reply.setCookie(LOGIN_CSRF_COOKIE, token, {
    path: '/login',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    signed: true,
    maxAge: 600,
  });
  return token;
}

function absoluteMaxMs(ctx: AdminContext): number {
  return ctx.security.get().session.absoluteMaxHours * 3600000;
}

function loginPage(ctx: AdminContext, csrfToken: string, error?: string): string {
  const breakGlass = ctx.security.get().breakGlass.enabled;
  const totpRequired = ctx.security.get().breakGlass.totpRequired;
  const body: SafeHtml = html`
    <div class="mx-auto mt-12 w-full max-w-sm sm:mt-24">
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <h1 class="mb-1 text-xl font-semibold tracking-tight">🕯️ Cinderella</h1>
        <p class="mb-6 text-sm text-slate-500">Operator console — sign in</p>
        ${
          error
            ? html`<div
                class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
              >
                ${error}
              </div>`
            : html``
        }
        <!-- Passkey status/errors are shown here by /assets/auth.js (CSP: no inline JS). -->
        <div
          id="passkey-status"
          class="mb-4 hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        ></div>

        <button
          id="passkey-login"
          type="button"
          class="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700"
        >
          Sign in with a passkey
        </button>
        <p class="mt-3 text-center text-xs text-slate-400">
          Use your device biometric, PIN, or a security key.
        </p>

        ${
          breakGlass
            ? html`
                <details class="mt-6 border-t border-slate-100 pt-4">
                  <summary class="cursor-pointer text-sm text-slate-500">
                    Break-glass: sign in with password
                  </summary>
                  <form method="post" action="/login" class="mt-3 flex flex-col gap-3">
                    <input type="hidden" name="_csrf" value="${csrfToken}" />
                    <input
                      name="username"
                      autocomplete="username"
                      placeholder="Username"
                      required
                      class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <input
                      name="password"
                      type="password"
                      autocomplete="current-password"
                      placeholder="Password"
                      required
                      class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    ${
                      totpRequired
                        ? html`<input
                            name="totp"
                            inputmode="numeric"
                            autocomplete="one-time-code"
                            placeholder="6-digit code"
                            class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                          />`
                        : html``
                    }
                    <button
                      type="submit"
                      class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                    >
                      Sign in with password
                    </button>
                  </form>
                </details>
              `
            : html``
        }
      </div>
    </div>
    <script src="/assets/webauthn-browser.js"></script>
    <script src="/assets/auth.js"></script>
  `;
  return page({ title: 'Sign in', body, chrome: false });
}

async function startSession(
  ctx: AdminContext,
  reply: FastifyReply,
  req: FastifyRequest,
  username: string,
  method: AuthMethod,
): Promise<void> {
  const { id } = await ctx.sessions.create(username, method);
  if (ctx.security.get().session.concurrent === 'single') {
    await ctx.sessions.destroyOthers(id);
  }
  setSessionCookie(reply, id, absoluteMaxMs(ctx));
  await writeAudit(ctx.db, username, 'auth.login', `method:${method}`, { ip: req.ip });
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AdminContext): void {
  const { db, adminCfg, security } = ctx;

  // --- Login page ---
  app.get('/login', async (req, reply) => {
    if (req.session) return reply.redirect('/dashboard');
    reply.type('text/html');
    // Reuse an existing valid login-CSRF token rather than always minting a new
    // one. Otherwise a concurrent/background GET /login — e.g. the browser's
    // /favicon.ico fetch, which the auth guard 302s here — would rotate the
    // cookie out from under the already-rendered form, so the eventual submit
    // fails with "Session expired". (The token stays per-browser, HttpOnly,
    // signed — reuse does not weaken the double-submit guarantee.)
    const existing = req.cookies[LOGIN_CSRF_COOKIE];
    const unsigned = existing ? req.unsignCookie(existing) : { valid: false as const, value: null };
    const token = unsigned.valid && unsigned.value ? unsigned.value : setFreshLoginToken(reply);
    return loginPage(ctx, token);
  });

  // --- WebAuthn: login ceremony (usernameless, discoverable) ---
  app.post('/webauthn/login/options', async (_req, reply) => {
    const options = await buildAuthenticationOptions(adminCfg, security.get());
    setChallengeCookie(reply, ctx.challenges.put(options.challenge, 'login'));
    return options;
  });

  app.post<{ Body: unknown }>('/webauthn/login/verify', async (req, reply) => {
    const client = req.ip;
    if (ctx.loginLimiter.isLocked(client)) {
      return reply.code(429).send({ error: 'Too many attempts. Try again later.' });
    }
    const challengeId = readChallengeCookie(req);
    const challenge = challengeId ? ctx.challenges.take(challengeId, 'login') : null;
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — reload and retry' });
    reply.clearCookie(WA_COOKIE, { path: '/' });

    const result = await completeAuthentication(
      db,
      adminCfg,
      security.get(),
      challenge,
      req.body as AuthenticationResponseJSON,
    );
    if (!result.ok) {
      ctx.loginLimiter.recordFailure(client);
      await writeAudit(db, adminCfg.adminUsername, 'auth.login_failed', `method:passkey`, {
        ip: client,
        reason: result.reason,
      });
      if (result.reason === 'counter-regression') {
        await alertSecurityEvent(security.get(), 'passkey.counter_regression', {
          ip: client,
        });
        return reply.code(403).send({ error: 'This passkey was locked (security anomaly).' });
      }
      if (result.reason === 'locked') {
        return reply.code(403).send({ error: 'This passkey is locked.' });
      }
      return reply.code(401).send({ error: 'Passkey verification failed.' });
    }
    ctx.loginLimiter.recordSuccess(client);
    await startSession(ctx, reply, req, adminCfg.adminUsername, 'passkey');
    return reply.send({ ok: true, redirect: '/dashboard' });
  });

  // --- Break-glass password path (gated by settings) ---
  app.post('/login', async (req, reply) => {
    reply.type('text/html');
    const client = req.ip;
    const bg = security.get().breakGlass;

    if (!bg.enabled) {
      reply.code(403);
      return loginPage(
        ctx,
        setFreshLoginToken(reply),
        'The password path is disabled. Use a passkey.',
      );
    }
    if (ctx.loginLimiter.isLocked(client)) {
      reply.code(429);
      return loginPage(ctx, setFreshLoginToken(reply), 'Too many attempts. Try again later.');
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body['username'] === 'string' ? body['username'] : '';
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    const totp = typeof body['totp'] === 'string' ? body['totp'] : '';
    const formToken = typeof body['_csrf'] === 'string' ? body['_csrf'] : '';

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
      return loginPage(ctx, setFreshLoginToken(reply), 'Session expired. Please try again.');
    }

    const ok = await verifyCredentials(adminCfg, username, password);
    let totpOk = true;
    if (ok && bg.totpRequired) {
      const t = await getTotp(db);
      totpOk = Boolean(t?.enabled) && verifyTotp(t?.secret ?? '', totp);
    }

    if (!ok || !totpOk) {
      const locked = ctx.loginLimiter.recordFailure(client);
      await writeAudit(
        db,
        username || adminCfg.adminUsername,
        'auth.login_failed',
        'method:password',
        {
          ip: client,
          totp: bg.totpRequired ? totpOk : undefined,
        },
      );
      if (locked) await alertSecurityEvent(security.get(), 'auth.lockout', { ip: client });
      reply.code(401);
      const msg =
        ok && !totpOk ? 'Invalid or missing authentication code.' : 'Invalid credentials.';
      return loginPage(ctx, setFreshLoginToken(reply), msg);
    }

    ctx.loginLimiter.recordSuccess(client);
    reply.clearCookie(LOGIN_CSRF_COOKIE, { path: '/login' });
    await startSession(ctx, reply, req, username, 'password');
    return reply.redirect('/dashboard');
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) await ctx.sessions.destroy(req.session.sessionId);
    clearSessionCookie(reply);
    return reply.redirect('/login');
  });

  // --- WebAuthn: register a new passkey (authenticated) ---
  app.post<{ Body: { name?: string } }>('/webauthn/register/options', async (req, reply) => {
    const options = await buildRegistrationOptions(db, adminCfg, security.get());
    setChallengeCookie(reply, ctx.challenges.put(options.challenge, 'register'));
    return options;
  });

  app.post<{ Body: { response?: RegistrationResponseJSON; name?: string } }>(
    '/webauthn/register/verify',
    async (req, reply) => {
      const challengeId = readChallengeCookie(req);
      const challenge = challengeId ? ctx.challenges.take(challengeId, 'register') : null;
      if (!challenge) return reply.code(400).send({ error: 'challenge expired — retry' });
      reply.clearCookie(WA_COOKIE, { path: '/' });
      const body = req.body ?? {};
      if (!body.response) return reply.code(400).send({ error: 'missing response' });
      const result = await completeRegistration(
        db,
        adminCfg,
        security.get(),
        challenge,
        body.response,
        body.name ?? 'passkey',
        req.session?.username ?? adminCfg.adminUsername,
      );
      if (!result.ok) return reply.code(400).send({ error: result.error ?? 'registration failed' });
      // Registering counts as a fresh step-up.
      if (req.session) await ctx.sessions.markStepUp(req.session.sessionId);
      return reply.send({ ok: true });
    },
  );

  // --- WebAuthn: step-up re-verification (authenticated) ---
  app.post('/webauthn/stepup/options', async (_req, reply) => {
    const options = await buildAuthenticationOptions(adminCfg, security.get());
    setChallengeCookie(reply, ctx.challenges.put(options.challenge, 'login'));
    return options;
  });

  app.post<{ Body: unknown }>('/webauthn/stepup/verify', async (req, reply) => {
    if (!req.session) return reply.code(401).send({ error: 'unauthorized' });
    const challengeId = readChallengeCookie(req);
    const challenge = challengeId ? ctx.challenges.take(challengeId, 'login') : null;
    if (!challenge) return reply.code(400).send({ error: 'challenge expired — retry' });
    reply.clearCookie(WA_COOKIE, { path: '/' });
    const result = await completeAuthentication(
      db,
      adminCfg,
      security.get(),
      challenge,
      req.body as AuthenticationResponseJSON,
    );
    if (!result.ok) return reply.code(401).send({ error: 'step-up failed' });
    await ctx.sessions.markStepUp(req.session.sessionId);
    await writeAudit(db, req.session.username, 'auth.stepup', 'passkey', { ip: req.ip });
    return reply.send({ ok: true });
  });

  // Expose a tiny bootstrap hint endpoint the login page uses (no secrets).
  app.get('/webauthn/state', async () => {
    return {
      credentials: await countCredentials(db),
      breakGlass: security.get().breakGlass.enabled,
    };
  });
}
