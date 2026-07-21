/**
 * Stage 4 verification harness — admin foundation + auth (Addendum 1 / A6).
 *
 * Boots the REAL Fastify server (buildServer) against PGlite and exercises the
 * acceptance criteria over fastify.inject (no network, no TLS — TLS is nginx's
 * job in deploy):
 *   - unauthenticated requests are rejected,
 *   - the operator can log in (Argon2id) and the session persists,
 *   - repeated bad passwords are rate-limited,
 *   - a state-changing request without a valid CSRF token is refused,
 *   - security headers and cookie flags are set.
 *
 *   npx tsx scripts/verify-admin.ts
 */

import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import { buildServer, registerNav } from '../src/web/server.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import type { Queryable } from '../src/db/pool.js';
import { validateRpConfig } from '../src/config.js';
import type { AdminConfig, Config } from '../src/config.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/** Extracts "name=value" for a cookie from set-cookie header(s). */
function cookieOf(setCookie: string | string[] | undefined, name: string): string | null {
  const arr = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    if (c.startsWith(`${name}=`)) {
      const first = c.split(';')[0];
      if (first && first.length > name.length + 1) return first;
    }
  }
  return null;
}

function rawCookie(setCookie: string | string[] | undefined, name: string): string | null {
  const arr = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  return arr.find((c) => c.startsWith(`${name}=`)) ?? null;
}

async function main(): Promise<void> {
  const pg = new PGlite();
  const db: Queryable = {
    async query(text, values) {
      const res = await pg.query(text, values ? [...values] : undefined);
      return {
        rows: res.rows as never[],
        rowCount: (res.affectedRows ?? res.rows.length) as number,
      };
    },
  };
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  const PASSWORD = 'correct-horse-battery-staple';
  const adminCfg: AdminConfig = {
    adminPort: 0,
    adminUsername: 'operator',
    adminPasswordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    sessionSecret: 'a'.repeat(48),
    publicOrigin: 'https://cinderella.example.org',
    rpId: 'cinderella.example.org',
    webauthnOrigin: 'https://cinderella.example.org',
    rpName: 'Cinderella Admin',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: './state/simplex/cinderella',
    simplexFilesFolder: './state/files',
    groupName: '',
    mediaRoot: process.cwd(),
    avatarPath: '',
    databaseUrl: 'postgres://cinderella:pw@127.0.0.1:5432/cinderella',
    logLevel: 'info',
  };
  const settings = await SettingsService.load(db, 'info');
  const security = await SecurityService.load(db);

  registerNav();
  const app = buildServer({ db, adminCfg, cfg, settings, security, mediaRoot: process.cwd() });
  await app.ready();

  // --- 1) Unauthenticated access ---
  const unauthed = await app.inject({ method: 'GET', url: '/dashboard' });
  check(
    'unauthenticated GET /dashboard redirects to /login',
    unauthed.statusCode === 302 && unauthed.headers.location === '/login',
    `status=${unauthed.statusCode}`,
  );
  const unauthedApi = await app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { 'hx-request': 'true' },
  });
  check('unauthenticated htmx GET is 401', unauthedApi.statusCode === 401);
  const unauthedPost = await app.inject({ method: 'POST', url: '/logout' });
  check('unauthenticated POST is rejected', unauthedPost.statusCode === 401);

  // --- 2) Login page + login CSRF ---
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  check('login page renders', loginPage.statusCode === 200 && loginPage.body.includes('Sign in'));
  const loginCsrfCookie = rawCookie(loginPage.headers['set-cookie'], 'cinderella_login_csrf');
  check('login page sets a login-CSRF cookie', loginCsrfCookie !== null);
  const formTokenMatch = /name="_csrf" value="([a-f0-9]{64})"/.exec(loginPage.body);
  check('login form embeds the CSRF token', formTokenMatch !== null);
  const loginCookiePair = cookieOf(loginPage.headers['set-cookie'], 'cinderella_login_csrf') ?? '';

  const loginNoToken = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { username: 'operator', password: PASSWORD },
    headers: { cookie: loginCookiePair },
  });
  check('login POST without form token is refused (403)', loginNoToken.statusCode === 403);

  // --- 3) Wrong password: generic message + rate limit ---
  async function tryLogin(password: string, ip: string): Promise<number> {
    const pageRes = await app.inject({ method: 'GET', url: '/login', remoteAddress: ip });
    const tokenM = /name="_csrf" value="([a-f0-9]{64})"/.exec(pageRes.body);
    const cookiePair = cookieOf(pageRes.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'operator', password, _csrf: tokenM?.[1] ?? '' },
      headers: { cookie: cookiePair },
      remoteAddress: ip,
    });
    return res.statusCode;
  }

  const wrong1 = await tryLogin('wrong-password', '198.51.100.7');
  check('wrong password rejected with 401', wrong1 === 401);
  let sawLockout = false;
  for (let i = 0; i < 6; i++) {
    const code = await tryLogin('wrong-password', '198.51.100.7');
    if (code === 429) {
      sawLockout = true;
      break;
    }
  }
  check('repeated bad passwords are rate-limited (429)', sawLockout);
  const lockedGood = await tryLogin(PASSWORD, '198.51.100.7');
  check('lockout also blocks correct password from that client', lockedGood === 429);

  // --- 3b) X-Forwarded-For spoofing must NOT bypass the rate limiter ---
  // trustProxy:'loopback' means only nginx (127.0.0.1) is trusted; nginx appends
  // the real peer, so the rightmost XFF entry is the stable real client. An
  // attacker rotating the LEFTMOST value cannot dodge the per-client lockout.
  async function tryLoginXff(leftmost: string): Promise<number> {
    // Simulate what nginx forwards: attacker-supplied entry + real peer appended.
    const xff = `${leftmost}, 203.0.113.77`;
    const pageRes = await app.inject({
      method: 'GET',
      url: '/login',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': xff },
    });
    const tokenM = /name="_csrf" value="([a-f0-9]{64})"/.exec(pageRes.body);
    const cookiePair = cookieOf(pageRes.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'operator', password: 'wrong-password', _csrf: tokenM?.[1] ?? '' },
      headers: { cookie: cookiePair, 'x-forwarded-for': xff },
      remoteAddress: '127.0.0.1',
    });
    return res.statusCode;
  }
  let xffLockout = false;
  for (let i = 0; i < 8; i++) {
    // Rotate the spoofable leftmost value on every attempt.
    const code = await tryLoginXff(`10.9.8.${i}`);
    if (code === 429) {
      xffLockout = true;
      break;
    }
  }
  check('rotating X-Forwarded-For does NOT bypass lockout (keyed on real peer)', xffLockout);

  // --- 4) Successful login from a clean client ---
  const pageRes = await app.inject({ method: 'GET', url: '/login', remoteAddress: '203.0.113.9' });
  const tokenM = /name="_csrf" value="([a-f0-9]{64})"/.exec(pageRes.body);
  const cookiePair = cookieOf(pageRes.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
  const loginRes = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { username: 'operator', password: PASSWORD, _csrf: tokenM?.[1] ?? '' },
    headers: { cookie: cookiePair },
    remoteAddress: '203.0.113.9',
  });
  check(
    'correct credentials log in (302 to /dashboard)',
    loginRes.statusCode === 302 && loginRes.headers.location === '/dashboard',
  );
  const sessionSetCookie = rawCookie(loginRes.headers['set-cookie'], 'cinderella_session');
  check('session cookie is set', sessionSetCookie !== null);
  check(
    'session cookie flags: HttpOnly, Secure, SameSite=Strict, Path=/',
    sessionSetCookie !== null &&
      /httponly/i.test(sessionSetCookie) &&
      /secure/i.test(sessionSetCookie) &&
      /samesite=strict/i.test(sessionSetCookie) &&
      /path=\//i.test(sessionSetCookie),
    sessionSetCookie ?? '',
  );
  const sessionPair = cookieOf(loginRes.headers['set-cookie'], 'cinderella_session') ?? '';

  // --- 5) Session persists across requests ---
  const home1 = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: sessionPair } });
  const home2 = await app.inject({ method: 'GET', url: '/dashboard', headers: { cookie: sessionPair } });
  check(
    'session persists across requests',
    home1.statusCode === 200 && home2.statusCode === 200,
    `status=${home1.statusCode},${home2.statusCode}`,
  );
  check('authed page addresses the operator', home1.body.includes('operator'));

  // --- 6) Security headers ---
  const csp = home1.headers['content-security-policy'];
  check(
    'security headers present (CSP, nosniff, frame DENY, no-store)',
    typeof csp === 'string' &&
      csp.includes("default-src 'self'") &&
      home1.headers['x-content-type-options'] === 'nosniff' &&
      home1.headers['x-frame-options'] === 'DENY' &&
      home1.headers['cache-control'] === 'no-store',
  );

  // --- 7) CSRF on state-changing requests ---
  const mutateNoCsrf = await app.inject({
    method: 'POST',
    url: '/logout',
    headers: { cookie: sessionPair },
  });
  check('mutation without CSRF token is refused (403)', mutateNoCsrf.statusCode === 403);

  const stillAuthed = await app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { cookie: sessionPair },
  });
  check('session survived the refused mutation', stillAuthed.statusCode === 200);

  // Extract the CSRF token from the page (embedded in the logout form).
  const csrfM = /name="_csrf" value="([a-f0-9]{64})"/.exec(stillAuthed.body);
  check('authed page embeds the session CSRF token', csrfM !== null);

  const badCsrf = await app.inject({
    method: 'POST',
    url: '/logout',
    payload: { _csrf: 'f'.repeat(64) },
    headers: { cookie: sessionPair },
  });
  check('mutation with a WRONG CSRF token is refused (403)', badCsrf.statusCode === 403);

  const logoutRes = await app.inject({
    method: 'POST',
    url: '/logout',
    payload: { _csrf: csrfM?.[1] ?? '' },
    headers: { cookie: sessionPair },
  });
  check(
    'logout with valid CSRF succeeds and redirects to /login',
    logoutRes.statusCode === 302 && logoutRes.headers.location === '/login',
  );
  const afterLogout = await app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { cookie: sessionPair },
  });
  check('session is invalid after logout', afterLogout.statusCode === 302);

  // --- 8) Forged session cookie is rejected (signature check) ---
  const forged = await app.inject({
    method: 'GET',
    url: '/dashboard',
    headers: { cookie: `cinderella_session=${'ab'.repeat(32)}.forgedsig` },
  });
  check('forged session cookie is rejected', forged.statusCode === 302);

  // --- WebAuthn RP-ID/origin startup guard (CCB-S2-011) ---
  const guardThrows = (rp: string, origin: string): boolean => {
    try {
      validateRpConfig(rp, origin);
      return false;
    } catch {
      return true;
    }
  };
  check(
    'rp guard: rpId == origin host passes',
    !guardThrows('admin.example.test', 'https://admin.example.test'),
  );
  check(
    'rp guard: registrable-parent rpId passes',
    !guardThrows('example.test', 'https://admin.example.test'),
  );
  check(
    'rp guard: mismatched rpId is REJECTED (the silent-lockout footgun)',
    guardThrows('other.test', 'https://admin.example.test'),
  );
  check(
    'rp guard: unrelated origin is rejected',
    guardThrows('admin.example.test', 'https://evil.test'),
  );

  await app.close();
  await pg.close();

  console.log('');
  if (failures === 0) {
    console.log('ALL CHECKS PASSED ✓');
  } else {
    console.log(`${failures} CHECK(S) FAILED ✗`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('verify-admin crashed:', err);
  process.exit(1);
});
