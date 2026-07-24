/**
 * Website settings console (CCB-S2-012). Configures the three public-site building
 * blocks — visitor analytics, the cookie/consent banner, and social share — each a
 * real, audited setting persisted under the `site` key. ALL default OFF; the operator
 * opts in and carries the legal responsibility (requirements differ by country).
 *
 * Consent invariant surfaced here: analytics is gated behind the cookie banner, so it
 * can never track before the visitor accepts. Share is script-free links (no banner).
 */

import type { FastifyInstance } from 'fastify';
import { KNOWN_NETWORKS, normalizeSite, type SiteSettings } from '../../site/settings.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { card, pageHeader } from './ui.js';

function cb(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} class="rounded" />
    ${label}
  </label>`;
}
function txt(name: string, value: string, placeholder = ''): SafeHtml {
  return html`<input
    name="${name}"
    value="${value}"
    placeholder="${placeholder}"
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

const NETWORK_LABELS: Record<string, string> = {
  x: 'X',
  facebook: 'Facebook',
  reddit: 'Reddit',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  linkedin: 'LinkedIn',
  email: 'Email',
};

export function registerSiteAdmin(app: FastifyInstance, ctx: ViewContext): void {
  const { site } = ctx;

  app.get<{ Querystring: { saved?: string; error?: string } }>('/website', async (req, reply) => {
    const s = site.get();
    const csrf = req.session?.csrfToken ?? '';
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

    const form = (section: string, inner: SafeHtml): SafeHtml =>
      html`<form method="post" action="/website" class="flex flex-col gap-3">
        <input type="hidden" name="_csrf" value="${csrf}" />
        <input type="hidden" name="section" value="${section}" />
        ${inner}
      </form>`;

    // Operator-responsibility banner (legal requirements differ by country).
    const responsibility = html`<div
      class="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <p class="font-semibold">You are responsible for enabling these correctly.</p>
      <p class="mt-1">
        Analytics, the cookie banner and social share ship <strong>off by default</strong>. The
        legal requirements for them (consent, disclosure, data-processing agreements) differ by
        country — enabling them is your decision and your responsibility. Analytics is
        <strong>consent-gated</strong>: it loads nothing until a visitor accepts the cookie banner.
      </p>
    </div>`;

    const analyticsWarn =
      s.analytics.enabled && !s.cookieBanner.enabled
        ? html`<div
            class="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            Analytics is enabled but the cookie banner is off — with no way to gather consent,
            <strong>analytics will not load</strong>. Enable the cookie banner below.
          </div>`
        : null;

    const analyticsCard = card(
      'Visitor analytics',
      html`${analyticsWarn}
        <p class="mb-3 text-sm text-slate-500">
          First-party / self-hosted analytics preferred. Provide the snippet's HTTPS script URL; it
          loads only after a visitor accepts the cookie banner.
        </p>
        ${form(
          'analytics',
          html`
            ${cb('enabled', 'Enable visitor analytics (consent-gated)', s.analytics.enabled)}
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600">Provider (label, optional)</span>
              ${txt('provider', s.analytics.provider, 'e.g. Plausible')}
            </label>
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600">Script URL (HTTPS; empty = none)</span>
              ${txt('scriptUrl', s.analytics.scriptUrl, 'https://analytics.example.org/script.js')}
            </label>
            ${saveBtn()}
          `,
        )}`,
    );

    const cookieCard = card(
      'Cookie / consent banner',
      html`<p class="mb-3 text-sm text-slate-500">
          Off by default. When on, it gates analytics and any non-essential storage. Essential
          storage (the theme choice, the language preference) needs no consent and always works.
        </p>
        ${form(
          'cookiebanner',
          html`
            ${cb('enabled', 'Show the consent banner', s.cookieBanner.enabled)}
            <label class="flex flex-col gap-1 text-sm">
              <span class="text-slate-600"
                >Privacy-policy URL (HTTPS; empty = the /legal page)</span
              >
              ${txt('policyUrl', s.cookieBanner.policyUrl, 'https://example.org/privacy')}
            </label>
            ${saveBtn()}
          `,
        )}`,
    );

    const shareCard = card(
      'Social share',
      html`<p class="mb-3 text-sm text-slate-500">
          Script-free share links (they open a share dialog on the target site and load no
          third-party code, so they need no consent). Off by default.
        </p>
        ${form(
          'socialshare',
          html`
            ${cb('enabled', 'Show share links', s.socialShare.enabled)}
            <fieldset class="flex flex-col gap-2">
              <legend class="text-sm text-slate-600">Networks</legend>
              <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                ${KNOWN_NETWORKS.map((n) =>
                  networkCheckbox(n, NETWORK_LABELS[n] ?? n, s.socialShare.networks.includes(n)),
                )}
              </div>
            </fieldset>
            ${saveBtn()}
          `,
        )}`,
    );

    const body = html`
      ${pageHeader('Website', 'Public marketing site — building blocks (all off by default)')}
      ${notice} ${responsibility}
      <p class="mb-4 text-sm text-slate-500">
        The public site is live at
        <a href="/" class="font-medium text-slate-700 underline">the domain root</a> in English and
        German. These three features are opt-in.
      </p>
      <div class="flex flex-col gap-4">${analyticsCard} ${cookieCard} ${shareCard}</div>
    `;
    reply.type('text/html');
    return page({ title: 'Website', active: 'site', csrfToken: csrf, body });
  });

  app.post('/website', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const section = typeof b['section'] === 'string' ? b['section'] : '';
    const actor = req.session?.username ?? 'unknown';
    const next: SiteSettings = structuredClone(site.get());
    const str = (k: string): string => (typeof b[k] === 'string' ? b[k] : '');
    const on = (k: string): boolean => b[k] === 'on';

    try {
      switch (section) {
        case 'analytics':
          next.analytics = normalizeSite({
            analytics: {
              enabled: on('enabled'),
              provider: str('provider'),
              scriptUrl: str('scriptUrl'),
            },
          }).analytics;
          break;
        case 'cookiebanner':
          next.cookieBanner = normalizeSite({
            cookieBanner: { enabled: on('enabled'), policyUrl: str('policyUrl') },
          }).cookieBanner;
          break;
        case 'socialshare': {
          const raw = b['networks'];
          const netsArr = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
          next.socialShare = normalizeSite({
            socialShare: { enabled: on('enabled'), networks: netsArr },
          }).socialShare;
          break;
        }
        default:
          return reply.redirect('/website?error=' + encodeURIComponent('Unknown section.'));
      }
      await site.save(next, actor);
      return reply.redirect('/website?saved=1');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid input.';
      return reply.redirect('/website?error=' + encodeURIComponent(msg));
    }
  });
}

/** A single network checkbox posting `networks=<code>` when checked. */
function networkCheckbox(code: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      name="networks"
      value="${code}"
      ${checked ? raw('checked') : ''}
      class="rounded"
    />${label}
  </label>`;
}
