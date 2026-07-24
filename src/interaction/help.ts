/**
 * The help reply, generated from the ACTIVE intent catalog (CCB-S3-010 Part 2).
 *
 * Help is the first thing anyone tries, and it is the one message that has to be
 * true about what she can actually do right now. So the capability list is not a
 * fixed string — it is built from the live catalog (`activeIntentList()`), which
 * means a disabled plugin stops advertising itself and a new plugin appears
 * without a copy change. A static list would drift the moment anything was
 * toggled, and drift in the help text is drift in the one explanation a member
 * relies on.
 *
 * The prose around the list — what she is, how to talk to her, the three consent
 * properties — is copy, kept here rather than in the persona map because it is
 * long, structured, and bilingual as a block. It uses only the single-delimiter
 * markup SimpleX actually renders (`*bold*`, `_italic_`), verified in CCB-S3-003.
 *
 * TODAY'S TRUTH on revocation (CCB-S3-010 Addendum A): it is final. There is no
 * hide, and undoing a revocation is refused. A later briefing introduces
 * hide/delete and will revise the consent block; until then this says what is
 * true, not what is planned.
 */

import type { Intent } from './intent.js';

export type HelpLang = 'en' | 'de';
export type HelpTopic = 'consent' | 'prices';

/** One capability line: the command keyword, and a one-line description per language. */
interface Capability {
  /** The keyword a native command menu would use (CCB-S3-010 §2c). */
  keyword: string;
  en: string;
  de: string;
}

/**
 * What each intent means to a member, in one line. Keyed by intent, so the help
 * list is assembled by walking the ACTIVE catalog: an intent that is not active
 * simply contributes nothing. UNKNOWN is not a capability and has no entry.
 *
 * No per-line icon (CCB-S3-021): the command in *bold* is enough, and one icon per
 * section heading reads far cleaner than one per line. The separator is a plain
 * hyphen, never an em-dash.
 */
const CAPABILITIES: Partial<Record<Intent, Capability>> = {
  PUBLISH: {
    keyword: 'publish',
    en: '*publish* - let your words from now on join the public archive',
    de: '*publish* - deine Worte ab jetzt ins öffentliche Archiv aufnehmen',
  },
  UNPUBLISH: {
    keyword: 'unpublish',
    en: '*unpublish* - take everything you have published back out, for good',
    de: '*unpublish* - alles Veröffentlichte endgültig zurücknehmen',
  },
  STATUS: {
    keyword: 'status',
    en: '*status* - how much of yours I keep, and how much is public',
    de: '*status* - wie viel ich von dir bewahre, und wie viel öffentlich ist',
  },
  SEARCH: {
    keyword: 'search',
    en: '*search ...* - look through what the group has made public',
    de: '*suche ...* - durchsuchen, was die Gruppe öffentlich gemacht hat',
  },
  PRICE: {
    keyword: 'price',
    en: '*price of ...* - what a coin is worth right now',
    de: '*preis von ...* - was eine Münze gerade wert ist',
  },
  HELP: {
    keyword: 'help',
    en: '*help* - this message; *help consent* or *help prices* for more',
    de: '*hilfe* - diese Nachricht; *hilfe consent* oder *hilfe prices* für mehr',
  },
  UNDO: {
    keyword: 'undo',
    en: '*undo* - take back your last request, if it was only a moment ago',
    de: '*undo* - deine letzte Bitte zurücknehmen, wenn sie eben erst war',
  },
};

/**
 * Fixed prose, per language. Blocks are joined with a BLANK LINE so the reply
 * reads as grouped sections, not a dense list (CCB-S3-021): who she is, how to
 * talk to her, what publishing means, what you can ask. One icon per heading, none
 * per command line. Every fact from the old dense version is kept, only regrouped;
 * the fuller consent/prices detail lives in the `help consent` / `help prices`
 * topics. No em-dashes anywhere.
 */
const COPY: Record<
  HelpLang,
  {
    intro: string;
    talk: string;
    consent: string;
    capsHeading: string;
    learnMore: (links: string[]) => string;
    consentTopic: string;
    pricesTopic: string;
  }
> = {
  en: {
    intro:
      '🕯️ I am *Cinderella*{label}. This is a public group, and I keep a public web archive of what ' +
      'its members choose to publish.',
    talk:
      '💬 *Talking to me*\n' +
      'Say my name: "*{wake}*, ...". A greeting is optional, and once we are talking you can ' +
      'follow up for a moment without repeating my name. Slash commands like */publish* work as ' +
      'shorthand.',
    consent:
      '🔑 *Publishing, so there are no surprises*\n' +
      '*Forward only.* Only what you say after you opt in is ever published, nothing from before.\n' +
      '*Public until you take it back.* Published words stay on the web, searchable, for as long ' +
      'as you leave them there.\n' +
      '*Taking them back is final.* _unpublish_ removes everything at once, and opting in again ' +
      'starts fresh; it does not bring the old words back.',
    capsHeading: '✨ *What you can ask me*',
    learnMore: (links) => `🔗 More: ${links.join(' · ')}`,
    consentTopic:
      '🔑 *Publishing, in full*\n' +
      '*Forward only.* Only messages you send after you opt in are published; nothing from ' +
      'before is touched.\n' +
      '*Public until you take it back.* While you are opted in, your words are on the public ' +
      'archive, searchable, with your name.\n' +
      '*Final.* _unpublish_ takes back everything at once. Opting in again publishes only what ' +
      'you say from then on; it does not restore the old words. This is the one thing I cannot ' +
      'undo, so I will always ask before it happens.\n\n' +
      'Say *{wake}, publish me* to begin, or *{wake}, unpublish me* to stop.',
    pricesTopic:
      '💱 *Prices*\n' +
      'Ask me what a coin is worth: "*{wake}*, price of 1 monero" or "0.5 eth in usd". I answer ' +
      'from live market data and tell you where the figure came from. It is a lookup only; ' +
      'nothing about it is published or kept.',
  },
  de: {
    intro:
      '🕯️ Ich bin *Cinderella*{label}. Dies ist eine öffentliche Gruppe, und ich führe ein ' +
      'öffentliches Web-Archiv dessen, was ihre Mitglieder veröffentlichen möchten.',
    talk:
      '💬 *So sprichst du mit mir*\n' +
      'Sprich mich beim Namen an: "*{wake}*, ...". Eine Begrüßung ist freiwillig, und wenn wir ' +
      'einmal im Gespräch sind, kannst du kurz nachfassen, ohne meinen Namen zu wiederholen. ' +
      'Slash-Befehle wie */publish* gehen als Kurzform.',
    consent:
      '🔑 *Zum Veröffentlichen, damit es keine Überraschungen gibt*\n' +
      '*Nur vorwärts.* Veröffentlicht wird nur, was du nach dem Opt-in sagst, nichts von vorher.\n' +
      '*Öffentlich, bis du es zurücknimmst.* Veröffentlichte Worte bleiben im Netz, durchsuchbar, ' +
      'solange du sie dort lässt.\n' +
      '*Das Zurücknehmen ist endgültig.* _unpublish_ entfernt alles auf einmal, und ein erneutes ' +
      'Opt-in beginnt von diesem Moment an neu; es holt die alten Worte nicht zurück.',
    capsHeading: '✨ *Worum du mich bitten kannst*',
    learnMore: (links) => `🔗 Mehr: ${links.join(' · ')}`,
    consentTopic:
      '🔑 *Veröffentlichen, ausführlich*\n' +
      '*Nur vorwärts.* Veröffentlicht werden nur Nachrichten nach deinem Opt-in; nichts von ' +
      'vorher wird angetastet.\n' +
      '*Öffentlich, bis du es zurücknimmst.* Solange du eingewilligt hast, stehen deine Worte ' +
      'im öffentlichen Archiv, durchsuchbar, mit deinem Namen.\n' +
      '*Endgültig.* _unpublish_ nimmt alles auf einmal zurück. Ein erneutes Opt-in ' +
      'veröffentlicht nur, was du ab dann sagst; es stellt die alten Worte nicht wieder her. Das ' +
      'ist das Einzige, was ich nicht rückgängig machen kann, also frage ich immer vorher.\n\n' +
      'Sag *{wake}, veröffentliche mich* zum Beginnen, oder *{wake}, widerrufe das* zum Aufhören.',
    pricesTopic:
      '💱 *Preise*\n' +
      'Frag mich, was eine Münze wert ist: "*{wake}*, Preis von 1 Monero" oder "0,5 eth in usd". ' +
      'Ich antworte aus aktuellen Marktdaten und sage dir, woher die Zahl stammt. Es ist nur eine ' +
      'Abfrage; nichts daran wird veröffentlicht oder gespeichert.',
  },
};

/** The order capabilities are listed in, so the reply reads sensibly. */
const ORDER: Intent[] = ['PUBLISH', 'UNPUBLISH', 'STATUS', 'SEARCH', 'PRICE', 'HELP', 'UNDO'];

function fillWake(text: string, wake: string): string {
  // Function replacer: the operator-set wake word is inserted LITERALLY, never
  // interpreted as a `$&`/`$'`-style replacement pattern (CCB-S3-025 review).
  return text.replace(/\{wake\}/g, () => wake);
}

export interface HelpContext {
  intents: readonly Intent[];
  wake: string;
  lang: HelpLang;
  /** "Learn more" links, already validated; the line is omitted when empty. */
  links: readonly string[];
  /** Attribution label after her name (CCB-S3-025), e.g. "(SimpleX AI Bot)"; '' → omitted. */
  label?: string;
}

/**
 * Builds the full help reply from the active catalog.
 *
 * The capability list walks {@link ORDER} filtered to what is ACTIVE, so PRICE
 * vanishes when the plugin is off and any future intent with a CAPABILITIES entry
 * appears the moment it is active.
 */
export function buildHelpReply(ctx: HelpContext): string {
  const c = COPY[ctx.lang];
  const active = new Set(ctx.intents);
  const caps = ORDER.filter((i) => active.has(i) && CAPABILITIES[i]).map((i) => {
    const cap = CAPABILITIES[i] as Capability;
    return ctx.lang === 'en' ? cap.en : cap.de;
  });

  // Blocks are separated by a BLANK LINE (`\n\n`); the command list is its heading
  // plus one undecorated line per command. Vertical space is what makes this
  // scannable in a chat bubble (CCB-S3-021).
  const label = ctx.label?.trim() ? ` ${ctx.label.trim()}` : '';
  const blocks: string[] = [
    // Function replacer so an operator label containing `$&`/`$'` is inserted
    // literally, not interpreted as a replacement pattern (CCB-S3-025 review).
    fillWake(c.intro.replace(/\{label\}/g, () => label), ctx.wake),
    fillWake(c.talk, ctx.wake),
    fillWake(c.consent, ctx.wake),
    [c.capsHeading, ...caps].join('\n'),
  ];
  if (ctx.links.length > 0) blocks.push(c.learnMore([...ctx.links]));
  return blocks.join('\n\n');
}

/** Detail for `help <topic>`. Null when the topic is not one she has detail for. */
export function buildHelpTopic(topic: HelpTopic, wake: string, lang: HelpLang): string {
  const c = COPY[lang];
  return fillWake(topic === 'consent' ? c.consentTopic : c.pricesTopic, wake);
}

/**
 * Recognises an optional topic after "help", in either language. Returns null
 * when the trailing word is not a topic she has detail for — the caller then
 * sends the full help rather than guessing.
 */
export function parseHelpTopic(instruction: string): HelpTopic | null {
  const m = /\bhelp\b\s+(\w+)|\bhilfe\b\s+(\w+)/i.exec(instruction);
  const word = (m?.[1] ?? m?.[2] ?? '').toLowerCase();
  if (word === 'consent' || word === 'einwilligung' || word === 'publish' || word === 'publishing') {
    return 'consent';
  }
  if (word === 'prices' || word === 'price' || word === 'preise' || word === 'preis') {
    return 'prices';
  }
  return null;
}

/* ── Native command menu (CCB-S3-010 §2c) ────────────────────────────────── */

/**
 * The active catalog as `ChatBotCommand[]`, the shape SimpleX's own bot-command
 * menu uses (`{type:'command', keyword, label}` and `{type:'menu', ...}`).
 *
 * INVESTIGATION RESULT, verified against the SDK, not assumed: the capability
 * EXISTS in `simplex-chat` 6.5.4 — `ChatBotCommand`, with `command` and `menu`
 * (submenu) variants, set through `bot.run({options:{commands}})`, which writes
 * `profile.preferences.commands` and marks the profile `peerType: bot`. But it
 * is a DIRECT-CONVERSATION affordance: the menu renders in a client's compose
 * bar for a 1:1 chat with the bot. Cinderella runs `createAddress: false` and
 * has no contact address — members only ever talk to her IN THE GROUP, where
 * there is no per-bot compose menu. Registering these on her profile would set a
 * menu no member can reach.
 *
 * So the menu is NOT wired to a live surface. This producer exists because the
 * briefing asked for the catalog to drive it: it is generated from the SAME
 * active list as the text help, so if she is ever given a direct-chat surface,
 * enabling the menu is one line — `options.commands: buildCommandMenu(...)` — and
 * it will already reflect exactly what is enabled.
 */
export function buildCommandMenu(intents: readonly Intent[], lang: HelpLang = 'en'): unknown[] {
  const active = new Set(intents);
  return ORDER.filter((i) => active.has(i) && CAPABILITIES[i]).map((i) => {
    const cap = CAPABILITIES[i] as Capability;
    // Strip the markup for a menu label — the menu is not a chat message.
    const label = (lang === 'en' ? cap.en : cap.de).replace(/[*_]/g, '');
    return { type: 'command', keyword: cap.keyword, label };
  });
}
