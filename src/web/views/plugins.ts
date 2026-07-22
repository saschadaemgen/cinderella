/**
 * Plugin console (CCB-S3-004 §0).
 *
 * Two surfaces: a list of installed plugins with their on/off switch, and one
 * page per plugin owning its own settings. The list is generated from the
 * registry, so a second plugin appears here with no change to this file beyond
 * its own page.
 *
 * API KEYS ARE WRITE-ONLY. The form shows whether a key is set, never the key.
 * Submitting with the field blank keeps the stored key; clearing is an explicit
 * checkbox. Nothing here ever renders or logs a key value.
 */

import type { FastifyInstance } from 'fastify';
import { html, page, raw, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { card, pageHeader } from './ui.js';
import { CRYPTO_PRICES_ID } from '../../plugins/crypto-prices/plugin.js';
import { providerKeyStatus } from '../../plugins/crypto-prices/settings.js';
import { CryptoPriceService } from '../../plugins/crypto-prices/service.js';
import {
  deleteMapping,
  listMappings,
  updateMapping,
  upsertMapping,
} from '../../db/asset-mappings.js';

const INPUT = 'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm';

function text(name: string, value: string, placeholder = ''): SafeHtml {
  return html`<input
    name="${name}"
    value="${value}"
    placeholder="${placeholder}"
    class="${INPUT}"
  />`;
}
function number(name: string, value: number, min: number, max: number): SafeHtml {
  return html`<input
    name="${name}"
    type="number"
    min="${String(min)}"
    max="${String(max)}"
    value="${String(value)}"
    class="${INPUT} sm:w-40"
  />`;
}
function check(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} class="rounded" />
    ${label}
  </label>`;
}
function field(label: string, control: SafeHtml, help?: string): SafeHtml {
  return html`<label class="flex flex-col gap-1 text-sm">
    <span class="font-medium text-slate-700">${label}</span>
    ${control} ${help ? html`<span class="text-xs text-slate-500">${help}</span>` : null}
  </label>`;
}
function save(label = 'Save'): SafeHtml {
  return html`<button
    type="submit"
    class="self-start rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
  >
    ${label}
  </button>`;
}

export function registerPlugins(app: FastifyInstance, ctx: ViewContext): void {
  const { plugins, db } = ctx;

  /* ── The plugin list ─────────────────────────────────────────────────── */

  app.get<{ Querystring: { saved?: string; error?: string } }>('/plugins', async (req, reply) => {
    const csrf = req.session?.csrfToken ?? '';
    const list = plugins.list();

    const body = html`
      ${pageHeader('Plugins', 'Capabilities beyond the archive itself')}
      ${
        req.query.saved
          ? html`<div
              class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              Saved.
            </div>`
          : null
      }
      <div
        class="mb-6 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <p class="font-semibold">A disabled plugin is not merely idle.</p>
        <p class="mt-1">
          Switching a plugin off removes the intents it contributes from the catalog entirely.
          Cinderella stops understanding those questions rather than understanding them and
          declining, so nothing half-wired can run behind a switch that is off.
        </p>
      </div>
      <div class="flex flex-col gap-4">
        ${list.map(
          (p) => html`
            <section class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h2 class="text-sm font-semibold">
                    <a class="hover:underline" href="${p.adminPath}">${p.name}</a>
                    <span class="ml-2 text-xs font-normal text-slate-400">v${p.version}</span>
                  </h2>
                  <p class="mt-1 max-w-2xl text-sm text-slate-500">${p.description}</p>
                </div>
                <form method="post" action="/plugins/${p.id}/toggle" class="shrink-0">
                  <input type="hidden" name="_csrf" value="${csrf}" />
                  <input type="hidden" name="enabled" value="${p.enabled ? 'off' : 'on'}" />
                  <button
                    type="submit"
                    class="rounded-lg px-3 py-1.5 text-sm font-medium ${
                      p.enabled
                        ? 'border border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'border border-slate-300 bg-slate-50 text-slate-600 hover:bg-slate-100'
                    }"
                  >
                    ${p.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  </button>
                </form>
              </div>
              <p class="mt-3 text-xs text-slate-400">
                Settings: <a class="underline" href="${p.adminPath}">${p.adminPath}</a>
              </p>
            </section>
          `,
        )}
      </div>
    `;
    reply.type('text/html');
    return page({ title: 'Plugins', active: 'plugins', csrfToken: csrf, body });
  });

  app.post<{ Params: { id: string } }>('/plugins/:id/toggle', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const enabled = body['enabled'] === 'on';
    try {
      await plugins.setEnabled(req.params.id, enabled, req.session?.username ?? 'unknown');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not change the plugin.';
      return reply.redirect(`/plugins?error=${encodeURIComponent(message)}`);
    }
    return reply.redirect('/plugins?saved=1');
  });

  /* ── Crypto Prices ───────────────────────────────────────────────────── */

  app.get<{ Querystring: { saved?: string; error?: string } }>(
    '/plugins/crypto-prices',
    async (req, reply) => {
      const csrf = req.session?.csrfToken ?? '';
      const s = plugins.getCryptoPrices();
      const enabled = plugins.isEnabled(CRYPTO_PRICES_ID);
      const mappings = await listMappings(db, 100);
      const service = new CryptoPriceService({ db, settings: () => s });
      const status = service.providerStatus();

      const form = (section: string, inner: SafeHtml): SafeHtml =>
        html`<form method="post" action="/plugins/crypto-prices" class="flex flex-col gap-3">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <input type="hidden" name="section" value="${section}" />
          ${inner}
        </form>`;

      const statusCard = card(
        'Status',
        html`<p class="mb-3 text-sm ${enabled ? 'text-emerald-700' : 'text-amber-700'}">
            ${
              enabled
                ? 'Enabled — price questions are understood.'
                : 'Disabled — price questions are not in the intent catalog at all.'
            }
          </p>
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr
                  class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"
                >
                  <th class="py-2 pr-3">Provider</th>
                  <th class="py-2 pr-3">Usable</th>
                  <th class="py-2 pr-3">Last result</th>
                  <th class="py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                ${status.map(
                  (p) =>
                    html`<tr class="border-b border-slate-100 align-top">
                      <td class="py-2 pr-3 font-medium">${p.label}</td>
                      <td class="py-2 pr-3">${p.configured ? 'yes' : 'no'}</td>
                      <td class="py-2 pr-3 text-slate-500">
                        ${p.health ? `${p.health.ok ? 'ok' : 'error'} — ${p.health.detail}` : '—'}
                      </td>
                      <td class="py-2 text-xs text-slate-500">${p.note}</td>
                    </tr>`,
                )}
              </tbody>
            </table>
          </div>`,
      );

      const chainCard = card(
        'Provider chain',
        html`<p class="mb-3 text-sm text-slate-500">
            Tried in this order. A provider that errors, times out, is rate-limited, or does not
            know the asset is skipped and the next one is asked. A provider with no key, where one
            is required, skips itself.
          </p>
          <div
            class="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <p class="font-semibold">
              Licence notes, checked against the providers' current terms.
            </p>
            <p class="mt-1">
              <strong>CoinGecko</strong> requires the credit "Powered by CoinGecko" wherever its
              data is shown; Cinderella appends it to replies it served. Its terms also require
              cached data to be refreshed at least daily, which the cache enforces.
              <strong>CoinMarketCap</strong> requires "Data provided by CoinMarketCap.com", and its
              free tier is licensed for personal use — showing its data to a group may need a paid
              plan. Check your plan before enabling it. <strong>Dexscreener</strong> requires no
              attribution.
            </p>
          </div>
          ${form(
            'chain',
            html`
              ${field(
                'Order',
                text('chain', s.chain.join(', ')),
                'Comma separated. Any provider left out is still available, just last.',
              )}
              ${s.chain.map((name) => {
                const p = s.providers[name];
                if (!p) return null;
                const key = providerKeyStatus(s, name);
                return html`<div class="rounded-lg border border-slate-200 p-3">
                  <div class="mb-2 text-sm font-semibold">${name}</div>
                  ${check(`providers.${name}.enabled`, 'Enabled', p.enabled)}
                  <div class="mt-2 grid gap-2 sm:grid-cols-2">
                    ${field(
                      'API key',
                      html`<input
                        name="providers.${name}.apiKey"
                        type="password"
                        value=""
                        autocomplete="off"
                        placeholder="${key.set ? 'A key is stored — leave blank to keep it' : 'No key stored'}"
                        class="${INPUT}"
                      />`,
                      key.set
                        ? 'A key is stored and is never shown again. Leave blank to keep it.'
                        : 'Blank means no key. Stored encrypted; never displayed or logged.',
                    )}
                    ${field('Timeout (ms)', number(`providers.${name}.timeoutMs`, p.timeoutMs, 1000, 30000))}
                    ${field(
                      'Requests per minute',
                      number(`providers.${name}.rateLimitPerMinute`, p.rateLimitPerMinute, 1, 600),
                    )}
                    <div class="flex items-end">
                      ${check(`providers.${name}.clearApiKey`, 'Remove the stored key', false)}
                    </div>
                  </div>
                </div>`;
              })}
              ${save()}
            `,
          )}`,
      );

      const behaviourCard = card(
        'Answering',
        form(
          'behaviour',
          html`
            ${field(
              'Default quote currency',
              text('baseCurrency', s.baseCurrency),
              'Prices default to this, and asset-to-asset conversions are crossed through it.',
            )}
            ${field(
              'Price cache lifetime (seconds)',
              number('cacheTtlSeconds', s.cacheTtlSeconds, 5, 3600),
              'How long a quote is reused. Prices are always fetched on request; this only stops a busy group burning the provider quota.',
            )}
            ${field(
              'Price questions per member, per minute',
              number('rateLimitPerMember', s.rateLimitPerMember, 1, 120),
            )}
            ${field(
              'Price questions per chat, per minute',
              number('rateLimitPerChat', s.rateLimitPerChat, 1, 600),
            )}
            ${field(
              'Disclaimer (optional, off by default)',
              text('disclaimer', s.disclaimer, 'Market data for information only.'),
              'Appended to every price reply. Empty means none.',
            )}
            ${save()}
          `,
        ),
      );

      const mappingCard = card(
        'Pinned assets',
        html`<p class="mb-3 text-sm text-slate-500">
            A symbol is resolved once and then pinned here, so the same question always means the
            same asset. Deleting a row makes the next question resolve it again.
            <strong>Locked</strong> rows are never touched by automatic resolution, which is how a
            contested ticker stays pinned to the asset you chose.
          </p>
          <div class="mb-4 overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr
                  class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"
                >
                  <th class="py-2 pr-3">Symbol</th>
                  <th class="py-2 pr-3">Asset</th>
                  <th class="py-2 pr-3">Chain / contract</th>
                  <th class="py-2 pr-3">Provider ids</th>
                  <th class="py-2 pr-3">Source</th>
                  <th class="py-2"></th>
                </tr>
              </thead>
              <tbody>
                ${
                  mappings.length === 0
                    ? html`<tr>
                        <td colspan="6" class="py-3 text-sm text-slate-500">
                          Nothing pinned yet. The first time someone asks about a symbol it is
                          resolved and recorded here.
                        </td>
                      </tr>`
                    : mappings.map(
                        (m) =>
                          html`<tr class="border-b border-slate-100 align-top">
                            <td class="py-2 pr-3 font-medium">
                              ${m.symbol}${m.locked ? html` <span class="text-xs text-amber-700">locked</span>` : null}
                            </td>
                            <td class="py-2 pr-3">${m.displayName}</td>
                            <td class="py-2 pr-3 break-all text-xs text-slate-500">
                              ${m.chain ?? '—'}${m.contract ? html`<br />${m.contract}` : null}
                            </td>
                            <td class="py-2 pr-3 text-xs text-slate-500">
                              ${
                              Object.entries(m.providerIds)
                                .map(([k, v]) => `${k}=${v}`)
                                .join(', ') || '—'
                            }
                            </td>
                            <td class="py-2 pr-3 text-xs text-slate-500">${m.source}</td>
                            <td class="py-2">
                              <div class="flex gap-2">
                                <form method="post" action="/plugins/crypto-prices">
                                  <input type="hidden" name="_csrf" value="${csrf}" />
                                  <input type="hidden" name="section" value="mapping-lock" />
                                  <input type="hidden" name="id" value="${String(m.id)}" />
                                  <input
                                    type="hidden"
                                    name="locked"
                                    value="${m.locked ? 'off' : 'on'}"
                                  />
                                  <button
                                    class="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                                  >
                                    ${m.locked ? 'Unlock' : 'Lock'}
                                  </button>
                                </form>
                                <form method="post" action="/plugins/crypto-prices">
                                  <input type="hidden" name="_csrf" value="${csrf}" />
                                  <input type="hidden" name="section" value="mapping-delete" />
                                  <input type="hidden" name="id" value="${String(m.id)}" />
                                  <button
                                    class="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                                  >
                                    Delete
                                  </button>
                                </form>
                              </div>
                            </td>
                          </tr>`,
                      )
                }
              </tbody>
            </table>
          </div>
          ${form(
            'mapping-add',
            html`
              <div class="text-sm font-semibold">Add or override a mapping</div>
              <div class="grid gap-2 sm:grid-cols-2">
                ${field('Symbol', text('symbol', '', 'HEX'))}
                ${field('Display name', text('displayName', '', 'HEX'))}
                ${field('Chain', text('chain', '', 'ethereum'))}
                ${field('Contract', text('contract', '', '0x…'))}
                ${field(
                  'Provider ids',
                  text('providerIds', '', 'coingecko=hex, coinmarketcap=5015'),
                  'Comma separated name=id pairs. Dexscreener needs no id, only chain and contract.',
                )}
                ${field('Decimals', number('decimals', 8, 0, 18))}
              </div>
              ${check('locked', 'Lock this mapping (automatic resolution will never change it)', true)}
              ${save('Add mapping')}
            `,
          )}`,
      );

      const body = html`
        ${pageHeader('Crypto Prices', 'Market data, pinned to the assets you actually mean')}
        ${
          req.query.saved
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
              : null
        }
        <div class="flex flex-col gap-6">
          ${statusCard} ${chainCard} ${behaviourCard} ${mappingCard}
        </div>
      `;
      reply.type('text/html');
      return page({
        title: 'Crypto Prices',
        active: `plugin:${CRYPTO_PRICES_ID}`,
        csrfToken: csrf,
        body,
      });
    },
  );

  app.post('/plugins/crypto-prices', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const section = typeof body['section'] === 'string' ? body['section'] : '';
    const actor = req.session?.username ?? 'unknown';
    const str = (k: string): string => (typeof body[k] === 'string' ? body[k] : '');

    try {
      if (section === 'chain') {
        const current = plugins.getCryptoPrices();
        const providers: Record<string, unknown> = {};
        for (const name of Object.keys(current.providers)) {
          providers[name] = {
            enabled: `providers.${name}.enabled` in body,
            apiKey: str(`providers.${name}.apiKey`),
            clearApiKey: `providers.${name}.clearApiKey` in body,
            timeoutMs: str(`providers.${name}.timeoutMs`),
            rateLimitPerMinute: str(`providers.${name}.rateLimitPerMinute`),
          };
        }
        await plugins.saveCryptoPrices({ chain: str('chain'), providers }, actor);
      } else if (section === 'behaviour') {
        await plugins.saveCryptoPrices(
          {
            baseCurrency: str('baseCurrency'),
            cacheTtlSeconds: str('cacheTtlSeconds'),
            rateLimitPerMember: str('rateLimitPerMember'),
            rateLimitPerChat: str('rateLimitPerChat'),
            disclaimer: str('disclaimer'),
          },
          actor,
        );
      } else if (section === 'mapping-add') {
        const ids: Record<string, string> = {};
        for (const pair of str('providerIds').split(',')) {
          const [k, v] = pair.split('=').map((x) => x.trim());
          if (k && v) ids[k.toLowerCase()] = v;
        }
        const symbol = str('symbol').trim();
        if (!symbol) throw new Error('A symbol is required.');
        await upsertMapping(db, {
          symbol,
          displayName: str('displayName').trim() || symbol.toUpperCase(),
          chain: str('chain').trim() || null,
          contract: str('contract').trim() || null,
          decimals: Number.parseInt(str('decimals'), 10) || 8,
          providerIds: ids,
          source: 'manual',
          locked: 'locked' in body,
        });
      } else if (section === 'mapping-delete') {
        await deleteMapping(db, Number.parseInt(str('id'), 10));
      } else if (section === 'mapping-lock') {
        await updateMapping(db, Number.parseInt(str('id'), 10), { locked: str('locked') === 'on' });
      } else {
        return reply.redirect(
          `/plugins/crypto-prices?error=${encodeURIComponent('Unknown section.')}`,
        );
      }
      return reply.redirect('/plugins/crypto-prices?saved=1');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save.';
      return reply.redirect(`/plugins/crypto-prices?error=${encodeURIComponent(message)}`);
    }
  });
}
