/** Small shared UI helpers for the admin views. */

import { html, type SafeHtml } from '../html.js';

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export type Tone = 'green' | 'red' | 'amber' | 'slate' | 'blue';

const TONES: Record<Tone, string> = {
  green: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
  amber: 'bg-amber-100 text-amber-800',
  slate: 'bg-slate-200 text-slate-700',
  blue: 'bg-sky-100 text-sky-800',
};

export function badge(text: string, tone: Tone = 'slate'): SafeHtml {
  return html`<span
    class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}"
    >${text}</span
  >`;
}

export function card(title: string, content: SafeHtml, extraCls = ''): SafeHtml {
  return html`<section
    class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${extraCls}"
  >
    <h2 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">${title}</h2>
    ${content}
  </section>`;
}

export function pageHeader(title: string, subtitle?: string): SafeHtml {
  return html`<div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight sm:text-2xl">${title}</h1>
    ${subtitle ? html`<p class="mt-1 text-sm text-slate-500">${subtitle}</p>` : null}
  </div>`;
}

/** Stat tile for the dashboard. */
export function stat(label: string, value: string | number, tone: Tone = 'slate'): SafeHtml {
  const toneCls: Record<Tone, string> = {
    green: 'text-emerald-700',
    red: 'text-red-700',
    amber: 'text-amber-700',
    slate: 'text-slate-900',
    blue: 'text-sky-700',
  };
  return html`<div class="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <div class="text-xs font-medium uppercase tracking-wide text-slate-500">${label}</div>
    <div class="mt-1 text-2xl font-semibold ${toneCls[tone]}">${value}</div>
  </div>`;
}

/** Truncates member ids and long text for table display. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
