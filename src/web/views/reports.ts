/**
 * Content-report review queue (CCB-S2-009). Operator-only (behind the existing auth
 * guard). One row per reported message, grouped, with the consent/auth-gated preview
 * (the same getAdminMessage the Messages browser uses). Actions — take down, resolve,
 * dismiss — each write an audit entry; delete/edit are deferred to the Messages
 * browser via a deep link. Reporting never hides content; only the operator's takedown
 * removes it (visible-until-review).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { html, page, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { badge, fmtDate, pageHeader, truncate } from './ui.js';
import { actionButton, mediaCell } from './messages.js';
import { getAdminMessage, type AdminMessage } from '../../db/admin-queries.js';
import { setModerationState } from '../../db/messages.js';
import { writeAudit } from '../../db/audit.js';
import {
  listReportGroups,
  setReportsStatusForMessage,
  type ReportGroup,
  type ReportStatusFilter,
} from '../../db/reports.js';

const STATUS_FILTERS: ReportStatusFilter[] = ['open', 'resolved', 'dismissed', 'all'];
const BACK_RE = /^\?status=(open|resolved|dismissed|all)$/;
const REPORT_FLASH: Record<string, string> = {
  takedown: 'Item taken down and its open reports resolved.',
  resolve: 'Report(s) marked resolved.',
  dismiss: 'Report(s) dismissed.',
  gone: 'That message no longer exists.',
};
const REASON_LABELS: Record<string, string> = {
  illegal: 'Illegal',
  spam: 'Spam',
  copyright: 'Copyright',
  other: 'Other',
};

export function registerReports(app: FastifyInstance, ctx: ViewContext): void {
  app.get<{ Querystring: { status?: string; flash?: string } }>('/reports', async (req, reply) => {
    const csrf = req.session?.csrfToken ?? '';
    const status: ReportStatusFilter = STATUS_FILTERS.includes(
      req.query.status as ReportStatusFilter,
    )
      ? (req.query.status as ReportStatusFilter)
      : 'open';
    const back = `?status=${status}`;
    const flashKey = req.query.flash ?? '';
    // Own-key guard: a crafted ?flash=constructor would otherwise resolve an
    // inherited Object.prototype member (a function) and 500 the render.
    const flash = Object.hasOwn(REPORT_FLASH, flashKey) ? REPORT_FLASH[flashKey] : '';

    const groups = await listReportGroups(ctx.db, status);
    const rows = await Promise.all(
      groups.map(async (g) => ({ g, m: await getAdminMessage(ctx.db, g.messageId) })),
    );

    const body = html`
      ${pageHeader(
        'Reports',
        'Content flagged by the public. Reporting never hides an item — only your takedown does.',
      )}
      ${
        flash
          ? html`<p
              class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              ${flash}
            </p>`
          : null
      }
      <div class="mb-4 flex flex-wrap gap-2 text-sm">
        ${STATUS_FILTERS.map(
          (s) =>
            html`<a
              href="/reports?status=${s}"
              class="rounded-lg border px-3 py-1.5 ${
                  s === status
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 text-slate-600 hover:bg-slate-100'
                }"
              >${s}</a
            >`,
        )}
      </div>
      ${
        rows.length === 0
          ? html`<p class="text-sm text-slate-500">No reports — nothing to review.</p>`
          : html`<div class="flex flex-col gap-4">
              ${rows.map(({ g, m }) => reportRow(g, m, csrf, back))}
            </div>`
      }
    `;
    reply.type('text/html');
    return page({ title: 'Reports', active: 'reports', csrfToken: csrf, body });
  });

  async function transition(
    req: FastifyRequest<{ Params: { messageId: string } }>,
    reply: FastifyReply,
    action: 'takedown' | 'resolve' | 'dismiss',
  ): Promise<unknown> {
    const id = Number.parseInt(req.params.messageId, 10);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'bad id' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const back =
      typeof body['back'] === 'string' && BACK_RE.test(body['back'])
        ? body['back']
        : '?status=open';
    const user = req.session?.username ?? 'unknown';

    const m = await getAdminMessage(ctx.db, id);
    if (!m) return reply.redirect(`/reports${back}&flash=gone`);

    if (action === 'takedown') {
      // Reuse the Messages takedown primitive — the item leaves published_messages, so
      // the public front + live-update drop it — then auto-resolve its open reports.
      await setModerationState(ctx.db, id, 'rejected');
      await setReportsStatusForMessage(ctx.db, id, 'resolved', user);
      await writeAudit(ctx.db, user, 'report.takedown', `message:${id}`, {
        type: m.type,
        senderMemberId: m.senderMemberId,
        wasPublished: m.published,
      });
    } else if (action === 'resolve') {
      await setReportsStatusForMessage(ctx.db, id, 'resolved', user);
      await writeAudit(ctx.db, user, 'report.resolve', `message:${id}`, { type: m.type });
    } else {
      await setReportsStatusForMessage(ctx.db, id, 'dismissed', user);
      await writeAudit(ctx.db, user, 'report.dismiss', `message:${id}`, { type: m.type });
    }
    return reply.redirect(`/reports${back}&flash=${action}`);
  }

  app.post<{ Params: { messageId: string } }>('/reports/:messageId/takedown', (req, reply) =>
    transition(req, reply, 'takedown'),
  );
  app.post<{ Params: { messageId: string } }>('/reports/:messageId/resolve', (req, reply) =>
    transition(req, reply, 'resolve'),
  );
  app.post<{ Params: { messageId: string } }>('/reports/:messageId/dismiss', (req, reply) =>
    transition(req, reply, 'dismiss'),
  );
}

/** One queue card: the consent-gated message preview + report meta + actions. */
function reportRow(g: ReportGroup, m: AdminMessage | null, csrf: string, back: string): SafeHtml {
  const preview = m
    ? html`<div class="flex gap-3">
        ${mediaCell(m)}
        <div class="min-w-0">
          <div class="flex flex-wrap items-baseline gap-2 text-sm">
            <span class="font-medium text-slate-800">${m.senderDisplayName}</span>
            <span class="text-xs text-slate-400">${fmtDate(m.sentAt)}</span>
            ${badge(m.type)}
            ${m.published ? badge('published', 'green') : badge('not published', 'amber')}
            ${m.deleted || m.groupDeleted ? badge('deleted', 'red') : null}
          </div>
          ${m.textBody ? html`<p class="mt-1 text-sm text-slate-600">${truncate(m.textBody, 160)}</p>` : null}
        </div>
      </div>`
    : html`<span class="text-sm text-slate-400">Message #${g.messageId} no longer exists.</span>`;

  return html`<div class="rounded-xl border border-slate-200 bg-white p-4">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 flex-1">${preview}</div>
      <div class="flex flex-col gap-2 text-sm sm:w-72">
        <div class="flex flex-wrap items-center gap-1">
          ${g.reasons.map((r) => badge(REASON_LABELS[r] ?? r, 'amber'))}
        </div>
        <div class="text-xs text-slate-500">
          ${g.reportCount} report${g.reportCount === 1 ? '' : 's'} · first ${fmtDate(g.firstAt)} ·
          last ${fmtDate(g.lastAt)}
        </div>
        ${
          g.latestNote
            ? html`<p class="rounded bg-slate-50 p-2 text-xs italic text-slate-600">
                “${truncate(g.latestNote, 220)}”
              </p>`
            : null
        }
        <div class="flex flex-wrap gap-2">
          ${m && m.published ? actionButton('Take down', `/reports/${g.messageId}/takedown`, csrf, back, 'red') : null}
          ${actionButton('Resolve', `/reports/${g.messageId}/resolve`, csrf, back, 'green')}
          ${actionButton('Dismiss', `/reports/${g.messageId}/dismiss`, csrf, back, 'slate')}
          <a
            href="/messages?id=${g.messageId}"
            class="rounded-lg border border-slate-200 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
            >Manage in Messages →</a
          >
        </div>
      </div>
    </div>
  </div>`;
}
