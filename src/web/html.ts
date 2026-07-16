/**
 * Server-rendered HTML: a tagged-template helper with automatic escaping, plus
 * the responsive layout shell (Tailwind + htmx; no SPA pipeline — A3/A5).
 *
 * Escaping contract: `html` escapes every interpolated value EXCEPT values that
 * are themselves the result of an `html` call (or wrapped with `raw`). Never
 * pass user-controlled strings through `raw`.
 */

const ESCAPE_RE = /[&<>"']/g;
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_RE, (c) => ESCAPES[c] ?? c);
}

/** A string that is already-safe HTML. Only `html`/`raw` produce it. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Marks a string as already-safe HTML. Do NOT use on user-controlled input. */
export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

type Interpolatable = string | number | boolean | SafeHtml | null | undefined | Interpolatable[];

function render(value: Interpolatable): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return escapeHtml(value);
}

/** Tagged template producing SafeHtml with all interpolations escaped. */
export function html(strings: TemplateStringsArray, ...values: Interpolatable[]): SafeHtml {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += render(values[i]);
  }
  return new SafeHtml(out);
}

export interface PageOptions {
  title: string;
  /** Active nav item key (for highlighting). */
  active?: string;
  /** Rendered inside <main>. */
  body: SafeHtml;
  /** Extra content for <head> (rare). */
  head?: SafeHtml;
  /** When false, the nav sidebar is omitted (login page). */
  chrome?: boolean;
  /** CSRF token to expose to htmx requests. */
  csrfToken?: string;
}

export interface NavItem {
  key: string;
  href: string;
  label: string;
  icon: SafeHtml;
}

let navItems: NavItem[] = [];

/** Registered once at server construction; keeps layout.ts free of route imports. */
export function setNavItems(items: NavItem[]): void {
  navItems = items;
}

function navLink(item: NavItem, active: string | undefined): SafeHtml {
  const isActive = item.key === active;
  return html`<a
    href="${item.href}"
    class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      isActive
        ? 'bg-slate-900 text-white'
        : 'text-slate-600 hover:bg-slate-200 hover:text-slate-900'
    }"
    >${item.icon}<span>${item.label}</span></a
  >`;
}

/**
 * Full page shell. Responsive by default (A5): sidebar on ≥md, top bar with a
 * details-based disclosure menu on small screens. No JS needed for the menu.
 */
export function page(opts: PageOptions): string {
  const chrome = opts.chrome !== false;
  const nav = html`${navItems.map((i) => navLink(i, opts.active))}`;

  const sidebar = chrome
    ? html`
        <header class="border-b border-slate-200 bg-white md:hidden">
          <details class="group">
            <summary
              class="flex cursor-pointer list-none items-center justify-between px-4 py-3 [&::-webkit-details-marker]:hidden"
            >
              <span class="text-base font-semibold tracking-tight">🕯️ Cinderella Admin</span>
              <span class="text-slate-500 group-open:rotate-90 transition-transform">☰</span>
            </summary>
            <nav class="flex flex-col gap-1 border-t border-slate-100 p-3">${nav}</nav>
          </details>
        </header>
        <aside
          class="hidden w-56 shrink-0 flex-col gap-1 border-r border-slate-200 bg-white p-4 md:flex"
        >
          <div class="mb-4 px-3 text-base font-semibold tracking-tight">🕯️ Cinderella Admin</div>
          <nav class="flex flex-col gap-1">${nav}</nav>
          <form method="post" action="/logout" class="mt-auto">
            <input type="hidden" name="_csrf" value="${opts.csrfToken ?? ''}" />
            <button
              type="submit"
              class="w-full rounded-lg px-3 py-2 text-left text-sm font-medium text-slate-500 hover:bg-slate-200 hover:text-slate-900"
            >
              Sign out
            </button>
          </form>
        </aside>
      `
    : html``;

  const doc = html`<!doctype html>
    <html lang="en" class="h-full">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
        <title>${opts.title} — Cinderella Admin</title>
        <link rel="stylesheet" href="/assets/app.css" />
        <script src="/assets/htmx.min.js" defer></script>
        ${opts.head ?? html``}
      </head>
      <body
        class="h-full bg-slate-100 text-slate-900 antialiased"
        ${
          opts.csrfToken ? raw(`hx-headers='{"x-csrf-token":"${escapeHtml(opts.csrfToken)}"}'`) : ''
        }
      >
        <div class="flex min-h-full flex-col md:flex-row">
          ${sidebar}
          <main class="min-w-0 flex-1 p-4 md:p-8">${opts.body}</main>
        </div>
      </body>
    </html>`;
  return doc.value;
}
