/**
 * Consent viewer (A3): read-only list of members' consent state. Consent is
 * only ever changed by the members themselves via /publish and /unpublish —
 * there are deliberately NO admin controls here.
 */

import type { FastifyInstance } from 'fastify';
import { consentOverview } from '../../db/admin-queries.js';
import { html, page } from '../html.js';
import type { ViewContext } from '../server.js';
import { badge, fmtDate, pageHeader, truncate } from './ui.js';

export function registerConsent(app: FastifyInstance, ctx: ViewContext): void {
  app.get('/consent', async (req, reply) => {
    const rows = await consentOverview(ctx.db);

    const body = html`
      ${pageHeader(
        'Consent',
        'Read-only — consent is granted and revoked exclusively by members via /publish and /unpublish',
      )}
      <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table class="w-full min-w-[40rem] text-left">
          <thead>
            <tr class="text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th class="px-3 py-2">Member ID</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Opted in</th>
              <th class="px-3 py-2">Revoked</th>
              <th class="px-3 py-2">Messages</th>
              <th class="px-3 py-2">Published</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length > 0
                ? rows.map(
                    (c) =>
                      html`<tr class="border-t border-slate-100">
                        <td class="px-3 py-2 font-mono text-xs" title="${c.memberId}">
                          ${truncate(c.memberId, 24)}
                        </td>
                        <td class="px-3 py-2">
                          ${c.revokedAt ? badge('revoked', 'red') : badge('active', 'green')}
                        </td>
                        <td class="px-3 py-2 text-sm text-slate-500">${fmtDate(c.optedInAt)}</td>
                        <td class="px-3 py-2 text-sm text-slate-500">${fmtDate(c.revokedAt)}</td>
                        <td class="px-3 py-2 text-sm">${c.messageCount}</td>
                        <td class="px-3 py-2 text-sm">${c.publishedCount}</td>
                      </tr>`,
                  )
                : html`<tr>
                    <td colspan="6" class="px-3 py-8 text-center text-sm text-slate-400">
                      No member has sent /publish yet.
                    </td>
                  </tr>`
            }
          </tbody>
        </table>
      </div>
    `;

    reply.type('text/html');
    return page({
      title: 'Consent',
      active: 'consent',
      csrfToken: req.session?.csrfToken ?? '',
      body,
    });
  });
}
