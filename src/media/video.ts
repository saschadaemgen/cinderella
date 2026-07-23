/**
 * Video-link matchers (CCB-S3-014 §1).
 *
 * A matcher recognises a URL, extracts the id and start time, and yields
 * everything the front needs to render a click-to-play card: the canonical page
 * URL, the privacy-preserving embed URL, and where a thumbnail can be fetched
 * from if the wire did not carry one.
 *
 * This is a REGISTRY, not a hardcoded YouTube case. Adding PeerTube, Vimeo or a
 * direct video file is a new entry in `MATCHERS`, never a change here — the
 * capture side and the front both go through `matchVideoUrl`, so a new provider
 * lights up everywhere at once, exactly like the plugin pattern.
 */

export interface VideoMatch {
  /** Provider key, e.g. `youtube`. Also the admin toggle key. */
  provider: string;
  /** Human name for the "loads content from …" notice. */
  providerName: string;
  /** The provider's id for this video. */
  videoId: string;
  /** Start offset in seconds, 0 when none. */
  startSeconds: number;
  /** The page a member would open — the "open on YouTube" link. */
  canonicalUrl: string;
  /** The privacy-preserving player src, loaded only on click. */
  embedUrl: string;
  /** Where we can fetch a thumbnail if the message carried none. */
  thumbnailUrl: string;
}

interface Matcher {
  provider: string;
  providerName: string;
  /** Hosts this matcher owns, lower-cased, without a leading `www.`. */
  hosts: string[];
  match(url: URL): { videoId: string; startSeconds: number } | null;
}

/** Parses YouTube's `t`/`start` (`90`, `1m30s`, `1h2m3s`) into seconds. */
function parseStart(raw: string | null): number {
  if (!raw) return 0;
  const plain = Number.parseInt(raw, 10);
  if (/^\d+$/.test(raw.trim())) return Number.isFinite(plain) ? plain : 0;
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(raw.trim());
  if (!m) return 0;
  const h = Number.parseInt(m[1] ?? '0', 10);
  const min = Number.parseInt(m[2] ?? '0', 10);
  const sec = Number.parseInt(m[3] ?? '0', 10);
  return h * 3600 + min * 60 + sec;
}

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

const youtube: Matcher = {
  provider: 'youtube',
  providerName: 'YouTube',
  hosts: ['youtube.com', 'youtu.be', 'm.youtube.com', 'youtube-nocookie.com'],
  match(url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
    let id = '';
    if (host === 'youtu.be') {
      id = url.pathname.slice(1).split('/')[0] ?? '';
    } else {
      // youtube.com/watch?v=ID, /shorts/ID, /embed/ID, /v/ID, /live/ID
      const v = url.searchParams.get('v');
      if (v) {
        id = v;
      } else {
        const m = /^\/(?:shorts|embed|v|live)\/([^/?#]+)/.exec(url.pathname);
        if (m) id = m[1] ?? '';
      }
    }
    if (!YT_ID.test(id)) return null;
    return { videoId: id, startSeconds: start };
  },
};

const MATCHERS: Matcher[] = [youtube];

/** The providers a matcher exists for — the admin's list of what can be enabled. */
export const VIDEO_PROVIDERS = MATCHERS.map((m) => ({ key: m.provider, name: m.providerName }));

/**
 * Recognises a video URL, or returns null. Malformed URLs never throw — capture
 * runs this over untrusted member text, and a bad link is simply not a video.
 */
export function matchVideoUrl(rawUrl: string): VideoMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  for (const m of MATCHERS) {
    if (!m.hosts.includes(host)) continue;
    const hit = m.match(url);
    if (!hit) continue;
    return buildMatch(m, hit.videoId, hit.startSeconds);
  }
  return null;
}

function buildMatch(m: Matcher, videoId: string, startSeconds: number): VideoMatch {
  // YouTube is the only provider today; the URL builders live with the matcher
  // it applies to. A second provider adds its own here.
  const startQ = startSeconds > 0 ? `?start=${startSeconds}` : '';
  const watchStart = startSeconds > 0 ? `&t=${startSeconds}` : '';
  return {
    provider: m.provider,
    providerName: m.providerName,
    videoId,
    startSeconds,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}${watchStart}`,
    // youtube-nocookie: no cookies or tracking are set until playback, and
    // playback only happens on the visitor's deliberate click.
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}${startQ}`,
    // hqdefault always exists for a valid id (unlike maxresdefault).
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/** The one embed origin the CSP must allow when a video card is on the page. */
export const VIDEO_FRAME_ORIGIN = 'https://www.youtube-nocookie.com';
