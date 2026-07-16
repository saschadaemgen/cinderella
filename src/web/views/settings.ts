/**
 * Configuration editor (A3): live-editable settings persisted to `settings`
 * (applied without restart, audited). Boot/secret settings are DISPLAY-ONLY —
 * secrets are never rendered, not even masked previews of their values.
 */

import type { FastifyInstance } from 'fastify';
import { redactConfig } from '../../config.js';
import { writeAudit } from '../../db/audit.js';
import { SETTING_DEFS } from '../../settings/service.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { card, pageHeader } from './ui.js';

function liveField(key: string, current: string): SafeHtml {
  if (key === 'logLevel') {
    return html`<select
      name="value"
      class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm sm:w-40"
    >
      ${(['error', 'warn', 'info', 'debug'] as const).map(
        (lvl) =>
          html`<option value="${lvl}" ${lvl === current ? raw('selected') : ''}>${lvl}</option>`,
      )}
    </select>`;
  }
  return html`<input
    name="value"
    type="number"
    min="1"
    value="${current}"
    class="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm sm:w-40"
  />`;
}

export function registerSettings(app: FastifyInstance, ctx: ViewContext): void {
  app.get<{ Querystring: { saved?: string; error?: string } }>('/settings', async (req, reply) => {
    const live = ctx.settings.get();
    const csrf = req.session?.csrfToken ?? '';
    const savedKey = req.query.saved;
    const errorMsg = req.query.error;

    const liveRows = SETTING_DEFS.map((def) => {
      const current = String(live[def.key]);
      return html`<form
        method="post"
        action="/settings"
        class="flex flex-col gap-2 border-t border-slate-100 py-3 first:border-t-0 sm:flex-row sm:items-center sm:gap-4"
      >
        <input type="hidden" name="_csrf" value="${csrf}" />
        <input type="hidden" name="key" value="${def.key}" />
        <div class="sm:w-64">
          <div class="text-sm font-medium">
            ${def.label}
            ${
              savedKey === def.key
                ? html`<span class="ml-2 text-xs font-semibold text-emerald-600">saved ✓</span>`
                : null
            }
          </div>
          <div class="text-xs text-slate-500">${def.help}</div>
        </div>
        ${liveField(def.key, current)}
        <button
          type="submit"
          class="self-start rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 sm:self-auto"
        >
          Save
        </button>
      </form>`;
    });

    const boot = redactConfig(ctx.cfg);
    const bootRows: [string, string][] = [
      ['Bot display name', boot['botDisplayName'] ?? ''],
      ['SimpleX DB prefix', boot['simplexDbPrefix'] ?? ''],
      ['SimpleX files folder', boot['simplexFilesFolder'] ?? ''],
      ['Group scope', boot['groupName'] ?? ''],
      ['Media root', boot['mediaRoot'] ?? ''],
      ['Database', boot['databaseUrl'] ?? ''],
      ['Admin port', `127.0.0.1:${ctx.adminCfg.adminPort} (behind nginx TLS)`],
      ['Admin username', ctx.adminCfg.adminUsername],
      ['Admin password', 'Argon2id hash — set via environment, never shown'],
      ['Session secret', 'set via environment, never shown'],
      ['Public origin', ctx.adminCfg.publicOrigin],
    ];

    const body = html`
      ${pageHeader('Settings', 'Live settings apply immediately; boot settings require a restart')}
      ${
        errorMsg
          ? html`<p
              class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              ${errorMsg}
            </p>`
          : null
      }
      <div class="flex flex-col gap-6">
        ${card('Live settings (editable)', html`<div>${liveRows}</div>`)}
        ${card(
          'Boot settings (environment — read-only)',
          html`<dl class="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[14rem_1fr]">
            ${bootRows.map(
              ([k, v]) => html`
                <dt class="font-medium text-slate-500">${k}</dt>
                <dd class="break-all text-slate-700">${v}</dd>
              `,
            )}
          </dl>`,
        )}
      </div>
    `;

    reply.type('text/html');
    return page({ title: 'Settings', active: 'settings', csrfToken: csrf, body });
  });

  app.post('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body['key'] === 'string' ? body['key'] : '';
    const value = typeof body['value'] === 'string' ? body['value'] : '';

    try {
      const applied = await ctx.settings.set(key, value);
      await writeAudit(
        ctx.db,
        req.session?.username ?? 'unknown',
        'settings.update',
        `setting:${key}`,
        {
          value: applied,
        },
      );
      return reply.redirect(`/settings?saved=${encodeURIComponent(key)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid value.';
      return reply.redirect(`/settings?error=${encodeURIComponent(message)}`);
    }
  });
}
