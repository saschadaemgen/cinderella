/**
 * Security console (Addendum 4 / A4.5). Every control is a real, functioning
 * setting persisted in `settings` and audited on change: passkeys + credential
 * management, break-glass password + TOTP, session policy, passkey policy, rate
 * limits/lockout, IP access, headers/CSP, Argon2 cost, alerting, plus a security
 * event feed and enforced-status readouts.
 */

import type { FastifyInstance } from 'fastify';
import qrcode from 'qrcode';
import { writeAudit, recentAudit } from '../../db/audit.js';
import {
  countCredentials,
  deleteCredential,
  getTotp,
  listCredentials,
  renameCredential,
  setTotpEnabled,
  setTotpSecret,
} from '../../db/webauthn.js';
import { DEFAULT_CSP, normalizeSecurity, type SecuritySettings } from '../../security/settings.js';
import { newTotpSecret, totpKeyUri, verifyTotp } from '../auth.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import type { ViewContext } from '../server.js';
import { badge, card, fmtDate, pageHeader, truncate } from './ui.js';
import { needsStepUp } from '../security/stepup.js';

function cb(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} class="rounded" />
    ${label}
  </label>`;
}
function num(name: string, value: number, min = 0): SafeHtml {
  return html`<input
    type="number"
    name="${name}"
    value="${value}"
    min="${min}"
    class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm sm:w-40"
  />`;
}
function sel(name: string, cur: string, opts: [string, string][]): SafeHtml {
  return html`<select name="${name}" class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
    ${opts.map(([v, l]) => html`<option value="${v}" ${v === cur ? raw('selected') : ''}>${l}</option>`)}
  </select>`;
}
function txt(name: string, value: string): SafeHtml {
  return html`<input
    name="${name}"
    value="${value}"
    class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
  />`;
}
function saveBtn(): SafeHtml {
  return html`<button
    type="submit"
    class="self-start rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
  >
    Save
  </button>`;
}

export function registerSecurity(app: FastifyInstance, ctx: ViewContext): void {
  const { db, security } = ctx;

  app.get<{ Querystring: { saved?: string; error?: string; totp?: string } }>(
    '/security',
    async (req, reply) => {
      const s = security.get();
      const csrf = req.session?.csrfToken ?? '';
      const creds = await listCredentials(db);
      const credCount = await countCredentials(db);
      const totp = await getTotp(db);
      const events = (await recentAudit(db, 200)).filter((a) =>
        /^(auth|passkey|security)\./.test(a.action),
      );
      const stepUp = await needsStepUp(ctx, req.session ?? null);
      const notice = req.query.saved
        ? html`<div
            class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            Saved.
          </div>`
        : req.query.error
          ? html`<div
              class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              ${req.query.error}
            </div>`
          : html``;

      const form = (section: string, inner: SafeHtml, extraClass = ''): SafeHtml =>
        html`<form method="post" action="/security" class="flex flex-col gap-3 ${extraClass}">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <input type="hidden" name="section" value="${section}" />
          ${inner}
        </form>`;

      // --- Passkeys ---
      const passkeyList =
        creds.length > 0
          ? html`<ul class="flex flex-col">
              ${creds.map(
                (c) =>
                  html`<li
                    class="flex flex-col gap-2 border-t border-slate-100 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <span class="flex items-center gap-2"
                      >${icon('passkey')}
                      <span class="font-medium">${c.name}</span>
                      ${c.locked ? badge('locked', 'red') : c.backedUp ? badge('synced', 'blue') : badge('device-bound', 'slate')}
                    </span>
                    <span class="text-xs text-slate-400"
                      >aaguid ${truncate(c.aaguid ?? 'unknown', 12)} · created
                      ${fmtDate(c.createdAt)} · last used ${fmtDate(c.lastUsedAt)}</span
                    >
                    <span class="flex gap-2 sm:ml-auto">
                      <form
                        method="post"
                        action="/security/passkey/${c.id}/rename"
                        class="flex gap-1"
                      >
                        <input type="hidden" name="_csrf" value="${csrf}" />
                        <input
                          name="name"
                          value="${c.name}"
                          class="w-28 rounded border border-slate-300 px-2 py-1 text-xs"
                        />
                        <button
                          class="rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100"
                        >
                          Rename
                        </button>
                      </form>
                      <form method="post" action="/security/passkey/${c.id}/delete">
                        <input type="hidden" name="_csrf" value="${csrf}" />
                        <button
                          class="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        >
                          Revoke
                        </button>
                      </form>
                    </span>
                  </li>`,
              )}
            </ul>`
          : html`<p class="text-sm text-slate-500">No passkeys registered yet.</p>`;

      const passkeysCard = card(
        'Passkeys',
        html`
          ${
            credCount < 2
              ? html`<div
                  class="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                >
                  Register passkeys on <strong>≥2 devices</strong> (and ideally a hardware key)
                  before disabling the break-glass password — losing your only passkey without
                  break-glass means lockout.
                </div>`
              : null
          }
          ${passkeyList}
          <div
            id="security-status"
            class="mt-3 hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          ></div>
          <div
            class="mt-4 flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:items-end"
          >
            <label class="flex flex-1 flex-col gap-1 text-sm">
              <span class="font-medium text-slate-600">Name this device</span>
              <input
                id="passkey-name"
                placeholder="e.g. Pixel, YubiKey"
                class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <button
              id="register-passkey"
              type="button"
              class="flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Register a passkey
            </button>
          </div>
        `,
      );

      // --- Break-glass + TOTP ---
      const totpBlock = req.query.totp
        ? html`<div class="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p class="mb-2 text-xs text-slate-500">
              Scan with an authenticator app, then enter a code to enable.
            </p>
            <img src="${req.query.totp}" alt="TOTP QR" class="h-40 w-40" />
            <form method="post" action="/security/totp/enable" class="mt-3 flex gap-2">
              <input type="hidden" name="_csrf" value="${csrf}" />
              <input
                name="token"
                inputmode="numeric"
                placeholder="6-digit code"
                class="w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
              <button
                class="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                Enable TOTP
              </button>
            </form>
          </div>`
        : html``;

      const breakGlassCard = card(
        'Break-glass password',
        html`
          ${form(
            'breakglass',
            html`
              ${cb('enabled', 'Allow the Argon2id password path', s.breakGlass.enabled)}
              ${cb('totpRequired', 'Require a TOTP code on the password path', s.breakGlass.totpRequired)}
              ${saveBtn()}
            `,
          )}
          <div class="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-4">
            <span class="text-sm"
              >TOTP second factor:
              ${totp?.enabled ? badge('enabled', 'green') : badge('not configured', 'slate')}</span
            >
            <form method="post" action="/security/totp/enroll">
              <input type="hidden" name="_csrf" value="${csrf}" />
              <button
                class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                ${totp ? 'Re-enroll' : 'Enroll'} TOTP
              </button>
            </form>
            ${
              totp?.enabled
                ? html`<form method="post" action="/security/totp/disable">
                    <input type="hidden" name="_csrf" value="${csrf}" />
                    <button
                      class="rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
                    >
                      Disable TOTP
                    </button>
                  </form>`
                : null
            }
          </div>
          ${totpBlock}
        `,
      );

      // --- Passkey policy ---
      const passkeyPolicyCard = card(
        'Passkey policy',
        form(
          'passkey',
          html`
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">User verification</span>${sel(
                  'userVerification',
                  s.passkey.userVerification,
                  [
                    ['required', 'required'],
                    ['preferred', 'preferred'],
                  ],
                )}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Resident key</span>${sel(
                  'residentKey',
                  s.passkey.residentKey,
                  [
                    ['required', 'required'],
                    ['preferred', 'preferred'],
                  ],
                )}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Attestation</span>${sel(
                  'attestation',
                  s.passkey.attestation,
                  [
                    ['none', 'none'],
                    ['indirect', 'indirect'],
                    ['direct', 'direct'],
                  ],
                )}</label
              >
            </div>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600">Allowed AAGUIDs (one per line; empty = any model)</span>
              <textarea
                name="allowedAaguids"
                rows="2"
                class="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
              >
${s.passkey.allowedAaguids.join('\n')}</textarea>
            </label>
            ${saveBtn()}
          `,
        ),
      );

      // --- Session policy ---
      const sessionCard = card(
        'Sessions',
        html`${form(
            'session',
            html`
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="flex flex-col gap-1 text-sm"
                  ><span class="text-slate-600">Idle timeout (min)</span
                  >${num('idleTimeoutMinutes', s.session.idleTimeoutMinutes, 5)}</label
                >
                <label class="flex flex-col gap-1 text-sm"
                  ><span class="text-slate-600">Absolute max (hours)</span
                  >${num('absoluteMaxHours', s.session.absoluteMaxHours, 1)}</label
                >
                <label class="flex flex-col gap-1 text-sm"
                  ><span class="text-slate-600">Concurrent sessions</span>${sel(
                    'concurrent',
                    s.session.concurrent,
                    [
                      ['multiple', 'allow multiple'],
                      ['single', 'single (log out others on login)'],
                    ],
                  )}</label
                >
              </div>
              ${cb('stepUpForSensitive', 'Re-verify a passkey before sensitive actions (takedown / config)', s.session.stepUpForSensitive)}
              ${saveBtn()}
            `,
          )}
          <form
            method="post"
            action="/security/logout-others"
            class="mt-3 border-t border-slate-100 pt-3"
          >
            <input type="hidden" name="_csrf" value="${csrf}" />
            <button
              class="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Log out other sessions (${ctx.sessions.count()} active)
            </button>
          </form>`,
      );

      // --- Rate limit + lockout ---
      const rateCard = card(
        'Rate limiting & lockout',
        form(
          'ratelimit',
          html`
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Login max attempts</span
                >${num('loginMaxAttempts', s.rateLimit.loginMaxAttempts, 1)}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Login window (min)</span
                >${num('loginWindowMinutes', s.rateLimit.loginWindowMinutes, 1)}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Lockout (min)</span
                >${num('lockoutMinutes', s.rateLimit.lockoutMinutes, 1)}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Global req/min/client (0=off)</span
                >${num('globalPerMinute', s.rateLimit.globalPerMinute, 0)}</label
              >
            </div>
            ${saveBtn()}
          `,
        ),
      );

      // --- IP access ---
      const ipCard = card(
        'IP access control',
        form(
          'ipaccess',
          html`
            <p class="text-xs text-slate-500">
              Off by default. Not suitable for a dynamic CGNAT address (you are on Starlink) —
              passkeys are the control.
            </p>
            <label class="flex flex-col gap-1 text-sm"
              ><span class="text-slate-600">Mode</span>${sel('mode', s.ipAccess.mode, [
                ['off', 'off'],
                ['allow', 'allowlist'],
                ['deny', 'denylist'],
              ])}</label
            >
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600">IPs / CIDRs (one per line)</span>
              <textarea
                name="list"
                rows="3"
                class="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
              >
${s.ipAccess.list.join('\n')}</textarea>
            </label>
            ${saveBtn()}
          `,
        ),
      );

      // --- Headers / CSP ---
      const headersCard = card(
        'Browser hardening headers',
        html`${form(
            'headers',
            html`
              <label class="flex flex-col gap-1 text-sm">
                <span class="text-slate-600">Content-Security-Policy</span>
                <textarea
                  name="csp"
                  rows="3"
                  class="rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs"
                >
${s.headers.csp}</textarea>
              </label>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label class="flex flex-col gap-1 text-sm"
                  ><span class="text-slate-600">HSTS max-age (s)</span
                  >${num('hstsMaxAge', s.headers.hstsMaxAge, 0)}</label
                >
                <label class="flex flex-col gap-1 text-sm"
                  ><span class="text-slate-600">Referrer-Policy</span
                  >${txt('referrerPolicy', s.headers.referrerPolicy)}</label
                >
              </div>
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Permissions-Policy</span
                >${txt('permissionsPolicy', s.headers.permissionsPolicy)}</label
              >
              <div class="flex flex-col gap-1 sm:flex-row sm:gap-6">
                ${cb('hstsIncludeSubdomains', 'HSTS includeSubDomains', s.headers.hstsIncludeSubdomains)}
                ${cb('hstsPreload', 'HSTS preload', s.headers.hstsPreload)}
              </div>
              ${saveBtn()}
            `,
          )}
          <form method="post" action="/security" class="mt-2">
            <input type="hidden" name="_csrf" value="${csrf}" />
            <input type="hidden" name="section" value="headers-reset" />
            <button class="text-xs text-slate-500 underline">
              Reset CSP to the secure default
            </button>
          </form>`,
      );

      // --- Argon2 cost ---
      const argonCard = card(
        'Argon2id cost (advanced)',
        form(
          'argon2',
          html`
            <p class="text-xs text-slate-500">
              Applied by the password-hash tool (npm run hash-password) when you next set the
              break-glass password.
            </p>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Memory (KiB)</span
                >${num('memoryCostKiB', s.argon2.memoryCostKiB, 8192)}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Time cost</span
                >${num('timeCost', s.argon2.timeCost, 1)}</label
              >
              <label class="flex flex-col gap-1 text-sm"
                ><span class="text-slate-600">Parallelism</span
                >${num('parallelism', s.argon2.parallelism, 1)}</label
              >
            </div>
            ${saveBtn()}
          `,
        ),
      );

      // --- Alerting ---
      const alertCard = card(
        'Security alerting',
        form(
          'alerting',
          html`
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600">Webhook URL (HTTPS; empty = off)</span>
              ${txt('webhookUrl', s.alerting.webhookUrl)}
            </label>
            ${saveBtn()}
          `,
        ),
      );

      // --- Enforced status (read-only) ---
      const statusCard = card(
        'Enforced status',
        html`<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-slate-500">trustProxy</dt>
          <dd>loopback (nginx) — not editable ${badge('pinned', 'green')}</dd>
          <dt class="text-slate-500">Session cookie</dt>
          <dd>Secure · HttpOnly · SameSite=Strict · signed</dd>
          <dt class="text-slate-500">CSRF</dt>
          <dd>required on every state change</dd>
          <dt class="text-slate-500">Passkeys registered</dt>
          <dd>${credCount}</dd>
        </dl>`,
      );

      // --- Security event feed ---
      const feedCard = card(
        'Security events',
        events.length > 0
          ? html`<ul class="flex flex-col gap-1 text-sm">
              ${events.slice(0, 40).map((e) => {
                const anomaly = /counter_regression|lockout|login_failed|register_rejected/.test(
                  e.action,
                );
                return html`<li class="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                  <span class="shrink-0 text-xs text-slate-400">${fmtDate(e.at)}</span>
                  <span class="font-medium ${anomaly ? 'text-red-700' : ''}">${e.action}</span>
                  <span class="text-slate-500">${e.target ?? ''}</span>
                  <span class="text-xs text-slate-400 sm:ml-auto">${e.actor}</span>
                </li>`;
              })}
            </ul>`
          : html`<p class="text-sm text-slate-500">No security events yet.</p>`,
      );

      const body = html`
        ${pageHeader('Security', 'Passkeys, break-glass, and every hardening control — all configurable here')}
        ${notice}
        <div class="flex flex-col gap-4">
          ${passkeysCard} ${breakGlassCard} ${passkeyPolicyCard} ${sessionCard} ${rateCard}
          ${ipCard} ${headersCard} ${argonCard} ${alertCard} ${statusCard} ${feedCard}
        </div>
      `;
      reply.type('text/html');
      return page({
        title: 'Security',
        active: 'security',
        csrfToken: csrf,
        stepUpRequired: stepUp,
        body,
      });
    },
  );

  // --- Settings update (section-based) ---
  app.post('/security', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const section = typeof b['section'] === 'string' ? b['section'] : '';
    const actor = req.session?.username ?? 'unknown';
    const cur = security.get();
    const next: SecuritySettings = structuredClone(cur);
    const str = (k: string): string => {
      const v = b[k];
      return typeof v === 'string' ? v : '';
    };
    const on = (k: string): boolean => b[k] === 'on';

    try {
      switch (section) {
        case 'passkey':
          next.passkey = normalizeSecurity({
            passkey: {
              userVerification: str('userVerification'),
              residentKey: str('residentKey'),
              attestation: str('attestation'),
              allowedAaguids: str('allowedAaguids'),
            },
          }).passkey;
          break;
        case 'breakglass': {
          const enabled = on('enabled');
          if (!enabled && (await countCredentials(db)) === 0) {
            return reply.redirect(
              '/security?error=' +
                encodeURIComponent('Register a passkey before disabling the break-glass password.'),
            );
          }
          next.breakGlass = { enabled, totpRequired: on('totpRequired') };
          break;
        }
        case 'session':
          next.session = {
            idleTimeoutMinutes: Number(str('idleTimeoutMinutes')),
            absoluteMaxHours: Number(str('absoluteMaxHours')),
            stepUpForSensitive: on('stepUpForSensitive'),
            concurrent: str('concurrent') === 'single' ? 'single' : 'multiple',
          };
          break;
        case 'ratelimit':
          next.rateLimit = {
            loginMaxAttempts: Number(str('loginMaxAttempts')),
            loginWindowMinutes: Number(str('loginWindowMinutes')),
            lockoutMinutes: Number(str('lockoutMinutes')),
            globalPerMinute: Number(str('globalPerMinute')),
          };
          break;
        case 'ipaccess':
          next.ipAccess = normalizeSecurity({
            ipAccess: { mode: str('mode'), list: str('list') },
          }).ipAccess;
          break;
        case 'headers':
          next.headers = {
            csp: str('csp'),
            hstsMaxAge: Number(str('hstsMaxAge')),
            hstsIncludeSubdomains: on('hstsIncludeSubdomains'),
            hstsPreload: on('hstsPreload'),
            referrerPolicy: str('referrerPolicy'),
            permissionsPolicy: str('permissionsPolicy'),
          };
          break;
        case 'headers-reset':
          next.headers = { ...next.headers, csp: DEFAULT_CSP };
          break;
        case 'argon2':
          next.argon2 = {
            memoryCostKiB: Number(str('memoryCostKiB')),
            timeCost: Number(str('timeCost')),
            parallelism: Number(str('parallelism')),
          };
          break;
        case 'alerting':
          next.alerting = { webhookUrl: str('webhookUrl') };
          break;
        default:
          return reply.redirect('/security?error=' + encodeURIComponent('Unknown section.'));
      }
      await security.save(next, actor);
      return reply.redirect('/security?saved=1');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid input.';
      return reply.redirect('/security?error=' + encodeURIComponent(msg));
    }
  });

  // --- Credential management ---
  app.post<{ Params: { id: string } }>('/security/passkey/:id/rename', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    const name =
      typeof (req.body as Record<string, unknown>)?.['name'] === 'string'
        ? ((req.body as Record<string, unknown>)['name'] as string)
        : '';
    if (Number.isInteger(id) && (await renameCredential(db, id, name))) {
      await writeAudit(
        db,
        req.session?.username ?? 'unknown',
        'passkey.rename',
        `credential:${id}`,
        { name },
      );
    }
    return reply.redirect('/security');
  });

  app.post<{ Params: { id: string } }>('/security/passkey/:id/delete', async (req, reply) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isInteger(id) && (await deleteCredential(db, id))) {
      await writeAudit(
        db,
        req.session?.username ?? 'unknown',
        'passkey.revoke',
        `credential:${id}`,
        null,
      );
    }
    return reply.redirect('/security');
  });

  // --- TOTP enrollment ---
  app.post('/security/totp/enroll', async (req, reply) => {
    const secret = newTotpSecret();
    await setTotpSecret(db, secret);
    const uri = totpKeyUri(secret, ctx.adminCfg.adminUsername, 'Cinderella');
    const dataUrl = await qrcode.toDataURL(uri, { margin: 1, width: 200 });
    await writeAudit(db, req.session?.username ?? 'unknown', 'security.totp_enroll', 'totp', null);
    return reply.redirect('/security?totp=' + encodeURIComponent(dataUrl));
  });

  app.post('/security/totp/enable', async (req, reply) => {
    const token =
      typeof (req.body as Record<string, unknown>)?.['token'] === 'string'
        ? ((req.body as Record<string, unknown>)['token'] as string)
        : '';
    const t = await getTotp(db);
    if (!t || !verifyTotp(t.secret, token)) {
      return reply.redirect(
        '/security?error=' + encodeURIComponent('Invalid code — TOTP not enabled.'),
      );
    }
    await setTotpEnabled(db, true);
    await writeAudit(db, req.session?.username ?? 'unknown', 'security.totp_enable', 'totp', null);
    return reply.redirect('/security?saved=1');
  });

  app.post('/security/totp/disable', async (req, reply) => {
    await setTotpEnabled(db, false);
    await writeAudit(db, req.session?.username ?? 'unknown', 'security.totp_disable', 'totp', null);
    return reply.redirect('/security?saved=1');
  });

  // --- Sessions ---
  app.post('/security/logout-others', async (req, reply) => {
    if (req.session) {
      const n = ctx.sessions.destroyOthers(req.session.sessionId);
      await writeAudit(db, req.session.username, 'security.logout_others', `count:${n}`, null);
    }
    return reply.redirect('/security');
  });
}
