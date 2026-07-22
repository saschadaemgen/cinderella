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
  ADDRESSING_MODES,
  DEFAULT_INTERACTION,
  REPLY_LANGUAGE_MODES,
  REPLY_MODES,
  PERSONA_KEYS,
  SHIPPED_LANGS,
  type InteractionSettings,
  type PersonaKey,
  type ReplyMode,
} from '../../interaction/settings.js';
import {
  CATEGORY_LABELS,
  REPLY_CATEGORIES,
  type ArchiveSettings,
} from '../../archive/settings.js';
import { NEAR_MISS_REASONS, recentNearMisses } from '../../interaction/near-misses.js';
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

function selectField(name: string, current: string, options: [string, string][]): SafeHtml {
  return html`<select name="${name}" class="${INPUT_CLS}">
    ${options.map(
      ([value, label]) =>
        html`<option value="${value}" ${value === current ? raw('selected') : ''}>
          ${label}
        </option>`,
    )}
  </select>`;
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

/**
 * Her own messages in the archive (CCB-S3-007).
 *
 * It lives on this page rather than getting its own, because it is inseparable
 * from the copy directly below it: the placeholder that replaces a name is one of
 * the persona strings, and an operator deciding whether her replies are public
 * wants to see what those replies actually say.
 */
function archiveCard(a: ArchiveSettings, csrf: string): SafeHtml {
  return card(
    'Her own messages in the archive',
    html`<form method="post" action="/interaction" class="flex flex-col gap-4">
      <input type="hidden" name="_csrf" value="${csrf}" />
      <input type="hidden" name="section" value="archive" />
      <p class="text-sm text-slate-600">
        Publication here is decided by these switches alone — she is not a member and has no
        consent record, and nothing on this page writes to one. Members' own messages are
        unaffected by everything below.
      </p>
      ${checkbox(
        'publishBotMessages',
        'Publish her replies on the public archive',
        a.publishBotMessages,
      )}
      <span class="text-xs text-slate-500">
        Turning this off removes her messages from the public stream immediately. Nothing is
        deleted — turning it back on restores them, because publication is worked out on every
        read rather than stored.
      </span>

      ${labelled(
        'When one of her replies names a member who has not opted in',
        selectField('mentionGuard', a.mentionGuard, [
          ['redact', 'Replace the name (keeps the sentence readable)'],
          ['withhold', 'Withhold the whole message'],
        ]),
        'Checked on every read, so a member who opts out later also disappears from replies of ' +
          'hers that were already public. Note that "replace the name" leaves the message in ' +
          'place, so a copy already fetched by a feed reader or a crawler keeps the old text; ' +
          '"withhold" takes the message out of the feed entirely.',
      )}
      <span class="text-xs text-slate-500">
        The stand-in text is the persona string
        <em>“Stands in for a member who has not opted in”</em>, further down this page.
      </span>

      ${checkbox(
        'stripMediaMetadata',
        'Strip metadata from published media',
        a.stripMediaMetadata,
      )}
      <span class="text-xs text-slate-500">
        Removes EXIF, IPTC and XMP from published images — GPS coordinates, camera make, model
        and serial number, capture time, and any owner or copyright name. Photographs from
        phones routinely carry the coordinates of where they were taken. The stored original is
        never modified; the public archive serves a stripped copy, and image orientation is
        applied to the pixels first so nothing appears rotated. Video and document formats have
        no stripper on this instance, and are listed as such rather than assumed clean.
      </span>

      <div class="flex flex-col gap-2">
        <span class="text-sm font-medium text-slate-700">Which of her replies are archived</span>
        ${REPLY_CATEGORIES.map(
          (c) => html`<div class="flex flex-col">
            ${checkbox(`cat:${c}`, CATEGORY_LABELS[c].label, a.categories[c])}
            <span class="ml-6 text-xs text-slate-500">${CATEGORY_LABELS[c].help}</span>
          </div>`,
        )}
        <span class="text-xs text-slate-500">
          A reply from a handler that declares no category at all is never published, so a new
          plugin cannot land in the archive unclassified.
        </span>
      </div>
      ${saveButton()}
    </form>`,
  );
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
  price: { label: 'Price answer', vars: '{amount} {base} {value} {quote}' },
  conversion: { label: 'Conversion answer', vars: '{amount} {base} {value} {quote}' },
  priceUnknownAsset: { label: 'Price — asset not in the registry', vars: '{symbol}' },
  priceAmbiguous: { label: 'Price — symbol is ambiguous', vars: '{symbol} {options}' },
  priceUnavailable: { label: 'Price — market data unreachable', vars: '' },
  priceThrottled: { label: 'Price — asked too often, try again shortly', vars: '' },
  redactedMember: {
    label: 'Stands in for a member who has not opted in',
    vars: 'Not a reply. When one of her published messages names a member who has not opted in, this replaces the name.',
  },
};

const REPLY_MODE_LABELS: Record<ReplyMode, string> = {
  plain: 'Plain — a normal group message (recommended)',
  mention: "Mention — a normal message, opened with the member's name",
  quote: "Quote — repeats the member's message above the answer",
};

const ADDRESSING_MODE_LABELS: Record<string, string> = {
  relaxed: 'Relaxed — a message starting with her name counts as an address',
  strict: 'Strict — a greeting must come first (Hey Cinderella ...)',
};

const REPLY_LANGUAGE_MODE_LABELS: Record<string, string> = {
  auto: 'Auto — answer in the language of the message',
  fixed: 'Fixed — always answer in the default language',
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

      const guards = card(
        'Addressing guards',
        html`<p class="mb-3 text-sm text-slate-500">
            Matching her name is not the same as being spoken to. These guards decide when she stays
            out of it. Each one can be switched off independently — turning them all off restores
            the behaviour that made her answer a forwarded announcement.
          </p>
          ${form(
            'addressing-guards',
            html`
              ${labelled(
                'Addressing mode',
                selectField(
                  'addressingMode',
                  s.addressing.mode,
                  ADDRESSING_MODES.map(
                    (m) => [m, ADDRESSING_MODE_LABELS[m] ?? m] as [string, string],
                  ),
                ),
                'Strict mode still allows direct replies to her, the follow-up window and slash commands.',
              )}
              ${checkbox('ignoreForwarded', 'Ignore forwarded messages', s.addressing.ignoreForwarded)}
              <p class="-mt-1 text-xs text-slate-500">
                A forwarded message is content someone is sharing, not someone talking to her.
                Switching this off lets a forwarded announcement that happens to begin with her name
                reach the resolver, which is how she came to answer one.
              </p>
              ${checkbox(
                'silenceOnUnknown',
                'Stay silent when she does not understand and the signal was weak',
                s.addressing.silenceOnUnknown,
              )}
              <p class="-mt-1 text-xs text-slate-500">
                The not-understood prompt is only sent when she is confident she was addressed.
                Switching this off makes her answer every unrecognised message that starts with her
                name.
              </p>
              ${checkbox(
                'strongSignalGreeting',
                'A greeting counts as a strong signal (Hey Cinderella ...)',
                s.addressing.strongSignalGreeting,
              )}
              ${checkbox(
                'strongSignalReply',
                'A direct reply to one of her messages counts as a strong signal',
                s.addressing.strongSignalReply,
              )}
              ${checkbox(
                'strongSignalWindow',
                'Being mid-conversation counts as a strong signal',
                s.addressing.strongSignalWindow,
              )}
              <p class="-mt-1 text-xs text-slate-500">
                With all three off nothing is ever a strong signal, and she will never send the
                not-understood prompt.
              </p>
              ${labelled(
                'Maximum instruction length (characters)',
                numberField('maxInstructionLength', s.addressing.maxInstructionLength, 20, 4000),
                'Longer than this and she only acts on a high-confidence intent. Commands are short; announcements are not.',
              )}
              ${labelled(
                'Confidence required above that length',
                numberField(
                  'lengthGuardConfidence',
                  s.addressing.lengthGuardConfidence,
                  0,
                  1,
                  '0.05',
                ),
                'Raise it to ignore more long text; lower it to let long messages act as instructions.',
              )}
              ${checkbox('logNearMisses', 'Record ignored messages below', s.addressing.logNearMisses)}
              <p class="-mt-1 text-xs text-slate-500">
                Kept in memory only, capped and truncated, and cleared on restart. Switching this
                off makes the guards invisible.
              </p>
              ${saveButton()}
            `,
          )}`,
      );

      const nearMisses = recentNearMisses(25);
      const nearMissCard = card(
        'Recently ignored (near misses)',
        nearMisses.length === 0
          ? html`<p class="text-sm text-slate-500">
              Nothing ignored since the last restart. Messages the guards catch appear here with the
              reason, so you can see what she is staying out of.
            </p>`
          : html`<div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead>
                  <tr
                    class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500"
                  >
                    <th class="py-2 pr-3">When</th>
                    <th class="py-2 pr-3">Who</th>
                    <th class="py-2 pr-3">Why ignored</th>
                    <th class="py-2 pr-3">Message</th>
                    <th class="py-2">Resolver</th>
                  </tr>
                </thead>
                <tbody>
                  ${nearMisses.map(
                    (n) =>
                      html`<tr class="border-b border-slate-100 align-top">
                        <td class="whitespace-nowrap py-2 pr-3 text-slate-500">
                          ${new Date(n.at).toISOString().replace('T', ' ').slice(0, 16)}
                        </td>
                        <td class="py-2 pr-3">${n.who}</td>
                        <td class="py-2 pr-3 text-slate-600">${NEAR_MISS_REASONS[n.reason]}</td>
                        <td class="py-2 pr-3 text-slate-500">${n.excerpt}</td>
                        <td class="whitespace-nowrap py-2 text-slate-500">
                          ${n.intent ? `${n.intent} ${(n.confidence ?? 0).toFixed(2)}` : '—'}
                        </td>
                      </tr>`,
                  )}
                </tbody>
              </table>
            </div>`,
      );

      const language = card(
        'Reply language',
        html`<p class="mb-3 text-sm text-slate-500">
            She answers in the language of the message she is answering. Only languages that have
            real persona copy here are offered, never a machine-translated website locale.
          </p>
          ${form(
            'language',
            html`
              ${labelled(
                'Reply language mode',
                selectField(
                  'replyLanguageMode',
                  s.replyLanguageMode,
                  REPLY_LANGUAGE_MODES.map(
                    (m) => [m, REPLY_LANGUAGE_MODE_LABELS[m] ?? m] as [string, string],
                  ),
                ),
                'Auto detects per message and falls back to the default when the text gives no clear signal.',
              )}
              ${checkbox(
                'rememberMemberLanguage',
                "Remember a member's language for the follow-up window",
                s.rememberMemberLanguage,
              )}
              <p class="-mt-1 text-xs text-slate-500">
                Keeps a short follow-up like "yes" in the language of the exchange it belongs to.
                The default reply language is set under Addressing above.
              </p>
              ${saveButton()}
            `,
          )}`,
      );

      const answering = card(
        'How she answers',
        html`<p class="mb-3 text-sm text-slate-500">
            She used to quote the message she was answering, which repeated the member's words above
            every reply and read as duplicated noise to everyone else in the group. She now sends
            plain messages. Confirmation prompts never quote, whatever this is set to.
          </p>
          ${form(
            'reply',
            html`
              ${labelled(
                'Reply mode',
                selectField(
                  'replyMode',
                  s.replyMode,
                  // Derived from REPLY_MODES so a mode can never be added to the
                  // model and silently go missing from the console.
                  REPLY_MODES.map((m) => [m, REPLY_MODE_LABELS[m]] as [string, string]),
                ),
                'Plain and Mention both keep the group readable. Quote is the old behaviour.',
              )}
              ${checkbox(
                'namePrefixEnabled',
                'Use the name prefix (Mention mode only)',
                s.namePrefix.enabled,
              )}
              ${Object.keys(s.namePrefix.templates)
                .sort()
                .map((lang) =>
                  labelled(
                    `Name prefix — ${langLabel(lang)}`,
                    textField(`prefix:${lang}`, s.namePrefix.templates[lang] as string),
                    "{name} is the member's display name. A single space is added after it automatically.",
                  ),
                )}
              ${saveButton()}
            `,
          )}`,
      );

      const herMessages = archiveCard(ctx.archive.get(), csrf);

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
            Restores every setting on this page — wake word, greetings, reply mode, name prefix,
            limits, persona strings and retorts — to the values Cinderella ships with. Consent data
            is untouched.
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
          ${addressing} ${guards} ${nearMissCard} ${language} ${answering} ${herMessages}
          ${safety} ${nicknames} ${personaCards} ${retortCards} ${reset}
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
      } else if (section === 'addressing-guards') {
        next['addressing'] = {
          mode: bodyString(body, 'addressingMode'),
          ignoreForwarded: 'ignoreForwarded' in body,
          silenceOnUnknown: 'silenceOnUnknown' in body,
          strongSignalGreeting: 'strongSignalGreeting' in body,
          strongSignalReply: 'strongSignalReply' in body,
          strongSignalWindow: 'strongSignalWindow' in body,
          maxInstructionLength: bodyString(body, 'maxInstructionLength'),
          lengthGuardConfidence: bodyString(body, 'lengthGuardConfidence'),
          logNearMisses: 'logNearMisses' in body,
        };
      } else if (section === 'language') {
        next['replyLanguageMode'] = bodyString(body, 'replyLanguageMode');
        next['rememberMemberLanguage'] = 'rememberMemberLanguage' in body;
      } else if (section === 'reply') {
        next['replyMode'] = bodyString(body, 'replyMode');
        const templates: Record<string, string> = {};
        for (const key of Object.keys(body)) {
          if (key.startsWith('prefix:'))
            templates[key.slice('prefix:'.length)] = bodyString(body, key);
        }
        next['namePrefix'] = { enabled: 'namePrefixEnabled' in body, templates };
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
      } else if (section === 'archive') {
        // A different service and a different settings key, so this branch saves
        // and returns rather than falling through to the interaction save.
        const categories: Record<string, boolean> = {};
        for (const c of REPLY_CATEGORIES) categories[c] = `cat:${c}` in body;
        await ctx.archive.save(
          {
            publishBotMessages: 'publishBotMessages' in body,
            stripMediaMetadata: 'stripMediaMetadata' in body,
            mentionGuard: bodyString(body, 'mentionGuard'),
            categories,
          },
          actor,
        );
        return reply.redirect('/interaction?saved=1');
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
