/**
 * Embed instances (A4): the widget-config admin UI + copy-paste snippet
 * generator. All design/theme/filter decisions live HERE, centrally — the host
 * page only ever carries the dumb iframe tag. The public /embed/<instance-id>
 * route and the widget rendering itself are a later season.
 */

import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../db/audit.js';
import {
  createEmbedInstance,
  deleteEmbedInstance,
  getEmbedInstance,
  listEmbedInstances,
  normalizeEmbedSettings,
  updateEmbedInstance,
  type EmbedSettings,
} from '../../db/embeds.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { badge, card, fmtDate, pageHeader } from './ui.js';

/** Builds the ready-to-paste host-page snippet for an instance. */
export function embedSnippet(publicOrigin: string, instanceId: string): string {
  const src = `${publicOrigin}/embed/${instanceId}`;
  return [
    `<iframe src="${src}" style="width:100%;border:0" title="Archive"></iframe>`,
    `<script>addEventListener("message",e=>{if(e.origin==="${publicOrigin}"&&e.data&&e.data.cinderellaEmbedHeight)for(const f of document.querySelectorAll("iframe"))if(f.contentWindow===e.source)f.style.height=e.data.cinderellaEmbedHeight+"px"})</script>`,
  ].join('\n');
}

/** Reads the flat embed-settings form fields into EmbedSettings (checkbox-safe). */
function settingsFromForm(body: Record<string, unknown>): EmbedSettings {
  const s = (k: string): unknown => body[k];
  return normalizeEmbedSettings({
    theme: {
      mode: s('mode'),
      colorAccent: s('colorAccent'),
      colorBackground: s('colorBackground'),
      colorText: s('colorText'),
    },
    layout: s('layout'),
    // Unchecked checkboxes are absent from form posts — absent means FALSE here,
    // so pass explicit booleans instead of letting defaults kick in.
    filters: {
      byType: s('f_byType') === 'on',
      byTime: s('f_byTime') === 'on',
      search: s('f_search') === 'on',
    },
    media: {
      text: s('m_text') === 'on',
      image: s('m_image') === 'on',
      video: s('m_video') === 'on',
      voice: s('m_voice') === 'on',
      file: s('m_file') === 'on',
      link: s('m_link') === 'on',
    },
  });
}

function checkbox(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} class="rounded" />
    ${label}
  </label>`;
}

function colorField(name: string, label: string, value: string): SafeHtml {
  return html`<label
    class="flex items-center justify-between gap-2 text-sm sm:flex-col sm:items-start"
  >
    <span class="text-slate-600">${label}</span>
    <input
      type="color"
      name="${name}"
      value="${value}"
      class="h-9 w-16 rounded border border-slate-300"
    />
  </label>`;
}

export function registerEmbeds(app: FastifyInstance, ctx: ViewContext): void {
  app.get('/embeds', async (req, reply) => {
    const instances = await listEmbedInstances(ctx.db);
    const csrf = req.session?.csrfToken ?? '';

    const body = html`
      ${pageHeader(
        'Embed instances',
        'Widget design lives here, centrally — host pages only carry the iframe tag. The public widget ships in a later season.',
      )}
      <div class="flex flex-col gap-6">
        ${card(
          'Instances',
          instances.length > 0
            ? html`<ul class="flex flex-col">
                ${instances.map(
                  (i) =>
                    html`<li
                      class="flex flex-col gap-1 border-t border-slate-100 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4"
                    >
                      <a href="/embeds/${i.id}" class="font-medium underline">${i.name}</a>
                      <span class="font-mono text-xs text-slate-400">${i.id}</span>
                      <span class="flex gap-1"
                        >${badge(i.settings.theme.mode)} ${badge(i.settings.layout)}</span
                      >
                      <span class="text-xs text-slate-400 sm:ml-auto"
                        >updated ${fmtDate(i.updatedAt)}</span
                      >
                    </li>`,
                )}
              </ul>`
            : html`<p class="text-sm text-slate-500">
                No embed instances yet — create one below.
              </p>`,
        )}
        ${card(
          'Create instance',
          html`<form
            method="post"
            action="/embeds"
            class="flex flex-col gap-3 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="_csrf" value="${csrf}" />
            <label class="flex flex-1 flex-col gap-1 text-sm">
              <span class="font-medium text-slate-600">Name (internal label)</span>
              <input
                name="name"
                required
                maxlength="80"
                class="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <button
              type="submit"
              class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Create
            </button>
          </form>`,
        )}
      </div>
    `;

    reply.type('text/html');
    return page({ title: 'Embeds', active: 'embeds', csrfToken: csrf, body });
  });

  app.post('/embeds', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? body['name'].trim().slice(0, 80) : '';
    if (!name) return reply.redirect('/embeds');
    const instance = await createEmbedInstance(ctx.db, name);
    await writeAudit(
      ctx.db,
      req.session?.username ?? 'unknown',
      'embed.create',
      `embed:${instance.id}`,
      {
        name,
      },
    );
    return reply.redirect(`/embeds/${instance.id}`);
  });

  app.get<{ Params: { id: string }; Querystring: { saved?: string } }>(
    '/embeds/:id',
    async (req, reply) => {
      const instance = await getEmbedInstance(ctx.db, req.params.id);
      if (!instance) return reply.code(404).send({ error: 'embed instance not found' });
      const csrf = req.session?.csrfToken ?? '';
      const s = instance.settings;
      const snippet = embedSnippet(ctx.adminCfg.publicOrigin, instance.id);

      const body = html`
        ${pageHeader(`Embed: ${instance.name}`, `Instance ${instance.id}`)}
        ${
          req.query.saved
            ? html`<p
                class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
              >
                Saved — all embeds of this instance update instantly.
              </p>`
            : null
        }
        <form method="post" action="/embeds/${instance.id}" class="flex flex-col gap-6">
          <input type="hidden" name="_csrf" value="${csrf}" />
          ${card(
            'Name',
            html`<input
              name="name"
              value="${instance.name}"
              required
              maxlength="80"
              class="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm sm:max-w-md"
            />`,
          )}
          ${card(
            'Theme',
            html`<div class="flex flex-col gap-4">
              <label class="flex flex-col gap-1 text-sm sm:max-w-xs">
                <span class="font-medium text-slate-600">Mode</span>
                <select name="mode" class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                  ${(['auto', 'light', 'dark'] as const).map(
                    (m) =>
                      html`<option value="${m}" ${m === s.theme.mode ? raw('selected') : ''}>
                        ${m}
                      </option>`,
                  )}
                </select>
              </label>
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:max-w-md">
                ${colorField('colorAccent', 'Accent', s.theme.colorAccent)}
                ${colorField('colorBackground', 'Background', s.theme.colorBackground)}
                ${colorField('colorText', 'Text', s.theme.colorText)}
              </div>
            </div>`,
          )}
          ${card(
            'Layout',
            html`<select
              name="layout"
              class="rounded-lg border border-slate-300 px-2 py-1.5 text-sm sm:max-w-xs"
            >
              ${(['list', 'grid'] as const).map(
                (l) =>
                  html`<option value="${l}" ${l === s.layout ? raw('selected') : ''}>${l}</option>`,
              )}
            </select>`,
          )}
          ${card(
            'Enabled filters (visitor-facing)',
            html`<div class="flex flex-col gap-2 sm:flex-row sm:gap-6">
              ${checkbox('f_byType', 'Filter by media type', s.filters.byType)}
              ${checkbox('f_byTime', 'Filter by time', s.filters.byTime)}
              ${checkbox('f_search', 'Full-text search', s.filters.search)}
            </div>`,
          )}
          ${card(
            'Visible media types',
            html`<div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              ${checkbox('m_text', 'Text', s.media.text)}
              ${checkbox('m_image', 'Images', s.media.image)}
              ${checkbox('m_video', 'Videos', s.media.video)}
              ${checkbox('m_voice', 'Voice', s.media.voice)}
              ${checkbox('m_file', 'Files', s.media.file)}
              ${checkbox('m_link', 'Links', s.media.link)}
            </div>`,
          )}
          <div class="flex gap-3">
            <button
              type="submit"
              class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Save
            </button>
            <a href="/embeds" class="px-2 py-2 text-sm text-slate-500 underline">Back</a>
          </div>
        </form>

        ${card(
          'Copy-paste snippet',
          html`<p class="mb-2 text-xs text-slate-500">
              Paste into any host page. Content, design, and filters stay centralized here — the
              auto-height script keeps the iframe sized. (The /embed route goes live with the
              public-front season.)
            </p>
            <textarea
              readonly
              rows="4"
              class="w-full rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-xs"
            >
${snippet}</textarea>`,
        )}

        <!-- CSP forbids inline JS, so deletion uses a two-step confirm checkbox
             instead of confirm(). -->
        <form
          method="post"
          action="/embeds/${instance.id}/delete"
          class="mt-6 flex items-center gap-3"
        >
          <input type="hidden" name="_csrf" value="${csrf}" />
          <label class="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" name="confirm" required class="rounded" />
            I understand host pages using this instance will show nothing
          </label>
          <button
            type="submit"
            class="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            Delete instance
          </button>
        </form>
      `;

      reply.type('text/html');
      return page({ title: `Embed ${instance.name}`, active: 'embeds', csrfToken: csrf, body });
    },
  );

  app.post<{ Params: { id: string } }>('/embeds/:id', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).send({ error: 'embed instance not found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name =
      typeof body['name'] === 'string' && body['name'].trim().length > 0
        ? body['name'].trim().slice(0, 80)
        : instance.name;
    const settings = settingsFromForm(body);
    await updateEmbedInstance(ctx.db, instance.id, name, settings);
    await writeAudit(
      ctx.db,
      req.session?.username ?? 'unknown',
      'embed.update',
      `embed:${instance.id}`,
      {
        name,
        settings,
      },
    );
    return reply.redirect(`/embeds/${instance.id}?saved=1`);
  });

  app.post<{ Params: { id: string } }>('/embeds/:id/delete', async (req, reply) => {
    const instance = await getEmbedInstance(ctx.db, req.params.id);
    if (!instance) return reply.code(404).send({ error: 'embed instance not found' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body['confirm'] !== 'on') return reply.redirect(`/embeds/${instance.id}`);
    await deleteEmbedInstance(ctx.db, instance.id);
    await writeAudit(
      ctx.db,
      req.session?.username ?? 'unknown',
      'embed.delete',
      `embed:${instance.id}`,
      {
        name: instance.name,
      },
    );
    return reply.redirect('/embeds');
  });
}
