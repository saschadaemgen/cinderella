/**
 * Messages browser + manual takedown (A3).
 *
 * Filters: type, published, deleted, time range. Thumbnails for images. The
 * takedown actions plug into `moderation_state` ('rejected' removes a message
 * from the published set via the publish views) and `deleted`; every action is
 * audited.
 */

import type { FastifyInstance } from 'fastify';
import {
  browseMessages,
  getAdminMessage,
  publishReasons,
  type MessageFilters,
} from '../../db/admin-queries.js';
import { writeAudit } from '../../db/audit.js';
import { setDeletedById, setModerationState } from '../../db/messages.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import { typeIcon } from '../icons.js';
import type { ViewContext } from '../server.js';
import { badge, fmtDate, pageHeader, truncate } from './ui.js';

const PAGE_SIZE = 25;
const MAX_PAGE = 1_000_000;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/;

/** True when the value matches the shape AND is a real calendar date/time. */
function validDateTime(v: string): boolean {
  if (!DATETIME_RE.test(v)) return false;
  // Parse as UTC and require the components to round-trip (rejects 2026-02-30 etc.).
  const iso = v.length === 10 ? `${v}T00:00:00Z` : `${v.length === 16 ? `${v}:00` : v}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, v.length) === v;
}
/** Sanitized filter query string (only ever built from validated parts). */
const BACK_RE = /^\?[A-Za-z0-9=&%_.:-]*$/;

interface MessagesQuery {
  type?: string;
  published?: string;
  deleted?: string;
  since?: string;
  until?: string;
  page?: string;
  flash?: string;
  /** Deep-link to a single message id (from the report queue, CCB-S2-009). */
  id?: string;
}

/** Success banners shown after an action redirect (whitelisted flash codes). */
const FLASH_MESSAGES: Record<string, string> = {
  takedown: 'Message unpublished — removed from the public archive.',
  restore: 'Message restored — eligible for the archive again (subject to consent).',
  delete: 'Message marked deleted — excluded from the archive.',
  undelete: 'Message undeleted — no longer admin-excluded (subject to consent).',
  nochange: 'No change — the message was already in that state.',
};

function parseFilters(q: MessagesQuery): MessageFilters {
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1));
  const f: MessageFilters = { page, pageSize: PAGE_SIZE };
  if (q.type && ['text', 'image', 'video', 'voice', 'link', 'file'].includes(q.type)) {
    f.type = q.type;
  }
  if (q.published === 'yes' || q.published === 'no') f.published = q.published;
  if (q.deleted === 'yes' || q.deleted === 'no') f.deleted = q.deleted;
  if (q.since && validDateTime(q.since)) f.since = q.since;
  if (q.until && validDateTime(q.until)) f.until = q.until;
  if (q.id && /^\d+$/.test(q.id)) f.id = Number.parseInt(q.id, 10);
  return f;
}

function filterQueryString(f: MessageFilters, page: number): string {
  const parts: string[] = [];
  if (f.type) parts.push(`type=${f.type}`);
  if (f.published) parts.push(`published=${f.published}`);
  if (f.deleted) parts.push(`deleted=${f.deleted}`);
  if (f.since) parts.push(`since=${encodeURIComponent(f.since)}`);
  if (f.until) parts.push(`until=${encodeURIComponent(f.until)}`);
  parts.push(`page=${page}`);
  return `?${parts.join('&')}`;
}

function select(name: string, current: string | undefined, options: [string, string][]): SafeHtml {
  return html`<select
    name="${name}"
    class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none"
  >
    ${options.map(
      ([value, label]) =>
        html`<option value="${value}" ${value === (current ?? '') ? raw('selected') : ''}>
          ${label}
        </option>`,
    )}
  </select>`;
}

export function mediaCell(m: {
  type: string;
  mediaPath: string | null;
  mediaMime: string | null;
  mediaError: string | null;
}): SafeHtml {
  if (m.mediaPath && m.mediaMime?.startsWith('image/')) {
    const src = `/media/${m.mediaPath.split('/').map(encodeURIComponent).join('/')}`;
    return html`<a href="${src}" target="_blank" rel="noopener"
      ><img
        src="${src}"
        alt="thumbnail"
        loading="lazy"
        class="h-12 w-12 rounded-lg border border-slate-200 object-cover"
    /></a>`;
  }
  if (m.mediaPath) return badge('on disk', 'green');
  if (m.mediaError) return badge('failed', 'red');
  if (['image', 'video', 'voice', 'file'].includes(m.type)) return badge('missing', 'amber');
  return html``;
}

export function actionButton(
  label: string,
  action: string,
  csrf: string,
  back: string,
  tone: 'red' | 'slate' | 'green',
): SafeHtml {
  const cls =
    tone === 'red'
      ? 'text-red-700 hover:bg-red-50 border-red-200'
      : tone === 'green'
        ? 'text-emerald-700 hover:bg-emerald-50 border-emerald-200'
        : 'text-slate-600 hover:bg-slate-100 border-slate-200';
  return html`<form method="post" action="${action}" class="inline">
    <input type="hidden" name="_csrf" value="${csrf}" />
    <input type="hidden" name="back" value="${back}" />
    <button type="submit" class="rounded-lg border px-2 py-1 text-xs font-medium ${cls}">
      ${label}
    </button>
  </form>`;
}

export function registerMessages(app: FastifyInstance, ctx: ViewContext): void {
  app.get<{ Querystring: MessagesQuery }>('/messages', async (req, reply) => {
    const f = parseFilters(req.query);
    const { messages, total } = await browseMessages(ctx.db, f);
    const csrf = req.session?.csrfToken ?? '';
    const back = filterQueryString(f, f.page);
    const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

    // Own-key guard: an inherited key (?flash=constructor/toString/…) must not
    // resolve to an Object.prototype member (a truthy non-string → render crash).
    const flashText =
      req.query.flash && Object.hasOwn(FLASH_MESSAGES, req.query.flash)
        ? FLASH_MESSAGES[req.query.flash]
        : undefined;
    const flashBanner = flashText
      ? html`<div
          class="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
        >
          ${flashText}
        </div>`
      : null;

    const filterBar = html`
      <form
        method="get"
        action="/messages"
        class="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-3 lg:grid-cols-7"
      >
        <label class="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Type
          ${select('type', f.type, [
            ['', 'all'],
            ['text', 'text'],
            ['image', 'image'],
            ['video', 'video'],
            ['voice', 'voice'],
            ['link', 'link'],
            ['file', 'file'],
          ])}
        </label>
        <label class="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Published
          ${select('published', f.published, [
            ['', 'all'],
            ['yes', 'published'],
            ['no', 'not published'],
          ])}
        </label>
        <label class="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Deleted
          ${select('deleted', f.deleted, [
            ['', 'all'],
            ['no', 'not deleted'],
            ['yes', 'deleted'],
          ])}
        </label>
        <label class="flex flex-col gap-1 text-xs font-medium text-slate-500">
          From
          <input
            type="datetime-local"
            name="since"
            value="${f.since ?? ''}"
            class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label class="flex flex-col gap-1 text-xs font-medium text-slate-500">
          Until
          <input
            type="datetime-local"
            name="until"
            value="${f.until ?? ''}"
            class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          class="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Filter
        </button>
        <a href="/messages" class="px-2 py-2 text-center text-sm text-slate-500 underline">Reset</a>
      </form>
    `;

    const rows = messages.map((m) => {
      const actions: SafeHtml[] = [];
      // Moderation axis: "Unpublish" only makes sense for a message that is
      // actually published (else it silently sets a hidden 'rejected' state on a
      // message that was never on the archive). "Restore" clears a prior takedown.
      if (m.moderationState === 'rejected') {
        actions.push(actionButton('Restore', `/messages/${m.id}/restore`, csrf, back, 'green'));
      } else if (m.published) {
        actions.push(actionButton('Unpublish', `/messages/${m.id}/takedown`, csrf, back, 'red'));
      }
      // Deletion axis: in-group deletions cannot be undone (a member deleted it);
      // only admin-initiated deletions offer Undelete.
      if (m.groupDeleted) {
        // no delete/undelete control — it stays excluded from publishing
      } else if (m.deleted) {
        actions.push(actionButton('Undelete', `/messages/${m.id}/undelete`, csrf, back, 'slate'));
      } else {
        actions.push(actionButton('Mark deleted', `/messages/${m.id}/delete`, csrf, back, 'red'));
      }
      const reasons = publishReasons(m);
      return html`<tr class="border-t border-slate-100 align-top">
        <td class="px-3 py-2 text-xs whitespace-nowrap text-slate-400">${fmtDate(m.sentAt)}</td>
        <td class="px-3 py-2">
          <div class="text-sm font-medium">${m.senderDisplayName}</div>
          <div class="font-mono text-xs text-slate-400" title="${m.senderMemberId}">
            ${truncate(m.senderMemberId, 16)}
          </div>
        </td>
        <td class="px-3 py-2">
          <span class="flex items-center gap-1 text-xs text-slate-500"
            >${typeIcon(m.type)} ${m.type}</span
          >
        </td>
        <td class="max-w-[16rem] px-3 py-2 text-sm break-words text-slate-700 lg:max-w-md">
          ${m.textBody ? truncate(m.textBody, 140) : html`<span class="text-slate-300">—</span>`}
          ${
            m.mediaError
              ? html`<div class="mt-1 text-xs text-red-600">
                  file: ${truncate(m.mediaError, 80)}
                </div>`
              : null
          }
        </td>
        <td class="px-3 py-2">${mediaCell(m)}</td>
        <td class="px-3 py-2">
          ${
            m.published
              ? badge('published', 'green')
              : html`<div class="flex flex-col gap-1">
                  ${badge('not published', 'slate')}
                  <span class="text-xs text-slate-400">${reasons.join(' · ')}</span>
                </div>`
          }
        </td>
        <td class="px-3 py-2">
          <div class="flex flex-wrap gap-1">${actions}</div>
        </td>
      </tr>`;
    });

    const pager = html`<div class="mt-4 flex items-center justify-between text-sm text-slate-500">
      <span>${total} message(s) · page ${f.page} / ${lastPage}</span>
      <span class="flex gap-2">
        ${
          f.page > 1
            ? html`<a class="underline" href="/messages${filterQueryString(f, f.page - 1)}"
                >← prev</a
              >`
            : null
        }
        ${
          f.page < lastPage
            ? html`<a class="underline" href="/messages${filterQueryString(f, f.page + 1)}"
                >next →</a
              >`
            : null
        }
      </span>
    </div>`;

    const body = html`
      ${pageHeader('Messages', 'Browse the captured archive; takedown removes from the published set')}
      ${flashBanner} ${filterBar}
      <div class="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table class="w-full min-w-[56rem] text-left">
          <thead>
            <tr class="text-xs font-semibold uppercase tracking-wide text-slate-400">
              <th class="px-3 py-2">Sent</th>
              <th class="px-3 py-2">Sender</th>
              <th class="px-3 py-2">Type</th>
              <th class="px-3 py-2">Text</th>
              <th class="px-3 py-2">Media</th>
              <th class="px-3 py-2">State</th>
              <th class="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length > 0
                ? rows
                : html`<tr>
                    <td colspan="7" class="px-3 py-8 text-center text-sm text-slate-400">
                      No messages match the current filters.
                    </td>
                  </tr>`
            }
          </tbody>
        </table>
      </div>
      ${pager}
    `;

    reply.type('text/html');
    return page({
      title: 'Messages',
      active: 'messages',
      csrfToken: csrf,
      body,
    });
  });

  /** Shared implementation for the audited moderation actions. */
  async function moderationAction(
    req: { params: { id: string }; body: unknown; session: { username: string } | null },
    reply: {
      redirect: (url: string) => unknown;
      code: (c: number) => { send: (b: unknown) => unknown };
    },
    action: 'takedown' | 'restore' | 'delete' | 'undelete',
  ): Promise<unknown> {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: 'bad id' });

    const message = await getAdminMessage(ctx.db, id);
    if (!message) return reply.code(404).send({ error: 'message not found' });

    // An in-group deletion is the member's decision and can never be undone into
    // publication (briefing §5) — the admin console must not be able to restore it.
    if (action === 'undelete' && message.groupDeleted) {
      return reply.code(409).send({ error: 'message was deleted in-group; cannot be restored' });
    }

    let changed = false;
    switch (action) {
      case 'takedown':
        changed = await setModerationState(ctx.db, id, 'rejected');
        break;
      case 'restore':
        changed = await setModerationState(ctx.db, id, 'none');
        break;
      case 'delete':
        changed = await setDeletedById(ctx.db, id, true);
        break;
      case 'undelete':
        changed = await setDeletedById(ctx.db, id, false);
        break;
    }

    if (changed) {
      await writeAudit(
        ctx.db,
        req.session?.username ?? 'unknown',
        `message.${action}`,
        `message:${id}`,
        {
          senderMemberId: message.senderMemberId,
          type: message.type,
          sentAt: message.sentAt,
          wasPublished: message.published,
        },
      );
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const back = typeof body['back'] === 'string' && BACK_RE.test(body['back']) ? body['back'] : '';
    // Flash confirmation so the operator SEES the result (the derived `published`
    // state may not change — e.g. a message with no member consent — which
    // otherwise makes a working action look inert).
    const flash = changed ? action : 'nochange';
    const sep = back.includes('?') ? '&' : '?';
    return reply.redirect(`/messages${back}${sep}flash=${flash}`);
  }

  app.post<{ Params: { id: string } }>('/messages/:id/takedown', (req, reply) =>
    moderationAction(req, reply, 'takedown'),
  );
  app.post<{ Params: { id: string } }>('/messages/:id/restore', (req, reply) =>
    moderationAction(req, reply, 'restore'),
  );
  app.post<{ Params: { id: string } }>('/messages/:id/delete', (req, reply) =>
    moderationAction(req, reply, 'delete'),
  );
  app.post<{ Params: { id: string } }>('/messages/:id/undelete', (req, reply) =>
    moderationAction(req, reply, 'undelete'),
  );
}
