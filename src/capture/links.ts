/**
 * Extracts links from a captured message for the `links` table and for the
 * full-text `links_text`.
 *
 * Two sources: the SimpleX link preview (for `link`-type messages, which carries
 * a title/description) and any http(s) URLs found in the text body.
 */

import type { CapturedMessage, LinkPreview } from './message.js';

export interface ExtractedLink {
  url: string;
  title: string | undefined;
  description: string | undefined;
}

// http(s) URLs. Kept deliberately conservative; trailing punctuation is trimmed
// below so sentence-final URLs don't capture the period/paren/quote.
const URL_RE = /\bhttps?:\/\/[^\s<>[\]{}"'`]+/gi;
const TRAILING_PUNCT_RE = /[.,;:!?)\]}>"'`]+$/;

function normalizeUrl(raw: string): string | undefined {
  const trimmed = raw.replace(TRAILING_PUNCT_RE, '').trim();
  if (!trimmed) return undefined;
  try {
    // Validate; keep the original form (do not re-serialize, to avoid surprises).
    new URL(trimmed);
    return trimmed;
  } catch {
    return undefined;
  }
}

/** URLs found in free text. */
function urlsInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = normalizeUrl(match[0]);
    if (url) found.add(url);
  }
  return [...found];
}

export function extractLinks(msg: CapturedMessage): ExtractedLink[] {
  const byUrl = new Map<string, ExtractedLink>();

  // 1) The link preview (has title/description) takes precedence.
  const preview: LinkPreview | undefined = msg.linkPreview;
  if (preview) {
    const url = normalizeUrl(preview.url);
    if (url) {
      byUrl.set(url, { url, title: preview.title, description: preview.description });
    }
  }

  // 2) URLs embedded in the text body (no preview metadata).
  for (const url of urlsInText(msg.text)) {
    if (!byUrl.has(url)) {
      byUrl.set(url, { url, title: undefined, description: undefined });
    }
  }

  return [...byUrl.values()];
}

/** Space-joined link text (url + title + description) for the FTS column. */
export function linksToSearchText(links: ExtractedLink[]): string | null {
  if (links.length === 0) return null;
  const parts: string[] = [];
  for (const link of links) {
    parts.push(link.url);
    if (link.title) parts.push(link.title);
    if (link.description) parts.push(link.description);
  }
  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : null;
}
