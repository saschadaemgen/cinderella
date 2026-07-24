/**
 * CCB-S3-021 — no em-dash, en-dash, or horizontal bar in member-facing text.
 *
 * The operator's standing rule: those three characters (— – ―) must never appear
 * in anything a member can read, in any language. This harness fails if one does,
 * in the same spirit as the doubled-delimiter guard from CCB-S3-003 — without an
 * enforced check the fault returns the moment someone writes new copy.
 *
 * It guards on three fronts:
 *   1. LOCALE FILES — every value is member-facing, so the raw JSON is scanned.
 *   2. RUNTIME OUTPUT — the composed member-facing strings (persona, retorts, the
 *      help reply and its topics, the welcome message) are built and checked. This
 *      is the definitive check: it sees exactly what a member would.
 *   3. SOURCE BACKSTOP — the copy-bearing modules and the WHOLE plugins tree are
 *      scanned with comments stripped, so a new plugin's strings are caught
 *      automatically rather than being remembered. After stripping comments, any of
 *      these characters can only be inside a string literal (no identifier or
 *      operator uses them), so a bare character scan is enough.
 *
 *   npx tsx scripts/verify-no-dashes.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_INTERACTION } from '../src/interaction/settings.js';
import { buildHelpReply, buildHelpTopic } from '../src/interaction/help.js';
import { WELCOME_MESSAGE } from '../src/consent/commands.js';
import type { Intent } from '../src/interaction/intent.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Em-dash (U+2014), en-dash (U+2013), horizontal bar (U+2015). */
const FORBIDDEN = /[—–―]/;
const NAMES: Record<string, string> = {
  '—': 'em-dash',
  '–': 'en-dash',
  '―': 'horizontal-bar',
};

let failures = 0;
let scanned = 0;

function report(where: string, text: string): void {
  const idx = text.search(FORBIDDEN);
  if (idx < 0) return;
  failures++;
  const ch = text[idx] ?? '';
  const around = text.slice(Math.max(0, idx - 28), idx + 28).replace(/\s+/g, ' ');
  console.log(`  [FAIL] ${where}: ${NAMES[ch] ?? 'forbidden'} in "…${around}…"`);
}

function check(where: string, text: string): void {
  scanned++;
  report(where, text);
}

/* ── 1. Locale files ─────────────────────────────────────────────────────── */
const localesDir = join(ROOT, 'locales');
for (const f of readdirSync(localesDir).filter((n) => n.endsWith('.json'))) {
  check(`locales/${f}`, readFileSync(join(localesDir, f), 'utf8'));
}

/* ── 2. Runtime member-facing strings ────────────────────────────────────── */
for (const [lang, p] of Object.entries(DEFAULT_INTERACTION.persona)) {
  for (const [key, val] of Object.entries(p)) check(`persona.${lang}.${key}`, String(val));
}
for (const [lang, list] of Object.entries(DEFAULT_INTERACTION.retorts)) {
  list.forEach((r, i) => check(`retorts.${lang}[${i}]`, r));
}
const ALL_INTENTS: Intent[] = ['PUBLISH', 'UNPUBLISH', 'STATUS', 'SEARCH', 'PRICE', 'HELP', 'UNDO'];
for (const lang of ['en', 'de'] as const) {
  // template '' renders the shipped default (CCB-S3-021 §3), so the rendered help,
  // its consent block and its command list are all scanned for stray dashes.
  check(`help.${lang}`, buildHelpReply({ template: '', intents: ALL_INTENTS, wake: 'Cinderella', lang, links: ['https://x/a', 'https://x/b'] }));
  check(`helpTopic.consent.${lang}`, buildHelpTopic('consent', 'Cinderella', lang));
  check(`helpTopic.prices.${lang}`, buildHelpTopic('prices', 'Cinderella', lang));
}
check('WELCOME_MESSAGE', WELCOME_MESSAGE);

/* ── 3. Source backstop (comments stripped) ──────────────────────────────── */
function stripComments(src: string): string {
  // Block comments (covers JSDoc, where most legitimate em-dashes live).
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Line comments — cut at the first `//` NOT preceded by ':' (so `https://` in a
  // string survives). Any dash after such a `//` would be in a comment, out of scope.
  s = s
    .split('\n')
    .map((line) => {
      const m = /(^|[^:])\/\//.exec(line);
      return m ? line.slice(0, m.index + m[1].length) : line;
    })
    .join('\n');
  return s;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
}

const backstopFiles = [
  join(ROOT, 'src/interaction/help.ts'),
  join(ROOT, 'src/interaction/settings.ts'),
  join(ROOT, 'src/consent/commands.ts'),
];
walk(join(ROOT, 'src/plugins'), backstopFiles);

for (const file of backstopFiles) {
  const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  check(`${rel} (string literal)`, stripComments(readFileSync(file, 'utf8')));
}

/* ── Result ──────────────────────────────────────────────────────────────── */
console.log(`\nScanned ${scanned} sources.`);
if (failures === 0) {
  console.log('ALL PASSED — no em-dash, en-dash or horizontal bar in member-facing text.');
} else {
  console.log(`${failures} FAILURE(S) — replace with a hyphen, a comma, or restructure.`);
  process.exit(1);
}
