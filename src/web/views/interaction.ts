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
  MEMBER_CATEGORIES,
  MEMBER_CATEGORY_LABELS,
  REPLY_CATEGORIES,
  type ArchiveSettings,
} from '../../archive/settings.js';
import { NEAR_MISS_REASONS, recentNearMisses } from '../../interaction/near-misses.js';
import { missingHelpPlaceholders } from '../../interaction/help.js';
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
        <span class="text-sm font-medium text-slate-700">
          Which member questions are archived
        </span>
        <span class="text-xs text-slate-500">
          A member's question is that member's message, so these publish on the ordinary consent
          rules unless switched off here. Note the opposite default from her replies below: her
          words need a reason to be public, an opted-in member's words need a reason not to be.
          An answer whose question is excluded is excluded with it, so the archive never shows
          her answering nobody.
        </span>
        ${MEMBER_CATEGORIES.map(
          (c) => html`<div class="flex flex-col">
            ${checkbox(`mcat:${c}`, MEMBER_CATEGORY_LABELS[c].label, a.memberCategories[c])}
            <span class="ml-6 text-xs text-slate-500">${MEMBER_CATEGORY_LABELS[c].help}</span>
          </div>`,
        )}
      </div>

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
  undoNotRevocation: {
    label: 'Undo — a revocation cannot be undone',
    vars: 'Shown when a member asks to undo taking their words back.',
  },
  cancelled: { label: 'Confirmation declined', vars: '' },
  help: {
    label: 'Help reply (template)',
    vars: '{wake} = her name; {commands} = the generated capability list (required); {consent} = the three publishing properties (required); {label} = what she is. Blank restores the default.',
  },
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

  /**
   * Interaction is split into sub-sections (CCB-S3-015 Stage 1). Each has its own
   * URL under /interaction/<slug>, its own submenu entry, and saves independently.
   * The page had grown into one long scroll with every briefing this season; the
   * split gives an operator a bookmarkable, linkable place for each concern.
   *
   * Every setting lands in exactly ONE section, and the round-trip is proven by
   * verify:admin-views — nothing was dropped in the move.
   */
  const SECTIONS: { slug: string; title: string; desc: string }[] = [
    { slug: 'addressing', title: 'Addressing', desc: 'How she is addressed: her name, greetings, and which channels reach her.' },
    { slug: 'guards', title: 'Guards', desc: 'When matching her name does NOT mean she was spoken to.' },
    { slug: 'followup', title: 'Follow-up', desc: 'The window after she replies, and what a short follow-up may carry.' },
    { slug: 'language', title: 'Language', desc: 'Which language she answers in.' },
    { slug: 'replies', title: 'Replies', desc: 'How her answers appear, and how often she may send them.' },
    { slug: 'nicknames', title: 'Nicknames', desc: 'The names she refuses to answer to, and her retorts.' },
    { slug: 'consent', title: 'Consent behaviour', desc: 'Confirmation words, undo window, and the consent handshake.' },
    { slug: 'voice', title: 'Voice', desc: 'Every persona string, per language, plus the help-footer links.' },
    { slug: 'archiving', title: 'Archiving', desc: 'Whether her own messages and members’ questions are published.' },
    { slug: 'diagnostics', title: 'Diagnostics', desc: 'The near-miss log, and the resolver currently in use.' },
  ];

  app.get<{ Params: { section?: string }; Querystring: { saved?: string; error?: string } }>(
    '/interaction/:section',
    async (req, reply) => {
      const slug = req.params.section ?? 'addressing';
      const meta = SECTIONS.find((x) => x.slug === slug);
      if (!meta) return reply.redirect('/interaction/addressing');

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

      const cardsFor: Record<string, () => SafeHtml> = {
        addressing: () =>
          card(
            'Addressing',
            html`<p class="mb-3 text-sm text-slate-500">
                She answers to her name, and only to her name. A message is addressed to her when it
                <strong>starts</strong> with the wake word (an optional greeting may come first), when
                it replies directly to one of her messages, or inside the follow-up window. Talking
                <em>about</em> her is never an address.
              </p>
              ${form(
                'addressing',
                html`
                  ${checkbox('naturalAddressing', 'Natural addressing (she responds to her name)', s.naturalAddressing)}
                  ${checkbox('slashCommands', 'Slash commands (/publish, /unpublish)', s.slashCommands)}
                  ${labelled('Wake word', textField('wakeWord', s.wakeWord), 'Her name. Rename her for your community — small typos in it are still understood.')}
                  ${labelled('Greeting prefixes', textField('greetings', s.greetings.join(', ')), 'Comma separated. Allowed in front of the wake word and stripped before the instruction.')}
                  ${saveButton()}
                `,
              )}`,
          ),
        guards: () =>
          card(
            'Guards',
            html`<p class="mb-3 text-sm text-slate-500">
                Matching her name is not the same as being spoken to. Each guard can be switched off
                independently — turning them all off restores the behaviour that made her answer a
                forwarded announcement.
              </p>
              ${form(
                'guards',
                html`
                  ${labelled('Addressing mode', selectField('addressingMode', s.addressing.mode, ADDRESSING_MODES.map((m) => [m, ADDRESSING_MODE_LABELS[m] ?? m] as [string, string])), 'Strict mode still allows direct replies, the follow-up window and slash commands.')}
                  ${checkbox('ignoreForwarded', 'Ignore forwarded messages', s.addressing.ignoreForwarded)}
                  ${checkbox('silenceOnUnknown', 'Stay silent on a weak, not-understood signal', s.addressing.silenceOnUnknown)}
                  ${checkbox('strongSignalGreeting', 'A greeting is a strong signal (Hey Cinderella ...)', s.addressing.strongSignalGreeting)}
                  ${checkbox('strongSignalReply', 'A direct reply is a strong signal', s.addressing.strongSignalReply)}
                  ${checkbox('strongSignalWindow', 'Being mid-conversation is a strong signal', s.addressing.strongSignalWindow)}
                  ${labelled('Confidence threshold', numberField('confidenceThreshold', s.confidenceThreshold, 0, 1, '0.05'), 'Below this she asks instead of acting. Higher is more cautious.')}
                  ${labelled('Maximum instruction length (characters)', numberField('maxInstructionLength', s.addressing.maxInstructionLength, 20, 4000), 'Longer than this and she only acts on a high-confidence intent.')}
                  ${labelled('Confidence required above that length', numberField('lengthGuardConfidence', s.addressing.lengthGuardConfidence, 0, 1, '0.05'), 'Raise it to ignore more long text.')}
                  ${labelled('Filler prefixes', textField('fillerPrefixes', s.fillerPrefixes.join(', ')), 'Short discourse words allowed before her name (so, hey, also). Comma separated.')}
                  ${labelled('Max filler words before the name', numberField('maxPrefixWords', s.maxPrefixWords, 0, 8))}
                  ${labelled('Max filler characters before the name', numberField('maxPrefixChars', s.maxPrefixChars, 0, 60))}
                  ${checkbox('logNearMisses', 'Record ignored messages (see Diagnostics)', s.addressing.logNearMisses)}
                  ${saveButton()}
                `,
              )}`,
          ),
        followup: () =>
          card(
            'Follow-up',
            html`<p class="mb-3 text-sm text-slate-500">
                After she replies, that member may keep talking for a short while without repeating
                her name. A brief elliptical follow-up can inherit the previous read-only intent —
                but only a known asset, never a fresh lookup, and never an interjection.
              </p>
              ${form(
                'followup',
                html`
                  ${labelled('Follow-up window (seconds)', numberField('followUpSeconds', s.followUpSeconds, 0, 3600), '0 disables it.')}
                  ${checkbox('intentCarryover', 'Let a short follow-up inherit the previous intent', s.intentCarryover)}
                  ${labelled('Interjection stop list', textField('carryOverStopWords', s.carryOverStopWords.join(', ')), 'Words that never carry an intent forward — nice, cool, thanks, danke … Comma separated.')}
                  ${saveButton()}
                `,
              )}`,
          ),
        language: () =>
          card(
            'Language',
            html`<p class="mb-3 text-sm text-slate-500">
                She answers in the language of the message she is answering. Only languages that have
                real persona copy are offered, never a machine-translated website locale.
              </p>
              ${form(
                'language',
                html`
                  ${labelled('Reply language mode', selectField('replyLanguageMode', s.replyLanguageMode, REPLY_LANGUAGE_MODES.map((m) => [m, REPLY_LANGUAGE_MODE_LABELS[m] ?? m] as [string, string])), 'Auto detects per message; falls back to the default when the text gives no clear signal.')}
                  ${labelled('Default language', textField('defaultLanguage', s.defaultLanguage), `Used when the instruction gives no clue. Available: ${Object.keys(s.persona).join(', ')}.`)}
                  ${checkbox('rememberMemberLanguage', "Remember a member's language for the follow-up window", s.rememberMemberLanguage)}
                  ${saveButton()}
                `,
              )}`,
          ),
        replies: () =>
          card(
            'Replies',
            html`<p class="mb-3 text-sm text-slate-500">
                She sends plain messages rather than quoting the member she answers. Confirmation
                prompts never quote, whatever this is set to.
              </p>
              ${form(
                'replies',
                html`
                  ${labelled('Reply mode', selectField('replyMode', s.replyMode, REPLY_MODES.map((m) => [m, REPLY_MODE_LABELS[m]] as [string, string])), 'Plain and Mention keep the group readable. Quote is the old behaviour.')}
                  ${checkbox('namePrefixEnabled', 'Use the name prefix (Mention mode only)', s.namePrefix.enabled)}
                  ${Object.keys(s.namePrefix.templates).sort().map((lang) => labelled(`Name prefix — ${langLabel(lang)}`, textField(`prefix:${lang}`, s.namePrefix.templates[lang] as string), "{name} is the member's display name. A single space is added after it."))}
                  ${labelled('Replies per member, per minute', numberField('replyLimitPerMember', s.replyLimitPerMember, 1, 120))}
                  ${labelled('Replies per chat, per minute', numberField('replyLimitPerChat', s.replyLimitPerChat, 1, 600))}
                  ${saveButton()}
                `,
              )}`,
          ),
        nicknames: () =>
          html`${card(
            'Nicknames',
            html`<p class="mb-3 text-sm text-slate-500">
                She does not answer to "Cindy". A nickname in the wake-word position earns a retort and
                <strong>nothing else</strong>. Retorts rotate without repeating the previous one.
              </p>
              ${form(
                'nicknames',
                html`
                  ${checkbox('enabled', 'Nickname retorts enabled', s.nicknames.enabled)}
                  ${labelled('Nicknames', textField('words', s.nicknames.words.join(', ')), 'Comma separated. Matched exactly, so short names never fire on ordinary words.')}
                  ${labelled('Anti-spam limit', numberField('spamLimit', s.nicknames.spamLimit, 1, 20), 'Consecutive nicknames from one member before she stops answering.')}
                  ${saveButton()}
                `,
              )}`,
          )}
          ${Object.keys(s.retorts)
            .sort()
            .map((lang) =>
              card(
                `Retorts — ${langLabel(lang)}`,
                form(`retorts:${lang}`, html`<p class="text-sm text-slate-500">One retort per line. Emptying the list restores the shipped twelve.</p>${textArea('retorts', (s.retorts[lang] as string[]).join('\n'), 12)} ${saveButton()}`),
              ),
            )}`,
        consent: () =>
          card(
            'Consent behaviour',
            html`<p class="mb-3 text-sm text-slate-500">
                Publishing and unpublishing by natural language always take two messages: she asks,
                the member agrees. Slash commands stay immediate.
              </p>
              ${form(
                'consent',
                html`
                  ${labelled('Affirmation words', textField('affirmations', s.affirmations.join(', ')), 'Comma separated. Fuzzy matched, so "jup" and "yeah" work without listing every spelling.')}
                  ${labelled('Decline words', textField('declines', s.declines.join(', ')), 'Comma separated. Cancels a pending confirmation.')}
                  ${labelled('Undo window (seconds)', numberField('undoWindowSeconds', s.undoWindowSeconds, 0, 86400), 'How long a member may undo their own last consent decision. 0 means no time limit.')}
                  ${saveButton()}
                `,
              )}`,
          ),
        voice: () =>
          html`${Object.keys(s.persona)
            .sort()
            .map((lang) =>
              card(
                `Her voice — ${langLabel(lang)}`,
                form(`persona:${lang}`, html`<p class="text-sm text-slate-500">Chat only. Leave a field empty to restore its shipped default.</p>${PERSONA_KEYS.map((key) => labelled(PERSONA_META[key].label, textArea(key, (s.persona[lang] as Record<PersonaKey, string>)[key], 2), PERSONA_META[key].vars ? `Placeholders: ${PERSONA_META[key].vars}` : undefined))} ${saveButton()}`),
              ),
            )}
          ${card(
            'Help footer and attribution',
            form('links', html`${labelled('Archive link', textField('archiveUrl', s.archiveUrl, 'https://…'), 'Shown at the foot of the help reply. https only; blank hides it.')}${labelled('Project link', textField('projectUrl', s.projectUrl, 'https://…'), 'Shown at the foot of the help reply, and the link her attribution points at. https only; blank hides it.')}${labelled('Attribution label', textField('botLabel', s.botLabel, '(SimpleX AI Bot)'), 'Shown after her name in the help reply, e.g. what she is. Blank hides it.')} ${saveButton()}`),
          )}`,
        archiving: () => archiveCard(ctx.archive.get(), csrf),
        diagnostics: () => {
          const nearMisses = recentNearMisses(25);
          return html`${card(
            'Resolver',
            html`<p class="text-sm text-slate-600">
              Intent resolver in use:
              <code class="rounded bg-slate-100 px-1">${activeResolverName()}</code>. The seam lets a
              smarter resolver replace the rules without touching the rest of the layer.
            </p>`,
          )}
          ${card(
            'Recently ignored (near misses)',
            nearMisses.length === 0
              ? html`<p class="text-sm text-slate-500">Nothing ignored since the last restart. Messages the guards catch appear here with the reason.</p>`
              : html`<div class="overflow-x-auto">
                  <table class="w-full text-left text-sm">
                    <thead>
                      <tr class="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                        <th class="py-2 pr-3">When</th><th class="py-2 pr-3">Who</th><th class="py-2 pr-3">Why</th><th class="py-2 pr-3">Message</th><th class="py-2">Resolver</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${nearMisses.map((n) => html`<tr class="border-b border-slate-100 align-top">
                        <td class="whitespace-nowrap py-2 pr-3 text-slate-500">${new Date(n.at).toISOString().replace('T', ' ').slice(0, 16)}</td>
                        <td class="py-2 pr-3">${n.who}</td>
                        <td class="py-2 pr-3 text-slate-600">${NEAR_MISS_REASONS[n.reason]}</td>
                        <td class="py-2 pr-3 text-slate-500">${n.excerpt}</td>
                        <td class="whitespace-nowrap py-2 text-slate-500">${n.intent ? `${n.intent} ${(n.confidence ?? 0).toFixed(2)}` : '—'}</td>
                      </tr>`)}
                    </tbody>
                  </table>
                </div>`,
          )}
          ${card(
            'Reset',
            html`<p class="mb-3 text-sm text-slate-500">Restores every interaction setting to the values Cinderella ships with. Consent data is untouched.</p>
              ${form('reset', html`<button type="submit" class="self-start rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100">Restore defaults</button>`)}`,
          )}`;
        },
      };

      const submenu = html`<nav class="mb-6 flex flex-wrap gap-1 border-b border-slate-200 pb-2">
        ${SECTIONS.map(
          (x) =>
            html`<a
              href="/interaction/${x.slug}"
              class="rounded-lg px-3 py-1.5 text-sm ${x.slug === slug ? 'bg-slate-900 font-medium text-white' : 'text-slate-600 hover:bg-slate-100'}"
              >${x.title}</a
            >`,
        )}
      </nav>`;

      const body = html`
        ${pageHeader(`Interaction — ${meta.title}`, meta.desc)} ${submenu} ${notice}
        <div class="flex flex-col gap-6">${cardsFor[slug]?.()}</div>
      `;

      reply.type('text/html');
      return page({ title: `Interaction — ${meta.title}`, active: `interaction:${slug}`, csrfToken: csrf, body });
    },
  );

  // Old bookmarks and any link to the un-suffixed page land on the first section.
  app.get('/interaction', async (_req, reply) => reply.redirect('/interaction/addressing'));

  app.post('/interaction', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const section = bodyString(body, 'section');
    const actor = req.session?.username ?? 'unknown';
    const next = cloneSettings(interaction.get());

    // Which section PAGE a save should return to (CCB-S3-015 Stage 1).
    const pageFor = (sec: string): string => {
      if (sec.startsWith('persona:') || sec === 'links') return 'voice';
      if (sec.startsWith('retorts:')) return 'nicknames';
      if (sec === 'archive') return 'archiving';
      if (sec === 'reset') return 'diagnostics';
      return sec;
    };
    const back = (extra: string): string => `/interaction/${pageFor(section)}${extra}`;

    try {
      if (section === 'addressing') {
        next['naturalAddressing'] = 'naturalAddressing' in body;
        next['slashCommands'] = 'slashCommands' in body;
        next['wakeWord'] = bodyString(body, 'wakeWord');
        next['greetings'] = bodyString(body, 'greetings');
      } else if (section === 'guards') {
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
        next['confidenceThreshold'] = bodyString(body, 'confidenceThreshold');
        next['fillerPrefixes'] = bodyString(body, 'fillerPrefixes');
        next['maxPrefixWords'] = bodyString(body, 'maxPrefixWords');
        next['maxPrefixChars'] = bodyString(body, 'maxPrefixChars');
      } else if (section === 'followup') {
        next['followUpSeconds'] = bodyString(body, 'followUpSeconds');
        next['intentCarryover'] = 'intentCarryover' in body;
        next['carryOverStopWords'] = bodyString(body, 'carryOverStopWords');
      } else if (section === 'language') {
        next['replyLanguageMode'] = bodyString(body, 'replyLanguageMode');
        next['defaultLanguage'] = bodyString(body, 'defaultLanguage');
        next['rememberMemberLanguage'] = 'rememberMemberLanguage' in body;
      } else if (section === 'replies') {
        next['replyMode'] = bodyString(body, 'replyMode');
        const templates: Record<string, string> = {};
        for (const key of Object.keys(body)) {
          if (key.startsWith('prefix:')) templates[key.slice('prefix:'.length)] = bodyString(body, key);
        }
        next['namePrefix'] = { enabled: 'namePrefixEnabled' in body, templates };
        next['replyLimitPerMember'] = bodyString(body, 'replyLimitPerMember');
        next['replyLimitPerChat'] = bodyString(body, 'replyLimitPerChat');
      } else if (section === 'nicknames') {
        next['nicknames'] = {
          enabled: 'enabled' in body,
          words: bodyString(body, 'words'),
          spamLimit: bodyString(body, 'spamLimit'),
        };
      } else if (section === 'consent') {
        next['affirmations'] = bodyString(body, 'affirmations');
        next['declines'] = bodyString(body, 'declines');
        next['undoWindowSeconds'] = bodyString(body, 'undoWindowSeconds');
      } else if (section === 'links') {
        next['archiveUrl'] = bodyString(body, 'archiveUrl');
        next['projectUrl'] = bodyString(body, 'projectUrl');
        next['botLabel'] = bodyString(body, 'botLabel');
      } else if (section.startsWith('persona:')) {
        const lang = section.slice('persona:'.length);
        const persona = (next['persona'] ?? {}) as Record<string, Record<string, string>>;
        const strings: Record<string, string> = {};
        for (const key of PERSONA_KEYS) strings[key] = bodyString(body, key);
        // The help field is a TEMPLATE the machine fills (CCB-S3-021 §3). A non-blank
        // help must keep {commands} and {consent}, or the reply would ship with no
        // command list or no publishing properties. Reject and name what is missing,
        // rather than silently saving a broken help. Blank is fine (restores default).
        const missing = missingHelpPlaceholders(strings['help'] ?? '');
        if (missing.length > 0) {
          throw new Error(
            `The Help reply is missing a required placeholder: ${missing.join(', ')}. ` +
              `Add it back, or clear the field to restore the default.`,
          );
        }
        persona[lang] = strings;
        next['persona'] = persona;
      } else if (section.startsWith('retorts:')) {
        const lang = section.slice('retorts:'.length);
        const retorts = (next['retorts'] ?? {}) as Record<string, unknown>;
        retorts[lang] = bodyString(body, 'retorts');
        next['retorts'] = retorts;
      } else if (section === 'archive') {
        const categories: Record<string, boolean> = {};
        for (const c of REPLY_CATEGORIES) categories[c] = `cat:${c}` in body;
        const memberCategories: Record<string, boolean> = {};
        for (const c of MEMBER_CATEGORIES) memberCategories[c] = `mcat:${c}` in body;
        await ctx.archive.save(
          {
            publishBotMessages: 'publishBotMessages' in body,
            stripMediaMetadata: 'stripMediaMetadata' in body,
            mentionGuard: bodyString(body, 'mentionGuard'),
            categories,
            memberCategories,
          },
          actor,
        );
        return reply.redirect(back('?saved=1'));
      } else if (section === 'reset') {
        await interaction.save(DEFAULT_INTERACTION, actor);
        return reply.redirect(back('?saved=1'));
      } else {
        return reply.redirect(`/interaction/addressing?error=${encodeURIComponent('Unknown section.')}`);
      }

      await interaction.save(next, actor);
      return reply.redirect(back('?saved=1'));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save these settings.';
      return reply.redirect(back(`?error=${encodeURIComponent(message)}`));
    }
  });
}

/** Re-exported so the shipped language list stays a single source of truth. */
export { SHIPPED_LANGS };
