/**
 * Dashboard (A3): bot/in-group status, last-captured timestamp, counts, a
 * prominent failed-file-receipt indicator (react before the ~48h XFTP expiry),
 * recent errors, and recent audit entries.
 */

import type { FastifyInstance } from 'fastify';
import { dashboardStats } from '../../db/admin-queries.js';
import { recentAudit } from '../../db/audit.js';
import { recentUnknownScopes, unknownScopeCount } from '../../capture/scope-diagnostics.js';
import { recentMediaFailures } from '../../media/failures.js';
import { html, page, type SafeHtml } from '../html.js';
import { icon } from '../icons.js';
import { status } from '../status.js';
import type { ViewContext } from '../server.js';
import { badge, card, fmtDate, pageHeader, stat, truncate } from './ui.js';

function botStateBadge(): SafeHtml {
  switch (status.botState) {
    case 'running':
      return badge('running', 'green');
    case 'failed':
      return badge('failed', 'red');
    case 'starting':
      return badge('starting', 'amber');
    default:
      return badge(status.botState, 'slate');
  }
}

export function registerDashboard(app: FastifyInstance, ctx: ViewContext): void {
  // The admin dashboard moved off '/' when the public marketing site took over the
  // domain root (CCB-S2-012). Nav + post-login redirect point here.
  app.get('/dashboard', async (req, reply) => {
    const alertHours = ctx.settings.get().fileAlertHours;
    const stats = await dashboardStats(ctx.db, alertHours);
    const audit = await recentAudit(ctx.db, 10);

    const fileTrouble = stats.mediaFailed + stats.mediaAtRisk;
    const fileIndicator: SafeHtml =
      fileTrouble > 0
        ? html`<div
            class="mb-6 flex flex-col gap-2 rounded-xl border border-red-300 bg-red-50 p-4 sm:flex-row sm:items-center sm:gap-4"
          >
            <span class="flex items-center gap-2 font-semibold text-red-800"
              >${icon('fileWarning', 'h-5 w-5')} Failed / at-risk file receipts</span
            >
            <span class="text-sm text-red-700">
              ${stats.mediaFailed} failed, ${stats.mediaAtRisk} missing &gt; ${alertHours}h (XFTP
              relays expire files after ~48h — investigate now).
            </span>
            <a
              href="/messages?deleted=no"
              class="text-sm font-medium text-red-800 underline sm:ml-auto"
              >Review messages →</a
            >
          </div>`
        : html`<div
            class="mb-6 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"
          >
            ${icon('activity', 'h-4 w-4')} All expected media
            received${
              stats.mediaPending > 0 ? html` (${stats.mediaPending} download(s) in progress)` : null
            }.
          </div>`;

    // Unrecognised capture-scope exclusions (CCB-S3-019 follow-up). Expected
    // exclusions (direct chats, the private support scope) are silent; this fires
    // ONLY when capture dropped a group item whose scope we do not understand —
    // amber, not red: worth understanding, not a live consent leak.
    const unknownScopes = unknownScopeCount();
    const scopeIndicator: SafeHtml =
      unknownScopes > 0
        ? html`<div
            class="mb-6 flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-4"
          >
            <span class="flex items-center gap-2 font-semibold text-amber-800"
              >${icon('fileWarning', 'h-5 w-5')} Unrecognised capture exclusions (${unknownScopes})</span
            >
            <span class="text-sm text-amber-700">
              Capture dropped ${unknownScopes} item(s) whose chat scope it does not recognise —
              neither a public message nor an expected private one. This is not a leak, but capture
              is stopping for a reason we don't understand; a new SimpleX scope or a malformed item
              is the likely cause.
            </span>
            <ul class="mt-1 flex flex-col gap-1 text-xs text-amber-700">
              ${recentUnknownScopes(8).map(
                (s) =>
                  html`<li class="flex gap-2">
                    <span class="shrink-0 text-amber-500">${fmtDate(new Date(s.at).toISOString())}</span>
                    <span>scope <code>${s.scopeType}</code>${s.groupId !== null ? html` · group ${s.groupId}` : null}</span>
                  </li>`,
              )}
            </ul>
          </div>`
        : html``;

    // Media that was captured but is now unserveable on disk, or would not strip
    // (CCB-S3-023). recordMediaFailure() had producers but no admin surface, so a
    // withheld/broken published image stayed invisible. Amber, shown only when
    // something is actually wrong.
    const mediaFails = recentMediaFailures(8);
    const mediaFailIndicator: SafeHtml =
      mediaFails.length > 0
        ? html`<div class="mb-6 flex flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 p-4">
            <span class="flex items-center gap-2 font-semibold text-amber-800"
              >${icon('fileWarning', 'h-5 w-5')} Media that could not be served or stripped
              (${mediaFails.length})</span
            >
            <span class="text-sm text-amber-700">
              These published items are withheld or unserveable. A common cause is the service user
              not being able to write to MEDIA_ROOT/derived. Records reset on restart.
            </span>
            <ul class="mt-1 flex flex-col gap-1 text-xs text-amber-700">
              ${mediaFails.map(
                (f) =>
                  html`<li class="flex gap-2">
                    <span class="shrink-0 text-amber-500">${fmtDate(new Date(f.at).toISOString())}</span>
                    <span>message ${f.messageId} · <code>${f.reason}</code> · ${f.detail}</span>
                  </li>`,
              )}
            </ul>
          </div>`
        : html``;

    const body = html`
      ${pageHeader('Dashboard', 'Capture health and archive at a glance')} ${fileIndicator}
      ${scopeIndicator} ${mediaFailIndicator}

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        ${stat('Messages', stats.totalMessages)}
        ${stat('Published', stats.publishedMessages, 'green')}
        ${stat('Deleted', stats.deletedMessages, stats.deletedMessages > 0 ? 'amber' : 'slate')}
        ${stat('Opted-in members', stats.consentActive, 'blue')}
        ${stat('Revoked consents', stats.consentRevoked)}
      </div>

      <div class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        ${card(
          'Bot status',
          html`<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt class="text-slate-500">State</dt>
            <dd>
              ${botStateBadge()}${status.botError ? html` <span class="text-red-700">${status.botError}</span>` : null}
            </dd>
            <dt class="text-slate-500">Groups</dt>
            <dd>${status.groups.length > 0 ? status.groups.join(', ') : '—'}</dd>
            <dt class="text-slate-500">Last captured</dt>
            <dd>${fmtDate(status.lastCapturedAt ?? stats.lastSentAt)}</dd>
            <dt class="text-slate-500">Process up since</dt>
            <dd>${fmtDate(status.startedAt)}</dd>
          </dl>`,
        )}
        ${card(
          'Messages by type',
          stats.byType.length > 0
            ? html`<div class="flex flex-wrap gap-2">
                ${stats.byType.map((t) => badge(`${t.type}: ${t.count}`, 'slate'))}
              </div>`
            : html`<p class="text-sm text-slate-500">No messages captured yet.</p>`,
        )}
        ${card(
          'Recent errors',
          status.recentErrors.length > 0
            ? html`<ul class="flex flex-col gap-2 text-sm">
                ${status.recentErrors.slice(0, 8).map(
                  (e) =>
                    html`<li class="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                      <span class="shrink-0 text-xs text-slate-400">${fmtDate(e.at)}</span>
                      <span class="text-red-700">${truncate(e.message, 160)}</span>
                    </li>`,
                )}
              </ul>`
            : html`<p class="text-sm text-slate-500">No recent errors.</p>`,
        )}
        ${card(
          'Recent admin actions',
          audit.length > 0
            ? html`<ul class="flex flex-col gap-2 text-sm">
                ${audit.map(
                  (a) =>
                    html`<li class="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-2">
                      <span class="shrink-0 text-xs text-slate-400">${fmtDate(a.at)}</span>
                      <span class="font-medium">${a.action}</span>
                      <span class="text-slate-500">${a.target ?? ''}</span>
                      <span class="text-xs text-slate-400 sm:ml-auto">${a.actor}</span>
                    </li>`,
                )}
              </ul>`
            : html`<p class="text-sm text-slate-500">No admin actions yet.</p>`,
        )}
      </div>
    `;

    reply.type('text/html');
    return page({
      title: 'Dashboard',
      active: 'dashboard',
      csrfToken: req.session?.csrfToken ?? '',
      body,
    });
  });
}
