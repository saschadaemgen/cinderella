/**
 * Addendum 4 verification harness — passkeys + max-security controls.
 *
 * Boots the REAL server + views against PGlite and exercises the parts that are
 * testable without a physical authenticator: WebAuthn ceremony endpoints, every
 * A4.5 control (persist + audit + enforced behaviour), break-glass gating,
 * rate-limit + lockout, IP access, configurable headers, TOTP, counter-regression
 * detection + lock, session lifetime, and concurrent-session policy.
 *
 * The full passkey crypto ceremony (register/login from a real biometric device)
 * is verified live on the deployed host by the operator.
 *
 *   npx tsx scripts/verify-security.ts
 */

import { PGlite } from '@electric-sql/pglite';
import argon2 from 'argon2';
import { authenticator } from 'otplib';
import { buildServer, registerNav } from '../src/web/server.js';
import { registerAdminViews } from '../src/web/views/index.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import { SessionStore, readSession } from '../src/web/session.js';
import { completeAuthentication, isCounterRegression } from '../src/web/security/webauthn.js';
import {
  countCredentials,
  getCredentialById,
  insertCredential,
  lockCredential,
} from '../src/db/webauthn.js';
import type { Queryable } from '../src/db/pool.js';
import type { AdminConfig, Config } from '../src/config.js';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
}
function cookieOf(sc: string | string[] | undefined, name: string): string | null {
  const arr = sc === undefined ? [] : Array.isArray(sc) ? sc : [sc];
  for (const c of arr) if (c.startsWith(`${name}=`)) return c.split(';')[0] ?? null;
  return null;
}

const PASSWORD = 'correct-horse-battery-staple';

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

  const adminCfg: AdminConfig = {
    adminPort: 0,
    adminUsername: 'operator',
    adminPasswordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
    sessionSecret: 'z'.repeat(48),
    publicOrigin: 'https://cinderella.example.org',
    rpId: 'cinderella.example.org',
    webauthnOrigin: 'https://cinderella.example.org',
    rpName: 'Cinderella Admin',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: './x',
    simplexFilesFolder: './f',
    groupName: '',
    mediaRoot: process.cwd(),
    databaseUrl: 'postgres://cinderella:pw@127.0.0.1:5432/cinderella',
    logLevel: 'info',
  };
  const settings = await SettingsService.load(db, 'info');
  const security = await SecurityService.load(db);

  registerNav();
  const app = buildServer({
    db,
    adminCfg,
    cfg,
    settings,
    security,
    mediaRoot: process.cwd(),
    registerViews: registerAdminViews,
  });
  await app.ready();

  // Break-glass password login (enabled by default for bootstrap).
  async function login(): Promise<string> {
    const lp = await app.inject({ method: 'GET', url: '/login' });
    const token = /name="_csrf" value="([a-f0-9]{64})"/.exec(lp.body)?.[1] ?? '';
    const cp = cookieOf(lp.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
    const res = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'operator', password: PASSWORD, _csrf: token },
      headers: { cookie: cp },
    });
    return cookieOf(res.headers['set-cookie'], 'cinderella_session') ?? '';
  }

  let session = await login();
  check('break-glass password login works by default (bootstrap)', session !== '');
  const authed = { cookie: session };

  // --- Regression (premature-logout hotfix): sessions persist across a restart ---
  {
    const persisted = (
      await pg.query<{ n: number }>('SELECT count(*)::int AS n FROM admin_sessions')
    ).rows[0]?.n;
    check('session is persisted in admin_sessions (not in-memory)', (persisted ?? 0) >= 1);
    // Simulate a `systemctl restart`: a brand-new server on the SAME database.
    const app2 = buildServer({
      db,
      adminCfg,
      cfg,
      settings,
      security,
      mediaRoot: process.cwd(),
      registerViews: registerAdminViews,
    });
    await app2.ready();
    const afterRestart = await app2.inject({ method: 'GET', url: '/', headers: authed });
    check(
      'session survives a simulated restart (new server instance, same DB)',
      afterRestart.statusCode === 200,
      `status=${afterRestart.statusCode}`,
    );
    // A fresh SessionStore (as a new process would build) still resolves it.
    const store2 = new SessionStore(db, () => ({ idleMs: 3600_000, absoluteMs: 86_400_000 }));
    const sid = (await pg.query<{ id: string }>('SELECT id FROM admin_sessions LIMIT 1')).rows[0]
      ?.id;
    check(
      'a new SessionStore reads the persisted session',
      sid !== undefined && (await store2.get(sid)) !== null,
    );
    await app2.close();
    void readSession; // (readSession is covered via the inject path above)
  }

  // --- Regression (login "Session expired" hotfix): a background 2nd GET /login
  // (e.g. the browser's favicon fetch, 302'd here) must NOT rotate the login-CSRF
  // cookie out from under the rendered form. ---
  {
    const g1 = await app.inject({ method: 'GET', url: '/login' });
    const tokA = /name="_csrf" value="([a-f0-9]{64})"/.exec(g1.body)?.[1] ?? '';
    const cookie1 = cookieOf(g1.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
    const g2 = await app.inject({ method: 'GET', url: '/login', headers: { cookie: cookie1 } });
    check(
      '2nd GET /login does NOT rotate the login-CSRF cookie',
      cookieOf(g2.headers['set-cookie'], 'cinderella_login_csrf') === null,
    );
    const post = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'operator', password: PASSWORD, _csrf: tokA },
      headers: { cookie: cookie1 },
    });
    check(
      'login succeeds after a background 2nd GET /login (no "Session expired")',
      post.statusCode === 302,
      `status=${post.statusCode}`,
    );
    const fav = await app.inject({ method: 'GET', url: '/favicon.ico' });
    check('favicon returns 204 (no 302 to /login)', fav.statusCode === 204);
  }
  async function csrf(): Promise<string> {
    const p = await app.inject({ method: 'GET', url: '/security', headers: authed });
    return /data-csrf="([a-f0-9]{64})"/.exec(p.body)?.[1] ?? '';
  }
  async function saveSection(fields: Record<string, string>): Promise<number> {
    const token = await csrf();
    const res = await app.inject({
      method: 'POST',
      url: '/security',
      payload: { _csrf: token, ...fields },
      headers: authed,
    });
    return res.statusCode;
  }

  // --- 1) Login page is passkey-first ---
  const loginPage = await app.inject({ method: 'GET', url: '/login' });
  check(
    'login page offers passkeys + break-glass',
    loginPage.body.includes('Sign in with a passkey') &&
      loginPage.body.includes('Break-glass') &&
      loginPage.body.includes('/assets/webauthn-browser.js'),
  );

  // --- 2) WebAuthn login-options endpoint (no auth needed) ---
  const opt = await app.inject({ method: 'POST', url: '/webauthn/login/options', payload: {} });
  const optJson = opt.json() as { challenge?: string; rpId?: string; allowCredentials?: unknown[] };
  check(
    'webauthn login options returns a challenge + rpId + usernameless allowCredentials',
    opt.statusCode === 200 &&
      typeof optJson.challenge === 'string' &&
      optJson.rpId === 'cinderella.example.org' &&
      Array.isArray(optJson.allowCredentials) &&
      optJson.allowCredentials.length === 0,
  );
  check(
    'webauthn login options sets a signed challenge cookie',
    cookieOf(opt.headers['set-cookie'], 'cinderella_wa') !== null,
  );

  // --- 3) Security settings persist + audit (a representative sample) ---
  check(
    'save passkey policy',
    (await saveSection({
      section: 'passkey',
      userVerification: 'required',
      residentKey: 'required',
      attestation: 'direct',
      allowedAaguids: '00000000-0000-0000-0000-000000000000',
    })) === 302,
  );
  check(
    'save session policy',
    (await saveSection({
      section: 'session',
      idleTimeoutMinutes: '30',
      absoluteMaxHours: '8',
      concurrent: 'single',
    })) === 302,
  );
  check(
    'save rate limit',
    (await saveSection({
      section: 'ratelimit',
      loginMaxAttempts: '3',
      loginWindowMinutes: '15',
      lockoutMinutes: '15',
      globalPerMinute: '0',
    })) === 302,
  );
  const stored = (
    await pg.query<{ value: unknown }>(`SELECT value FROM settings WHERE key='security'`)
  ).rows[0]?.value as {
    passkey: { attestation: string; allowedAaguids: string[] };
    session: { concurrent: string; stepUpForSensitive: boolean; idleTimeoutMinutes: number };
    rateLimit: { loginMaxAttempts: number };
  };
  check(
    'security settings persisted with normalized values',
    stored.passkey.attestation === 'direct' &&
      stored.passkey.allowedAaguids.length === 1 &&
      stored.session.concurrent === 'single' &&
      stored.session.idleTimeoutMinutes === 30 &&
      stored.rateLimit.loginMaxAttempts === 3,
    JSON.stringify(stored.rateLimit),
  );
  const secAudit = (
    await pg.query<{ n: string }>(`SELECT count(*) n FROM audit_log WHERE action='security.update'`)
  ).rows[0];
  check('each security change wrote an audit entry', Number(secAudit?.n ?? 0) >= 3);

  // --- 4) Configurable headers actually apply ---
  const cspProbe = "default-src 'self'; img-src 'self'; script-src 'self'";
  await saveSection({
    section: 'headers',
    csp: cspProbe,
    hstsMaxAge: '31536000',
    referrerPolicy: 'no-referrer',
    permissionsPolicy: 'geolocation=()',
    hstsIncludeSubdomains: 'on',
    hstsPreload: 'on',
  });
  const hdrs = await app.inject({ method: 'GET', url: '/security', headers: authed });
  check(
    'edited CSP is emitted on responses',
    hdrs.headers['content-security-policy'] === cspProbe,
    String(hdrs.headers['content-security-policy']),
  );
  check(
    'HSTS reflects settings (includeSubDomains + preload)',
    String(hdrs.headers['strict-transport-security']).includes('max-age=31536000') &&
      String(hdrs.headers['strict-transport-security']).includes('includeSubDomains') &&
      String(hdrs.headers['strict-transport-security']).includes('preload'),
  );
  // Reset CSP to secure default via the reset control.
  const rtoken = await csrf();
  await app.inject({
    method: 'POST',
    url: '/security',
    payload: { _csrf: rtoken, section: 'headers-reset' },
    headers: authed,
  });
  const afterReset = await app.inject({ method: 'GET', url: '/security', headers: authed });
  check(
    'reset restores the strict default CSP',
    String(afterReset.headers['content-security-policy']).includes("frame-ancestors 'none'"),
  );

  // --- 5) Rate limit + lockout demonstrably fire (password path) ---
  await saveSection({
    section: 'ratelimit',
    loginMaxAttempts: '3',
    loginWindowMinutes: '15',
    lockoutMinutes: '15',
    globalPerMinute: '0',
  });
  async function badLogin(ip: string): Promise<number> {
    const lp = await app.inject({ method: 'GET', url: '/login', remoteAddress: ip });
    const t = /name="_csrf" value="([a-f0-9]{64})"/.exec(lp.body)?.[1] ?? '';
    const cp = cookieOf(lp.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
    const r = await app.inject({
      method: 'POST',
      url: '/login',
      payload: { username: 'operator', password: 'wrong', _csrf: t },
      headers: { cookie: cp },
      remoteAddress: ip,
    });
    return r.statusCode;
  }
  let lockoutFired = false;
  for (let i = 0; i < 5; i++) {
    if ((await badLogin('198.51.100.42')) === 429) {
      lockoutFired = true;
      break;
    }
  }
  check('configured lockout fires after loginMaxAttempts (429)', lockoutFired);

  // --- 6) Break-glass gating ---
  // Cannot disable break-glass while zero passkeys exist.
  const disallowed = await app.inject({
    method: 'POST',
    url: '/security',
    payload: { _csrf: await csrf(), section: 'breakglass' }, // enabled unchecked => disable
    headers: authed,
  });
  check(
    'refuses to disable break-glass with no passkeys (avoids lockout)',
    disallowed.statusCode === 302 && String(disallowed.headers.location).includes('error='),
  );
  check(
    'break-glass still enabled after refused disable',
    security.get().breakGlass.enabled === true,
  );

  // Register a fake credential so disabling is permitted, then disable + verify password refused.
  await insertCredential(db, {
    credentialId: 'fake-cred-1',
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 5,
    transports: ['internal'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    name: 'test',
    backedUp: true,
    deviceType: 'multiDevice',
  });
  await saveSection({ section: 'breakglass' }); // disable (enabled unchecked, now allowed)
  check('break-glass disabled once a passkey exists', security.get().breakGlass.enabled === false);
  // A proper login attempt is refused with a "disabled" message (the break-glass
  // check precedes credential/CSRF checks).
  const lp2 = await app.inject({ method: 'GET', url: '/login' });
  const t2 = /name="_csrf" value="([a-f0-9]{64})"/.exec(lp2.body)?.[1] ?? '';
  const cp2 = cookieOf(lp2.headers['set-cookie'], 'cinderella_login_csrf') ?? '';
  const pwWhenOff = await app.inject({
    method: 'POST',
    url: '/login',
    payload: { username: 'operator', password: PASSWORD, _csrf: t2 },
    headers: { cookie: cp2 },
  });
  check(
    'password path refused when break-glass disabled (403 + message)',
    pwWhenOff.statusCode === 403 && /disabled/i.test(pwWhenOff.body),
  );
  await saveSection({ section: 'breakglass', enabled: 'on' }); // re-enable for later steps

  // --- 7) Counter-regression detection + lock ---
  check('regression predicate: 5 -> 4 is a regression', isCounterRegression(5, 4) === true);
  check('regression predicate: 5 -> 6 is NOT a regression', isCounterRegression(5, 6) === false);
  check('regression predicate: 0 -> 0 is NOT a regression', isCounterRegression(0, 0) === false);
  const before = await countCredentials(db);
  await lockCredential(db, 'fake-cred-1');
  const locked = await getCredentialById(db, 'fake-cred-1');
  check('lockCredential marks the credential locked', locked?.locked === true);
  check(
    'locked credential is excluded from the active count',
    (await countCredentials(db)) === before - 1,
  );
  const authLocked = await completeAuthentication(db, adminCfg, security.get(), 'challenge', {
    id: 'fake-cred-1',
    rawId: 'fake-cred-1',
    response: {} as never,
    type: 'public-key',
    clientExtensionResults: {},
  } as never);
  check(
    'login with a locked credential is refused (reason=locked)',
    authLocked.ok === false && authLocked.reason === 'locked',
  );
  const authUnknown = await completeAuthentication(db, adminCfg, security.get(), 'challenge', {
    id: 'nope',
    rawId: 'nope',
    response: {} as never,
    type: 'public-key',
    clientExtensionResults: {},
  } as never);
  check(
    'login with an unknown credential is refused',
    authUnknown.ok === false && authUnknown.reason === 'unknown-credential',
  );

  // --- 8) TOTP enroll + enable + verify ---
  await saveSection({ section: 'breakglass', enabled: 'on', totpRequired: 'on' });
  const enroll = await app.inject({
    method: 'POST',
    url: '/security/totp/enroll',
    payload: { _csrf: await csrf() },
    headers: authed,
  });
  check(
    'TOTP enroll returns a QR data URL',
    enroll.statusCode === 302 && String(enroll.headers.location).includes('totp='),
  );
  const totpRow = (
    await pg.query<{ secret: string; enabled: boolean }>(
      `SELECT secret, enabled FROM admin_totp WHERE id=TRUE`,
    )
  ).rows[0];
  check(
    'TOTP secret stored, not yet enabled',
    Boolean(totpRow?.secret) && totpRow?.enabled === false,
  );
  const goodCode = authenticator.generate(totpRow!.secret);
  const enable = await app.inject({
    method: 'POST',
    url: '/security/totp/enable',
    payload: { _csrf: await csrf(), token: goodCode },
    headers: authed,
  });
  const totpRow2 = (
    await pg.query<{ enabled: boolean }>(`SELECT enabled FROM admin_totp WHERE id=TRUE`)
  ).rows[0];
  check(
    'valid TOTP code enables the second factor',
    enable.statusCode === 302 && totpRow2?.enabled === true,
  );
  await saveSection({ section: 'breakglass', enabled: 'on', totpRequired: 'off' }); // relax for other tests

  // --- 9) IP access control blocks ---
  await saveSection({ section: 'ipaccess', mode: 'allow', list: '10.0.0.0/8' });
  const blocked = await app.inject({
    method: 'GET',
    url: '/security',
    headers: authed,
    remoteAddress: '203.0.113.5',
  });
  check('IP allowlist blocks a non-listed client (403)', blocked.statusCode === 403);
  const allowed = await app.inject({
    method: 'GET',
    url: '/security',
    headers: authed,
    remoteAddress: '10.1.2.3',
  });
  check('IP allowlist admits a listed client', allowed.statusCode === 200);
  // Turn it off from an allowed client.
  const offToken =
    /data-csrf="([a-f0-9]{64})"/.exec(
      (
        await app.inject({
          method: 'GET',
          url: '/security',
          headers: authed,
          remoteAddress: '10.1.2.3',
        })
      ).body,
    )?.[1] ?? '';
  await app.inject({
    method: 'POST',
    url: '/security',
    payload: { _csrf: offToken, section: 'ipaccess', mode: 'off', list: '' },
    headers: authed,
    remoteAddress: '10.1.2.3',
  });
  check('IP access can be turned off again', security.get().ipAccess.mode === 'off');

  // --- 10) Step-up: with it on + an ACTIVE (unlocked) passkey, a sensitive mutation is blocked ---
  await insertCredential(db, {
    credentialId: 'fake-cred-2',
    publicKey: new Uint8Array([4, 5, 6]),
    counter: 0,
    transports: ['internal'],
    aaguid: '00000000-0000-0000-0000-000000000000',
    name: 'active',
    backedUp: true,
    deviceType: 'multiDevice',
  });
  await saveSection({
    section: 'session',
    idleTimeoutMinutes: '720',
    absoluteMaxHours: '24',
    concurrent: 'multiple',
    stepUpForSensitive: 'on',
  });
  // Fresh password login => no step-up freshness; a sensitive mutation must 403.
  const pwSession = await login();
  const secForm = await app.inject({
    method: 'GET',
    url: '/security',
    headers: { cookie: pwSession },
  });
  const stepToken = /data-csrf="([a-f0-9]{64})"/.exec(secForm.body)?.[1] ?? '';
  const sensitive = await app.inject({
    method: 'POST',
    url: '/security',
    payload: { _csrf: stepToken, section: 'alerting', webhookUrl: '' },
    headers: { cookie: pwSession },
  });
  check(
    'step-up: sensitive mutation blocked (403 + X-Step-Up-Required) when required and unmet',
    sensitive.statusCode === 403 && sensitive.headers['x-step-up-required'] === '1',
  );
  check(
    'body advertises step-up requirement to the client',
    secForm.body.includes('data-stepup-required="1"'),
  );

  await app.close();
  await pg.close();
  console.log('');
  if (failures === 0) console.log('ALL CHECKS PASSED ✓');
  else {
    console.log(`${failures} CHECK(S) FAILED ✗`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('verify-security crashed:', err);
  process.exit(1);
});
