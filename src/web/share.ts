/**
 * Script-free social sharing (CCB-S3-025).
 *
 * Every share target is a PLAIN LINK we build ourselves and open on click. We do
 * NOT embed any vendor's official share widget or SDK: those load third-party code
 * and track every visitor whether or not they share. Plain links load nothing,
 * need no consent, and need no cookie-banner entry. The Open Graph / preview data
 * (CCB-S2-004) already makes a shared link look right.
 *
 * This is the single source of truth for the share URLs, labels, and icons, reused
 * by the marketing-site footer (src/web/site) and the archive stream's per-card
 * share bar (src/web/front). Icons are inline SVG (currentColor) so they inherit
 * the house accent and load nothing external.
 */

export type ShareNetwork =
  | 'x'
  | 'facebook'
  | 'reddit'
  | 'whatsapp'
  | 'telegram'
  | 'linkedin'
  | 'email';

/** Canonical order; the archive share bar defaults to the first five + copy link. */
export const SHARE_NETWORKS: readonly ShareNetwork[] = [
  'x',
  'facebook',
  'reddit',
  'whatsapp',
  'telegram',
  'linkedin',
  'email',
];

export const SHARE_LABELS: Record<ShareNetwork, string> = {
  x: 'X',
  facebook: 'Facebook',
  reddit: 'Reddit',
  whatsapp: 'WhatsApp',
  telegram: 'Telegram',
  linkedin: 'LinkedIn',
  email: 'Email',
};

/** True for a recognised network key (used to validate stored/posted settings). */
export function isShareNetwork(v: unknown): v is ShareNetwork {
  return typeof v === 'string' && (SHARE_NETWORKS as readonly string[]).includes(v);
}

/**
 * Builds the share-intent URL for a network. Every value is URL-encoded; the
 * result is a plain link that opens the target site's own share dialog. Returns ''
 * for an unknown network (the caller omits it).
 */
export function shareUrl(net: string, pageUrl: string, title: string): string {
  const u = encodeURIComponent(pageUrl);
  const t = encodeURIComponent(title);
  switch (net) {
    case 'x':
      return `https://twitter.com/intent/tweet?url=${u}&text=${t}`;
    case 'facebook':
      return `https://www.facebook.com/sharer/sharer.php?u=${u}`;
    case 'reddit':
      return `https://www.reddit.com/submit?url=${u}&title=${t}`;
    case 'whatsapp':
      return `https://api.whatsapp.com/send?text=${t}%20${u}`;
    case 'telegram':
      return `https://t.me/share/url?url=${u}&text=${t}`;
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    case 'email':
      return `mailto:?subject=${t}&body=${u}`;
    default:
      return '';
  }
}

/* Inline SVG brand/action icons (currentColor). Compact, recognisable, no external
   fetch. Sizing is set by the consuming CSS. */
export const SHARE_ICONS: Record<ShareNetwork, string> = {
  x: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 1.15h3.68l-8.04 9.19L24 22.85h-7.41l-5.8-7.58-6.64 7.58H.46l8.6-9.83L0 1.15h7.6l5.24 6.93 6.06-6.93Zm-1.29 19.5h2.04L6.48 3.24H4.29L17.61 20.65Z"/></svg>`,
  facebook: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.97h-1.51c-1.49 0-1.96.93-1.96 1.89v2.25h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07Z"/></svg>`,
  reddit: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0a12 12 0 1 0 0 24 12 12 0 0 0 0-24Zm5.01 12.9c.06.24.09.49.09.75 0 2.5-2.91 4.53-6.5 4.53s-6.5-2.03-6.5-4.53c0-.27.03-.53.1-.78a1.42 1.42 0 0 1 .86-2.55c.38 0 .72.15.97.39A7.9 7.9 0 0 1 11 9.05l.62-2.9 2.02.43a1.02 1.02 0 1 1 .12.5l-1.8-.38-.55 2.6c1.55.05 2.96.5 4.02 1.2a1.42 1.42 0 1 1 1.58 2.4ZM8.4 12.2a1 1 0 1 0 2 0 1 1 0 0 0-2 0Zm5.6 2.66c-.5.5-1.5.54-1.99.54s-1.5-.04-1.99-.54a.27.27 0 0 0-.38.38c.63.63 1.83.68 2.37.68s1.74-.05 2.37-.68a.27.27 0 1 0-.38-.38Zm-.4-1.66a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>`,
  whatsapp: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.53.15-.18.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.61-.92-2.21-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.88 1.22 3.08c.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.7.63.71.23 1.36.2 1.87.12.57-.08 1.76-.72 2-1.41.25-.7.25-1.29.17-1.42-.07-.13-.27-.2-.57-.35ZM12.02 2c-5.52 0-10 4.48-10 10 0 1.76.46 3.48 1.34 5L2 22l5.13-1.34A9.96 9.96 0 0 0 12.02 22c5.52 0 10-4.48 10-10s-4.48-10-10-10Zm0 18.3c-1.56 0-3.1-.42-4.44-1.2l-.32-.19-3.05.8.81-2.97-.2-.31a8.28 8.28 0 0 1-1.27-4.43c0-4.58 3.72-8.3 8.3-8.3s8.3 3.72 8.3 8.3-3.72 8.3-8.13 8.3Z"/></svg>`,
  telegram: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.95 4.57a1.06 1.06 0 0 0-1.42-.86L1.4 11.86c-.87.35-.86 1.6.02 1.92l5.19 1.62 2.01 6.44c.25.66 1.1.79 1.56.24l2.9-2.86 5.06 3.72c.53.4 1.3.11 1.44-.53l3.42-16.09c.01-.06.01-.12.01-.18Zm-4.6 4.23-9.32 5.73 1.27 4.82.3-3.68 7.75-6.87Z"/></svg>`,
  linkedin: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.42v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28ZM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14Zm1.78 13.02H3.55V9h3.57v11.45ZM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0Z"/></svg>`,
  email: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>`,
};

/** The copy-link action's icon (a chain link). */
export const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

/** A short confirmation tick (shown briefly after copy). */
export const COPY_OK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
