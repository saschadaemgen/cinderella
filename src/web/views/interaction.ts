/**
 * Interaction console (CCB-S3-002 §7) — how Cinderella listens, and every word
 * she says in chat.
 *
 * Each card posts one SECTION. The handler merges that section into the stored
 * settings and re-normalises the whole object, so a form that omits a field can
 * never blank an unrelated one, and an operator can never save a wake word of
 * `""` or a confidence threshold of `9`.
 *
 * Persona copy is edited here rather than in `locales/` on purpose: this is chat
 * voice, it is per-instance, and an operator changing how she speaks to their
 * community should not need file access to the server. Blanking a field restores
 * that string's shipped default rather than muting her.
 */

import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_INTERACTION,
  PERSONA_KEYS,
  SHIPPED_LANGS,
  type InteractionSettings,
  type PersonaKey,
} from '../../interaction/settings.js';
import { activeResolverName } from '../../interaction/resolver.js';
import { html, page, raw, type SafeHtml } from '../html.js';
import type { ViewContext } from '../server.js';
import { card, pageHeader } from './ui.js';

const INPUT_CLS = 'w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm';

function textField(name: string, value: string, placeholder = ''): SafeHtml {
  return html`<input
    name="${name}"
    value="${value}"
    placeholder="${placeholder}"
    class="${INPUT_CLS}"
  />`;
}

function numberField(name: string, value: number, min: number, max: number, step = '1'): SafeHtml {
  return html`<input
    name="${name}"
    type="number"
    min="${String(min)}"
    max="${String(max)}"
    step="${step}"
    value="${String(value)}"
    class="${INPUT_CLS} sm:w-40"
  />`;
}

function checkbox(name: string, label: string, checked: boolean): SafeHtml {
  return html`<label class="flex items-center gap-2 text-sm">
    <input type="checkbox" name="${name}" ${checked ? raw('checked') : ''} class="rounded" />
    ${label}
  </label>`;
}

function labelled(text: string, control: SafeHtml, help?: string): SafeHtml {
  return html`<label class="flex flex-col gap-1 text-sm">
    <span class="font-medium text-slate-700">${text}</span>
    ${control} ${help ? html`<span class="text-xs text-slate-500">${help}</span>` : null}
  </label>`;
}

function textArea(name: string, value: string, rows: number): SafeHtml {
  return html`<textarea name="${name}" rows="${String(rows)}" class="${INPUT_CLS} font-mono">
${value}</textarea>`;
}

function saveButton(): SafeHtml {
  return html`<button
    type="submit"
    class="self-start rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
  >
    Save
  </button>`;
}

/** Human labels and the placeholders each persona string may use. */
const PERSONA_META: Record<PersonaKey, { label: string; vars: string }> = {
  publishConfirm: { label: 'Publish — asking for confirmation', vars: '' },
  published: { label: 'Publish — done', vars: '' },
  unpublishConfirm: { label: 'Unpublish — asking for confirmation', vars: '' },
  unpublished: { label: 'Unpublish — done', vars: '' },
  refuseThirdParty: { label: 'Refusing to act for someone else', vars: '{name}' },
  status: { label: 'Status answer', vars: '{total} {public}' },
  searchResult: { label: 'Search answer', vars: '{n} {query}' },
  notUnderstood: { label: 'Not understood', vars: '' },
  undo: { label: 'Undo — done', vars: '' },
  undoNothing: { label: 'Undo — nothing to undo', vars: '' },
  cancelled: { label: 'Confirmation declined', vars: '' },
  help: { label: 'Help', vars: '{wake}' },
};

const LANG_LABELS: Record<string, string> = { en: 'English', de: 'Deutsch' };

function langLabel(code: string): string {
  return LANG_LABELS[code] ?? code.toUpperCase();
}

/** Deep copy of the current settings — the base every section edit merges into. */
function cloneSettings(s: InteractionSettings): Record<string, unknown> {
  return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

export function registerInteraction(app: FastifyInstance, ctx: ViewContext): void {
  const { interaction } = ctx;

  app.get<{ Querystring: { saved?: string; error?: string } }>(
    '/interaction',
    async (req, reply) => {
      const s = interaction.get();
      const csrf = req.session?.csrfToken ?? '';

      const notice = req.query.saved
        ? html`<div
            class="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            Saved. Changes apply to the next message she hears — no restart needed.
          </div>`
        : req.query.error
          ? html`<div
              class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              ${req.query.error}
            </div>`
          : null;

      const form = (section: string, inner: SafeHtml): SafeHtml =>
        html`<form method="post" action="/interaction" class="flex flex-col gap-3">
          <input type="hidden" name="_csrf" value="${csrf}" />
          <input type="hidden" name="section" value="${section}" />
          ${inner}
        </form>`;

      const intro = html`<div
        class="mb-6 rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-700"
      >
        <p class="font-semibold">She answers to her name, and only to her name.</p>
        <p class="mt-1">
          A message counts as addressed to her when it <strong>starts</strong> with the wake word
          (an optional greeting may come first), when it replies directly to one of her messages, or
          when it arrives inside the follow-up window after she has just spoken to that member.
          Talking <em>about</em> her — "I think Cinderella is great" — is never an address.
          Publishing and unpublishing always ask for confirmation first, and she will never change
          anyone's consent but the sender's own. Intent resolver in use:
          <code class="rounded bg-slate-100 px-1">${activeResolverName()}</code>.
        </p>
      </div>`;

      const addressing = card(
        'Addressing',
        form(
          'addressing',
          html`
            ${checkbox(
              'naturalAddressing',
              'Natural addressing (she responds to her name)',
              s.naturalAddressing,
            )}
            ${checkbox('slashCommands', 'Slash commands (/publish, /unpublish)', s.slashCommands)}
            ${labelled(
              'Wake word',
              textField('wakeWord', s.wakeWord),
              'Her name. Rename her for your community — small typos in it are still understood.',
            )}
            ${labelled(
              'Greeting prefixes',
              textField('greetings', s.greetings.join(', ')),
              'Comma separated. Allowed in front of the wake word and stripped before the instruction.',
            )}
            ${labelled(
              'Follow-up window (seconds)',
              numberField('followUpSeconds', s.followUpSeconds, 0, 3600),
              'After she replies, that member may keep talking without repeating her name. 0 disables it.',
            )}
            ${labelled(
              'Confidence threshold',
              numberField('confidenceThreshold', s.confidenceThreshold, 0, 1, '0.05'),
              'Below this she asks instead of acting. Higher is more cautious.',
            )}
            ${labelled(
              'Default language',
              textField('defaultLanguage', s.defaultLanguage),
              `Used when the instruction gives no clue. Available: ${Object.keys(s.persona).join(', ')}.`,
            )}
            ${saveButton()}
          `,
        ),
      );

      const safety = card(
        'Confirmation, undo and rate limits',
        html`<p class="mb-3 text-sm text-slate-500">
            Publishing and unpublishing by natural language always take two messages: she asks, the
            member agrees. Slash commands stay immediate.
          </p>
          ${form(
            'safety',
            html`
              ${labelled(
                'Affirmation words',
                textField('affirmations', s.affirmations.join(', ')),
                'Comma separated. Fuzzy matched, so "jup" and "yeah" work without listing every spelling.',
              )}
              ${labelled(
                'Decline words',
                textField('declines', s.declines.join(', ')),
                'Comma separated. Cancels a pending confirmation.',
              )}
              ${labelled(
                'Undo window (seconds)',
                numberField('undoWindowSeconds', s.undoWindowSeconds, 0, 86400),
                'How long a member may undo their own last consent decision. 0 means no time limit.',
              )}
              ${labelled(
                'Replies per member, per minute',
                numberField('replyLimitPerMember', s.replyLimitPerMember, 1, 120),
              )}
              ${labelled(
                'Replies per chat, per minute',
                numberField('replyLimitPerChat', s.replyLimitPerChat, 1, 600),
              )}
              ${saveButton()}
            `,
          )}`,
      );

      const nicknames = card(
        'Nicknames',
        html`<p class="mb-3 text-sm text-slate-500">
            She does not answer to "Cindy". A nickname in the wake-word position earns a retort and
            <strong>nothing else</strong> — the instruction is discarded, no action is taken, and no
            follow-up window opens. Retorts rotate without repeating the previous one in a chat.
          </p>
          ${form(
            'nicknames',
            html`
              ${checkbox('enabled', 'Nickname retorts enabled', s.nicknames.enabled)}
              ${labelled(
                'Nicknames',
                textField('words', s.nicknames.words.join(', ')),
                'Comma separated. Matched exactly, so short names never fire on ordinary words.',
              )}
              ${labelled(
                'Anti-spam limit',
                numberField('spamLimit', s.nicknames.spamLimit, 1, 20),
                'Consecutive nicknames from one member before she stops answering.',
              )}
              ${saveButton()}
            `,
          )}`,
      );

      const personaCards = Object.keys(s.persona)
        .sort()
        .map((lang) =>
          card(
            `Her voice — ${langLabel(lang)}`,
            form(
              `persona:${lang}`,
              html`
                <p class="text-sm text-slate-500">
                  Chat only. The website and legal copy stay professional and are edited elsewhere.
                  Leave a field empty to restore its shipped default.
                </p>
                ${PERSONA_KEYS.map((key) =>
                  labelled(
                    PERSONA_META[key].label,
                    textArea(key, (s.persona[lang] as Record<PersonaKey, string>)[key], 2),
                    PERSONA_META[key].vars ? `Placeholders: ${PERSONA_META[key].vars}` : undefined,
                  ),
                )}
                ${saveButton()}
              `,
            ),
          ),
        );

      const retortCards = Object.keys(s.retorts)
        .sort()
        .map((lang) =>
          card(
            `Nickname retorts — ${langLabel(lang)}`,
            form(
              `retorts:${lang}`,
              html`
                <p class="text-sm text-slate-500">
                  One retort per line. Emptying the list restores the shipped twelve.
                </p>
                ${textArea('retorts', (s.retorts[lang] as string[]).join('\n'), 12)} ${saveButton()}
              `,
            ),
          ),
        );

      const reset = card(
        'Reset',
        html`<p class="mb-3 text-sm text-slate-500">
            Restores every setting on this page — wake word, greetings, limits, persona strings and
            retorts — to the values Cinderella ships with. Consent data is untouched.
          </p>
          ${form(
            'reset',
            html`<button
              type="submit"
              class="self-start rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              Restore defaults
            </button>`,
          )}`,
      );

      const body = html`
        ${pageHeader('Interaction', 'How she is addressed, what she understands, and how she speaks')}
        ${notice} ${intro}
        <div class="flex flex-col gap-6">
          ${addressing} ${safety} ${nicknames} ${personaCards} ${retortCards} ${reset}
        </div>
      `;

      reply.type('text/html');
      return page({ title: 'Interaction', active: 'interaction', csrfToken: csrf, body });
    },
  );

  app.post('/interaction', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const section = bodyString(body, 'section');
    const actor = req.session?.username ?? 'unknown';
    const next = cloneSettings(interaction.get());

    try {
      if (section === 'addressing') {
        // Checkboxes are absent from the body when unticked, so their state is
        // read from presence rather than from a value.
        next['naturalAddressing'] = 'naturalAddressing' in body;
        next['slashCommands'] = 'slashCommands' in body;
        next['wakeWord'] = bodyString(body, 'wakeWord');
        next['greetings'] = bodyString(body, 'greetings');
        next['followUpSeconds'] = bodyString(body, 'followUpSeconds');
        next['confidenceThreshold'] = bodyString(body, 'confidenceThreshold');
        next['defaultLanguage'] = bodyString(body, 'defaultLanguage');
      } else if (section === 'safety') {
        next['affirmations'] = bodyString(body, 'affirmations');
        next['declines'] = bodyString(body, 'declines');
        next['undoWindowSeconds'] = bodyString(body, 'undoWindowSeconds');
        next['replyLimitPerMember'] = bodyString(body, 'replyLimitPerMember');
        next['replyLimitPerChat'] = bodyString(body, 'replyLimitPerChat');
      } else if (section === 'nicknames') {
        next['nicknames'] = {
          enabled: 'enabled' in body,
          words: bodyString(body, 'words'),
          spamLimit: bodyString(body, 'spamLimit'),
        };
      } else if (section.startsWith('persona:')) {
        const lang = section.slice('persona:'.length);
        const persona = (next['persona'] ?? {}) as Record<string, Record<string, string>>;
        const strings: Record<string, string> = {};
        for (const key of PERSONA_KEYS) strings[key] = bodyString(body, key);
        persona[lang] = strings;
        next['persona'] = persona;
      } else if (section.startsWith('retorts:')) {
        const lang = section.slice('retorts:'.length);
        const retorts = (next['retorts'] ?? {}) as Record<string, unknown>;
        retorts[lang] = bodyString(body, 'retorts');
        next['retorts'] = retorts;
      } else if (section === 'reset') {
        await interaction.save(DEFAULT_INTERACTION, actor);
        return reply.redirect('/interaction?saved=1');
      } else {
        return reply.redirect(`/interaction?error=${encodeURIComponent('Unknown section.')}`);
      }

      await interaction.save(next, actor);
      return reply.redirect('/interaction?saved=1');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save these settings.';
      return reply.redirect(`/interaction?error=${encodeURIComponent(message)}`);
    }
  });
}

/** Re-exported so the shipped language list stays a single source of truth. */
export { SHIPPED_LANGS };
