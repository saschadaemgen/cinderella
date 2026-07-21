/**
 * Public marketing site presentation (CCB-S2-012, redesigned CCB-S3-001).
 *
 * The operator's approved dark-neon template (tmp/Cinderella Website.html) ported
 * to self-contained SSR: every page server-rendered from the locale files (SEO
 * preserved), themed CSS + tiny vanilla scripts inlined under a per-response CSP
 * nonce, fonts/avatar served same-origin, lucide icons inlined — no CDN, no
 * framework. The building blocks stay OFF by default (D-025): the cookie banner +
 * first-party analytics load NOTHING until the visitor accepts; social share is
 * script-free links. Essential storage — the theme (`cn-theme`) and the language
 * cookie — needs no consent.
 *
 * Copy note (CCB-S3-001, operator decision): the strong "consent + CSAM screening"
 * messaging is a forward-looking shop window; the binding point is first
 * distribution. Do not weaken it here — the copy lives in locales/*.json.
 */

import { html, raw, type SafeHtml } from '../html.js';
import { siteCss } from './css.js';
import { siteIcon } from './icons.js';
import {
  archiveDemoScript,
  chromeScript,
  REVEAL_SCRIPT,
  STARFIELD_SCRIPT,
  themeBootScript,
  type DemoConfig,
  type DemoMessage,
} from './client.js';
import type { LocaleSet } from './i18n.js';
import { NAV_PAGES, pagePath, HOME, type SitePage } from './pages.js';
import { CONTACT_EMAIL, GITHUB_URL, type SiteSeoHead } from './seo.js';
import { shouldLoadAnalytics, type ShareNetwork, type SiteSettings } from '../../site/settings.js';

export interface SitePageView {
  locale: string;
  locales: LocaleSet;
  page: SitePage;
  origin: string;
  nonce: string;
  seo: SiteSeoHead;
  site: SiteSettings;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const THEME_COLORS = { light: '#F4F7FA', dark: '#050A12' } as const;
const AVATAR_SRC = '/assets/site/cinderella-avatar.jpg';

/** Sample data for the archive demo — placeholder content only (public repo). */
const AD_MSGS: DemoMessage[] = [
  {
    g: '#privacy-talk',
    a: 'mara',
    t: '14:02',
    text: 'New onion-routing writeup is up — covers guard selection end to end.',
  },
  {
    g: '#privacy-talk',
    a: 'devnull',
    t: '14:03',
    text: "Does it touch on padding overhead? That's where most guides hand-wave.",
  },
  {
    g: '#selfhosting',
    a: 'kai',
    t: '09:11',
    text: "Here's my docker-compose.yml for the archive bot behind Caddy.",
    media: 'file',
  },
  { g: '#selfhosting', a: 'lena', t: '09:14', text: 'meetup_recording.mp4', media: 'video' },
  {
    g: '#foss-de',
    a: 'tomasz',
    t: '21:40',
    text: 'AGPL vs GPL for a bot serving a public archive — 14 replies deep now.',
  },
  {
    g: '#privacy-talk',
    a: 'mara',
    t: '14:20',
    text: 'Passkey rollout checklist v2 attached — WebAuthn only, no fallback.',
    media: 'file',
  },
  {
    g: '#foss-de',
    a: 'ingrid',
    t: '21:52',
    text: 'Onion services plus this archive = searchable history without a central host.',
  },
  {
    g: '#selfhosting',
    a: 'kai',
    t: '10:02',
    text: 'grafana-dashboard.png — capture throughput over 24h.',
    media: 'image',
  },
  {
    g: '#privacy-talk',
    a: 'devnull',
    t: '15:31',
    text: 'Consent prompt fired before capture, logged with the group id. Clean.',
  },
  {
    g: '#foss-de',
    a: 'tomasz',
    t: '22:05',
    text: 'Full-text search across a year of threads in under 40 ms.',
  },
];
const AD_GROUPS = ['#privacy-talk', '#selfhosting', '#foss-de'];
const AD_MEDIA_ICON: Record<string, string> = {
  file: 'file-text',
  video: 'clapperboard',
  image: 'image',
};

const SHARE_LABELS: Record<ShareNetwork, string> = {
  x: 'X',
  facebook: 'Facebook',
  reddit: 'Reddit',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  email: 'Email',
};

function shareUrl(net: ShareNetwork, pageUrl: string, title: string): string {
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
    case 'linkedin':
      return `https://www.linkedin.com/sharing/share-offsite/?url=${u}`;
    case 'email':
      return `mailto:?subject=${t}&body=${u}`;
  }
}

// ---------- shared building blocks ----------

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'outline';

function badge(tone: Tone, label: string): SafeHtml {
  return html`<span class="cn-badge cn-badge-${tone}">${label}</span>`;
}

function sectionHeader(o: {
  eyebrow?: string;
  title: string;
  lede?: string;
  center?: boolean;
}): SafeHtml {
  return html`<div class="cn-sechead${o.center ? ' cn-sechead-center' : ''}">
    ${o.eyebrow ? html`<div class="cn-sechead-eyebrow">${o.eyebrow}</div>` : null}
    <h2 class="cn-sechead-title">${o.title}</h2>
    ${o.lede ? html`<p class="cn-sechead-lede">${o.lede}</p>` : null}
  </div>`;
}

function featureTile(icon: string, title: string, body: string, tileBadge?: SafeHtml): SafeHtml {
  return html`<div class="cn-card cn-card-default cn-card-pad-md">
    <div class="cn-ftile-icon">${siteIcon(icon)}</div>
    <div class="cn-ftile-title">${title}${tileBadge ?? null}</div>
    <p class="cn-ftile-body">${body}</p>
  </div>`;
}

function btnLink(
  href: string,
  variant: 'primary' | 'secondary' | 'ghost',
  size: 'sm' | 'md' | 'lg',
  inner: SafeHtml,
): SafeHtml {
  return html`<a class="cn-btn cn-btn-${variant} cn-btn-${size}" href="${href}">${inner}</a>`;
}

function wordmark(v: SitePageView, size = 20): SafeHtml {
  return html`<a class="wordmark" href="${pagePath(v.locale, HOME)}">
    <img
      class="wm-av"
      src="${AVATAR_SRC}"
      alt=""
      aria-hidden="true"
      width="${size + 12}"
      height="${size + 12}"
    />
    <span style="font-weight:700;font-size:${size}px;letter-spacing:-.03em;color:var(--text-bright)"
      >${v.t('brand.name')}</span
    >
  </a>`;
}

function pageHero(o: {
  badge?: SafeHtml;
  eyebrow?: string;
  title: SafeHtml;
  lede?: string;
}): SafeHtml {
  return html`<section class="hero-bg fx-hero">
    <div class="wrap" style="padding:80px 24px 64px;max-width:900px;position:relative">
      ${o.badge ? html`<div style="margin-bottom:16px">${o.badge}</div>` : null}
      ${
        o.eyebrow
          ? html`<div
              style="font-size:12px;font-weight:700;letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-neon);margin-bottom:14px"
            >
              ${o.eyebrow}
            </div>`
          : null
      }
      <h1
        class="hero-h1"
        style="font-size:var(--size-display);margin:0;letter-spacing:-.025em;line-height:1.06"
      >
        ${o.title}
      </h1>
      ${
        o.lede
          ? html`<p
              style="font-size:18px;line-height:1.6;color:var(--text-muted);max-width:640px;margin:18px 0 0"
            >
              ${o.lede}
            </p>`
          : null
      }
    </div>
  </section>`;
}

// ---------- chrome ----------

function navLinks(v: SitePageView): SafeHtml {
  const links = NAV_PAGES.map((p) => {
    // The legal sub-pages highlight the Legal nav entry.
    const current = p.key === v.page.key || (p.key === 'legal' && v.page.key.startsWith('legal'));
    return html`<a class="nav-link${current ? ' active' : ''}" href="${pagePath(v.locale, p)}"
      >${v.t(p.navKey)}</a
    >`;
  });
  return html`${links}`;
}

function headerControls(v: SitePageView): SafeHtml {
  return html`<div class="lang-seg" role="group" aria-label="${v.t('lang.label')}">
      ${v.locales.codes.map(
        (code) =>
          html`<a
            href="${pagePath(code, v.page)}"
            hreflang="${code}"
            class="${code === v.locale ? 'on' : ''}"
            ${code === v.locale ? raw('aria-current="true"') : ''}
            >${code}</a
          >`,
      )}
    </div>
    <button
      type="button"
      id="cn-theme-toggle"
      class="hdr-iconbtn"
      aria-label="${v.t('a11y.theme')}"
      title="${v.t('a11y.theme')}"
    >
      ${siteIcon('sun', { size: 18, className: 'i-sun' })}${siteIcon('moon', {
        size: 18,
        className: 'i-moon',
      })}
    </button>
    <a class="nav-login" href="/login"
      >${siteIcon('key-round', { size: 14 })} ${v.t('nav.login')}</a
    >`;
}

function header(v: SitePageView): SafeHtml {
  return html`<header class="site-header">
    <div class="wrap" style="display:flex;align-items:center;gap:20px;height:64px">
      ${wordmark(v)}
      <nav class="nav-desktop" style="gap:2px;flex:1;margin-left:14px" aria-label="Primary">
        ${navLinks(v)}
      </nav>
      <span class="nav-desktop" style="gap:10px">${headerControls(v)}</span>
      <span style="flex:1" class="mobile-menu"></span>
      <button
        type="button"
        id="cn-burger"
        class="hdr-iconbtn burger"
        aria-label="${v.t('a11y.menu')}"
        aria-expanded="false"
        aria-controls="cn-mobile-menu"
      >
        ${siteIcon('menu', { size: 20, className: 'i-menu' })}${siteIcon('x', {
          size: 20,
          className: 'i-close',
        })}
      </button>
    </div>
    <div
      id="cn-mobile-menu"
      class="mobile-menu"
      hidden
      style="border-top:1px solid var(--border-neutral);background:var(--surface-raised);padding:12px 24px 18px"
    >
      <nav style="display:flex;flex-direction:column;gap:2px" aria-label="Menu">${navLinks(v)}</nav>
      <div style="display:flex;gap:10px;align-items:center;margin-top:14px">
        ${headerControls(v)}
      </div>
    </div>
  </header>`;
}

function footerCol(title: string, items: Array<[string, string, boolean?]>): SafeHtml {
  return html`<div class="fcol" style="min-width:150px">
    <div
      style="font-size:12px;font-weight:700;letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-neon);margin-bottom:14px"
    >
      ${title}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px">
      ${items.map(
        ([label, href, external]) =>
          html`<a href="${href}" ${external ? raw('target="_blank" rel="noopener"') : ''}
            >${label}</a
          >`,
      )}
    </div>
  </div>`;
}

function footer(v: SitePageView): SafeHtml {
  const l = v.locale;
  return html`<footer
    style="margin-top:120px;border-top:1px solid var(--border-neutral);background:var(--surface-raised);position:relative"
  >
    <span class="foot-top" aria-hidden="true"></span>
    <div class="wrap" style="display:flex;gap:48px;padding:64px 24px 44px;flex-wrap:wrap">
      <div style="flex:1 1 280px">
        ${wordmark(v, 22)}
        <p
          style="font-size:14px;color:var(--text-muted);margin:14px 0 16px;max-width:320px;line-height:1.65"
        >
          ${v.t('footer.blurb')}
        </p>
        <div style="display:flex;gap:8px">
          ${badge('warning', v.t('badge.alpha'))} ${badge('neutral', v.t('badge.agpl'))}
        </div>
      </div>
      ${footerCol(v.t('footer.product'), [
        [v.t('nav.features'), `/${l}/features`],
        ['Pro', `/${l}/pro`],
        [v.t('nav.security'), `/${l}/security`],
        [v.t('footer.docs'), `/${l}/docs`],
      ])}
      ${footerCol(v.t('footer.opensource'), [
        [v.t('footer.github'), GITHUB_URL, true],
        [v.t('footer.agpl'), `/${l}/open-source`],
        [v.t('footer.changelog'), `${GITHUB_URL}/commits/main`, true],
      ])}
      ${footerCol(v.t('footer.legal'), [
        [v.t('footer.legalnotice'), `/${l}/legal`],
        [v.t('footer.privacy'), `/${l}/legal/privacy`],
        [v.t('footer.terms'), `/${l}/legal/terms`],
      ])}
    </div>
    ${shareBlock(v)}
    <div
      class="wrap"
      style="display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:18px 24px;border-top:1px solid var(--border-neutral);font-size:13px;color:var(--text-faint)"
    >
      <span>${v.t('footer.copyright')}</span>
      <span>${v.t('footer.built')}</span>
    </div>
  </footer>`;
}

function shareBlock(v: SitePageView): SafeHtml {
  if (!v.site.socialShare.enabled || v.site.socialShare.networks.length === 0) return html``;
  const pageUrl = v.seo.canonicalUrl;
  const title = v.seo.title;
  return html`<div class="wrap footer-share">
    <p class="share-title">${siteIcon('paperclip', { size: 13 })} ${v.t('share.label')}</p>
    <div class="share-links">
      ${v.site.socialShare.networks.map(
        (net) =>
          html`<a href="${shareUrl(net, pageUrl, title)}" target="_blank" rel="noopener noreferrer"
            >${SHARE_LABELS[net]}</a
          >`,
      )}
    </div>
  </div>`;
}

// ---------- archive demo (SSR + progressive enhancement) ----------

function demoRow(v: SitePageView, m: DemoMessage): SafeHtml {
  const mediaLabel =
    m.media === 'file'
      ? v.t('demo.attachment')
      : m.media === 'video'
        ? 'video · behind auth'
        : 'image · behind auth';
  return html`<div class="ad-msg">
    <span class="ad-avatar" aria-hidden="true">${m.a[0]?.toUpperCase() ?? ''}</span>
    <div style="flex:1;min-width:0">
      <div class="ad-meta">
        <b>${m.a}</b><span class="ad-grp">${m.g}</span><span class="ad-time">${m.t}</span>
        <span class="ad-arch"
          >${siteIcon('check', { size: 12, color: 'var(--success)' })}${v.t('demo.archived')}</span
        >
      </div>
      <div class="ad-text">${m.text}</div>
      ${
        m.media
          ? html`<div class="ad-chip">
              ${siteIcon(AD_MEDIA_ICON[m.media] ?? 'file-text', {
                size: 13,
                color: 'var(--text-accent)',
              })}<span>${mediaLabel}</span>${siteIcon('lock', {
                size: 11,
                color: 'var(--text-faint)',
              })}
            </div>`
          : null
      }
    </div>
  </div>`;
}

function archiveDemo(v: SitePageView): SafeHtml {
  return html`<div class="ad-frame" id="cn-ad">
    <div class="ad-titlebar">
      <span class="ad-dot" style="background:#E5646E"></span>
      <span class="ad-dot" style="background:#E0B454"></span>
      <span class="ad-dot" style="background:#4ADE9E"></span>
      <span class="ad-url"
        >${siteIcon('lock', { size: 12, color: 'var(--success)' })} archive.cinderella.example /
        <span id="cn-ad-url-group" data-all="${v.t('demo.allgroups.short')}"
          >${v.t('demo.allgroups.short')}</span
        ></span
      >
      <span class="ad-badge">${v.t('demo.preview')}</span>
    </div>
    <div class="ad-body">
      <aside class="ad-side">
        <div class="ad-side-label">${v.t('demo.groups')}</div>
        <button type="button" class="ad-g on" data-group="all">
          ${siteIcon('archive', { size: 14 })} ${v.t('demo.allgroups')}<span class="ad-count"
            >${AD_MSGS.length}</span
          >
        </button>
        ${AD_GROUPS.map(
          (g) =>
            html`<button type="button" class="ad-g" data-group="${g}">
              ${siteIcon('hash', { size: 14 })}${g.replace('#', '')}<span class="ad-count"
                >${AD_MSGS.filter((m) => m.g === g).length}</span
              >
            </button>`,
        )}
        <div class="ad-consent">
          ${siteIcon('shield-check', { size: 14, color: 'var(--success)' })}<span
            >${v.t('demo.consent')}</span
          >
        </div>
      </aside>
      <div class="ad-main">
        <div class="ad-searchbar">
          ${siteIcon('search', { size: 17, color: 'var(--text-faint)' })}
          <input
            id="cn-ad-input"
            class="ad-input"
            placeholder="${v.t('demo.search.placeholder')}"
            aria-label="${v.t('demo.search.label')}"
          />
          <button type="button" id="cn-ad-clear" class="ad-clear" aria-label="${v.t('demo.clear')}">
            ${siteIcon('x', { size: 15 })}
          </button>
        </div>
        <div class="ad-filters">
          <button type="button" id="cn-ad-media" class="cn-tag" aria-pressed="false">
            ${siteIcon('paperclip', { size: 13 })} ${v.t('demo.hasmedia')}
          </button>
          <span class="ad-resultcount" id="cn-ad-count"
            >${v.t('demo.messages', { n: AD_MSGS.length })}</span
          >
        </div>
        <div class="ad-scroll ad-stream" id="cn-ad-stream">
          ${AD_MSGS.map((m) => demoRow(v, m))}
        </div>
        <div class="ad-empty" id="cn-ad-empty">
          ${siteIcon('search-x', { size: 22, color: 'var(--text-faint)' })}
          <div>${v.t('demo.empty')} <span id="cn-ad-empty-q"></span></div>
        </div>
      </div>
    </div>
  </div>`;
}

function demoConfig(v: SitePageView): DemoConfig {
  const iconStr = (name: string, size: number, color?: string): string =>
    siteIcon(name, { size, ...(color ? { color } : {}) }).toString();
  return {
    messages: AD_MSGS,
    groups: AD_GROUPS,
    word: 'onion',
    i18n: {
      messages: v.t('demo.messages', { n: '{n}' }),
      of: v.t('demo.of', { n: '{n}', total: '{total}' }),
      empty: v.t('demo.empty'),
      archived: v.t('demo.archived'),
      attachment: v.t('demo.attachment'),
    },
    icons: {
      check: iconStr('check', 12, 'var(--success)'),
      lock: iconStr('lock', 11, 'var(--text-faint)'),
      'file-text': iconStr('file-text', 13, 'var(--text-accent)'),
      clapperboard: iconStr('clapperboard', 13, 'var(--text-accent)'),
      image: iconStr('image', 13, 'var(--text-accent)'),
    },
  };
}

// ---------- page bodies ----------

function homeBody(v: SitePageView): SafeHtml {
  const l = v.locale;
  const tiles = [
    ['shield-alert', 'csam'],
    ['shield-check', 'consent'],
    ['lock', 'secure'],
    ['database', 'archived'],
  ] as const;
  const trust: Array<[string, string]> = [
    ['shield-alert', v.t('trust.csam')],
    ['shield-check', v.t('trust.consent')],
    ['key-round', v.t('trust.passkeys')],
    ['cpu', v.t('trust.localai')],
    ['git-branch', 'AGPL-3.0'],
  ];
  const roadmap = ['categorization', 'videogallery', 'moderation', 'localai', 'multitenancy'];
  const secPoints: Array<[string, string]> = [
    ['key-round', v.t('home.sec.point1')],
    ['lock', v.t('home.sec.point2')],
    ['cpu', v.t('home.sec.point3')],
    ['flag', v.t('home.sec.point4')],
  ];
  return html`
    <section class="hero-bg fx-hero">
      <div class="wrap hero-cine">
        <div class="htext">
          <a class="ann sym sym-left" href="/${l}/features" style="animation-delay:40ms">
            <span class="ann-dot"></span>
            <span>${v.t('hero.ann')}</span>
            <span class="ann-chip">${siteIcon('arrow-right', { size: 13 })}</span>
          </a>
          <h1 class="hero-h1" style="margin:18px 0 22px;letter-spacing:-.03em">
            <span
              class="sym sym-blur"
              style="display:block;white-space:nowrap;animation-delay:120ms"
              >${v.t('hero.title1')}</span
            >
            <span
              class="grad-text sym sym-rise"
              style="display:block;white-space:nowrap;animation-delay:240ms"
              >${v.t('hero.title2')}</span
            >
          </h1>
          <p
            class="sym sym-left"
            style="font-size:18px;line-height:1.6;color:var(--text-muted);max-width:500px;margin:0;animation-delay:380ms"
          >
            ${v.t('hero.lede')}
          </p>
          <div
            class="sym sym-scale"
            style="display:flex;gap:12px;margin-top:26px;flex-wrap:wrap;animation-delay:480ms"
          >
            ${btnLink(`/${l}/security`, 'primary', 'lg', html`${v.t('hero.cta.safeguards')}`)}
            ${btnLink(
              `/${l}/features`,
              'secondary',
              'lg',
              html`${v.t('hero.cta.explore')} ${siteIcon('arrow-right', { size: 15 })}`,
            )}
          </div>
          <div class="trust sym sym-blur" style="justify-content:flex-start;animation-delay:580ms">
            ${trust.map(
              ([i, label]) =>
                html`<span>${siteIcon(i, { size: 14, color: 'var(--text-faint)' })}${label}</span>`,
            )}
          </div>
        </div>
        <div class="hero-stage sym sym-right" style="animation-delay:220ms">
          <div class="pring">
            <img src="${AVATAR_SRC}" alt="${v.t('brand.name')}" width="420" height="420" />
            <span class="pchip c1"><span class="d"></span>${v.t('hero.chip.consent')}</span>
            <span class="pchip c2"><span class="d"></span>${v.t('hero.chip.csam')}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('home.live.eyebrow'),
        title: v.t('home.live.title'),
        lede: v.t('home.live.lede'),
      })}
      <div class="hero-visual" style="margin-top:36px">${archiveDemo(v)}</div>
    </section>

    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('home.how.eyebrow'),
        title: v.t('home.how.title'),
        lede: v.t('home.how.lede'),
        center: true,
      })}
      <div class="grid4" style="margin-top:48px">
        ${tiles.map(([icon, k]) =>
          featureTile(icon, v.t(`home.tile.${k}.title`), v.t(`home.tile.${k}.body`)),
        )}
      </div>
    </section>

    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('home.suite.eyebrow'),
        title: v.t('home.suite.title'),
        lede: v.t('home.suite.lede'),
      })}
      <div class="grid2" style="margin-top:40px;align-items:stretch">
        <div class="cn-card cn-card-default cn-card-pad-lg">
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:18px;font-weight:700;color:var(--text-bright)"
              >${v.t('home.suite.archive.title')}</span
            >${badge('success', v.t('badge.live'))}
          </div>
          <p style="font-size:15px;line-height:1.65;color:var(--text-muted);margin:12px 0 18px">
            ${v.t('home.suite.archive.body')}
          </p>
          ${btnLink(
            `/${l}/features`,
            'secondary',
            'sm',
            html`${v.t('home.suite.archive.cta')} ${siteIcon('arrow-right', { size: 14 })}`,
          )}
        </div>
        <div class="cn-card cn-card-default cn-card-pad-lg">
          <div style="font-size:18px;font-weight:700;color:var(--text-bright)">
            ${v.t('home.suite.roadmap.title')}
          </div>
          <div style="display:flex;flex-direction:column;gap:11px;margin-top:16px">
            ${roadmap.map(
              (r) =>
                html`<div
                  style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-neutral);padding-bottom:10px;font-size:14px"
                >
                  <span>${v.t(`roadmap.${r}`)}</span>${badge('outline', v.t('badge.planned'))}
                </div>`,
            )}
          </div>
        </div>
      </div>
    </section>

    <section class="band wrap" data-reveal>
      <div
        class="cn-card cn-card-default cn-card-pad-lg"
        style="display:flex;gap:48px;align-items:center;flex-wrap:wrap"
      >
        <div style="flex:1 1 340px">
          ${sectionHeader({
            eyebrow: v.t('home.sec.eyebrow'),
            title: v.t('home.sec.title'),
            lede: v.t('home.sec.lede'),
          })}
          <div style="margin-top:22px">
            ${btnLink(
              `/${l}/security`,
              'secondary',
              'md',
              html`${v.t('home.sec.cta')} ${siteIcon('arrow-right', { size: 14 })}`,
            )}
          </div>
        </div>
        <div style="flex:1 1 300px;display:flex;flex-direction:column;gap:12px">
          ${secPoints.map(
            ([i, label]) =>
              html`<div
                style="display:flex;gap:11px;align-items:center;font-size:15px;color:var(--text-body)"
              >
                ${siteIcon(i, { size: 17, color: 'var(--text-accent)' })}${label}
              </div>`,
          )}
        </div>
      </div>
    </section>
  `;
}

function featuresBody(v: SitePageView): SafeHtml {
  const caps = [
    { icon: 'shield-check', k: 'cap1', dev: false },
    { icon: 'shield-alert', k: 'cap2', dev: true },
    { icon: 'search', k: 'cap3', dev: false, extraChips: ['Video', 'SEO'] },
    { icon: 'flag', k: 'cap4', dev: false },
  ];
  const roadmap = [
    ['tags', 'categorization'],
    ['clapperboard', 'videogallery'],
    ['gavel', 'moderation'],
    ['cpu', 'localai'],
    ['building-2', 'multitenancy'],
  ] as const;
  return html`
    ${pageHero({
      badge: badge('warning', v.t('badge.alpha')),
      eyebrow: v.t('features.eyebrow'),
      title: html`${v.t('features.title1')}<span class="grad-text">${v.t('brand.name')}</span
        >${v.t('features.title2')}`,
      lede: v.t('features.lede'),
    })}
    <section class="band wrap" data-reveal style="padding-top:64px">
      <div style="display:flex;flex-direction:column;gap:16px">
        ${caps.map(
          (c, i) =>
            html`<div
              class="cn-card ${c.dev ? 'cn-card-accent' : 'cn-card-default'} cn-card-pad-lg"
              style="display:flex;gap:24px;align-items:flex-start;flex-wrap:wrap"
            >
              <div
                style="position:relative;width:44px;height:44px;flex:none;border-radius:var(--radius-sm);background:var(--neon-weak);border:1px solid rgba(232,56,159,.2);display:flex;align-items:center;justify-content:center;color:var(--text-neon)"
              >
                ${siteIcon(c.icon, { size: 22 })}
                <span
                  style="position:absolute;top:-9px;left:-9px;width:20px;height:20px;border-radius:99px;background:var(--surface-card);border:1px solid var(--border-neutral);font-family:var(--font-mono);font-size:10px;color:var(--text-faint);display:flex;align-items:center;justify-content:center"
                  >${i + 1}</span
                >
              </div>
              <div style="flex:1 1 420px">
                <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  <span style="font-size:19px;font-weight:700;color:var(--text-bright)"
                    >${v.t(`features.${c.k}.title`)}</span
                  >
                  ${c.dev ? badge('danger', v.t('badge.indev')) : null}
                </div>
                <p
                  style="font-size:14px;line-height:1.7;color:var(--text-muted);margin:8px 0 14px;max-width:660px"
                >
                  ${v.t(`features.${c.k}.body`)}
                </p>
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  ${[1, 2, 3].map(
                    (n) => html`<span class="cn-tag">${v.t(`features.${c.k}.chip${n}`)}</span>`,
                  )}
                  ${(c.extraChips ?? []).map((ch) => html`<span class="cn-tag">${ch}</span>`)}
                </div>
              </div>
            </div>`,
        )}
      </div>
    </section>
    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('features.roadmap.eyebrow'),
        title: v.t('features.roadmap.title'),
        lede: v.t('features.roadmap.lede'),
      })}
      <div class="grid3" style="margin-top:36px">
        ${roadmap.map(([icon, k]) =>
          featureTile(
            icon,
            v.t(`roadmap.${k}`),
            v.t(`features.rm.${k}.body`),
            badge('outline', v.t('badge.planned')),
          ),
        )}
      </div>
    </section>
  `;
}

function pricingTier(o: {
  name: string;
  price: string;
  period?: string;
  desc: string;
  features: string[];
  cta: string;
  ctaHref: string;
  highlight?: boolean;
  tierBadge?: SafeHtml;
}): SafeHtml {
  return html`<div
    class="cn-card ${o.highlight ? 'cn-card-accent cn-tier-highlight' : 'cn-card-default'} cn-card-pad-lg"
  >
    <div class="cn-tier-name">${o.name}${o.tierBadge ?? null}</div>
    <div class="cn-tier-price">
      <b>${o.price}</b>${o.period ? html`<span> ${o.period}</span>` : null}
    </div>
    <p class="cn-tier-desc">${o.desc}</p>
    <ul class="cn-tier-list">
      ${o.features.map((f) => html`<li>${f}</li>`)}
    </ul>
    ${btnLink(o.ctaHref, o.highlight ? 'primary' : 'secondary', 'md', html`${o.cta}`)}
  </div>`;
}

function proBody(v: SitePageView): SafeHtml {
  const l = v.locale;
  return html`
    ${pageHero({
      badge: badge('accent', 'Pro'),
      eyebrow: v.t('pro.eyebrow'),
      title: html`${v.t('pro.title')}`,
      lede: v.t('pro.lede'),
    })}
    <section class="band wrap" data-reveal style="padding-top:64px">
      <div class="grid3">
        ${featureTile('server', v.t('pro.tile1.title'), v.t('pro.tile1.body'))}
        ${featureTile('layers', v.t('pro.tile2.title'), v.t('pro.tile2.body'))}
        ${featureTile('life-buoy', v.t('pro.tile3.title'), v.t('pro.tile3.body'))}
      </div>
    </section>
    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('pro.pricing.eyebrow'),
        title: v.t('pro.pricing.title'),
        lede: v.t('pro.pricing.lede'),
      })}
      <div class="grid3" style="margin-top:36px;align-items:stretch">
        ${pricingTier({
          name: v.t('pro.tier1.name'),
          price: v.t('pro.tier1.price'),
          period: v.t('pro.tier1.period'),
          desc: v.t('pro.tier1.desc'),
          features: [v.t('pro.tier1.f1'), v.t('pro.tier1.f2'), v.t('pro.tier1.f3')],
          cta: v.t('pro.tier1.cta'),
          ctaHref: `/${l}/open-source`,
        })}
        ${pricingTier({
          name: v.t('pro.tier2.name'),
          price: v.t('pro.tier2.price'),
          period: v.t('pro.tier2.period'),
          desc: v.t('pro.tier2.desc'),
          features: [
            v.t('pro.tier2.f1'),
            v.t('pro.tier2.f2'),
            v.t('pro.tier2.f3'),
            v.t('pro.tier2.f4'),
          ],
          cta: v.t('pro.tier2.cta'),
          ctaHref: `mailto:${CONTACT_EMAIL}?subject=Cinderella%20Pro%20waitlist`,
          highlight: true,
          tierBadge: badge('accent', v.t('badge.recommended')),
        })}
        ${pricingTier({
          name: v.t('pro.tier3.name'),
          price: v.t('pro.tier3.price'),
          desc: v.t('pro.tier3.desc'),
          features: [v.t('pro.tier3.f1'), v.t('pro.tier3.f2'), v.t('pro.tier3.f3')],
          cta: v.t('pro.tier3.cta'),
          ctaHref: `mailto:${CONTACT_EMAIL}?subject=Cinderella%20Enterprise`,
        })}
      </div>
    </section>
    <section class="band wrap" data-reveal>
      <div
        class="cn-card cn-card-accent cn-card-pad-lg"
        style="display:flex;gap:32px;align-items:center;flex-wrap:wrap"
      >
        <div style="flex:1 1 320px">
          <div style="font-size:20px;font-weight:700;color:var(--text-bright)">
            ${v.t('pro.customer.title')}
          </div>
          <p style="font-size:14px;color:var(--text-muted);margin:8px 0 0;line-height:1.6">
            ${v.t('pro.customer.body')}
          </p>
        </div>
        <div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <div class="cn-field" style="width:220px">
            <label class="cn-field-label" for="cn-pro-email">${v.t('pro.customer.email')}</label>
            <input id="cn-pro-email" class="cn-input cn-input-md" placeholder="you@example.org" />
          </div>
          <a
            class="cn-btn cn-btn-primary cn-btn-md"
            href="mailto:${CONTACT_EMAIL}?subject=Cinderella%20Pro%20access%20request"
            >${v.t('pro.customer.request')}</a
          >
          ${btnLink('/login', 'secondary', 'md', html`${v.t('pro.customer.login')}`)}
        </div>
      </div>
    </section>
  `;
}

function securityBody(v: SitePageView): SafeHtml {
  const l = v.locale;
  const flow = [
    { t: v.t('security.flow.consent'), i: 'shield-check', on: false },
    { t: v.t('security.flow.screen'), i: 'shield-alert', on: true },
    { t: v.t('security.flow.publish'), i: 'globe', on: false },
  ];
  const tiles = [
    ['key-round', 'tile1'],
    ['server', 'tile2'],
    ['flag', 'tile3'],
  ] as const;
  return html`
    ${pageHero({
      eyebrow: v.t('security.eyebrow'),
      title: html`${v.t('security.title1')}<span class="grad-text">${v.t('security.title2')}</span
        >${v.t('security.title3')}`,
      lede: v.t('security.lede'),
    })}
    <section class="band wrap" style="padding-top:48px" data-reveal>
      <div
        class="cn-card cn-card-accent cn-card-pad-lg"
        style="display:flex;gap:36px;flex-wrap:wrap;align-items:center"
      >
        <div style="flex:1 1 360px">
          <div
            style="width:44px;height:44px;border-radius:var(--radius-sm);background:var(--neon-weak);border:1px solid rgba(232,56,159,.28);display:flex;align-items:center;justify-content:center;color:var(--text-neon);box-shadow:var(--edge-lit),var(--glow-neon-sm)"
          >
            ${siteIcon('shield-alert', { size: 22 })}
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 0">
            <span style="font-size:22px;font-weight:700;color:var(--text-bright)"
              >${v.t('security.csam.title')}</span
            >
            ${badge('danger', v.t('badge.indev'))}
          </div>
          <p
            style="font-size:15px;line-height:1.65;color:var(--text-muted);margin:10px 0 0;max-width:520px"
          >
            ${v.t('security.csam.body')}
          </p>
        </div>
        <div
          style="flex:1 1 280px;display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap"
        >
          ${flow.map(
            (f, i) => html`
              <div
                style="text-align:center;padding:16px 14px;border-radius:var(--radius-md);border:1px solid ${
                  f.on ? 'rgba(232,56,159,.45)' : 'var(--border-neutral)'
                };background:${f.on ? 'var(--neon-weak)' : 'var(--surface-field)'};box-shadow:${
                  f.on ? 'var(--glow-neon-sm)' : 'none'
                };min-width:92px"
              >
                ${siteIcon(f.i, {
                  size: 20,
                  color: f.on ? 'var(--text-neon)' : 'var(--text-muted)',
                })}
                <div
                  style="font-family:var(--font-mono);font-size:11px;color:${
                    f.on ? 'var(--text-neon)' : 'var(--text-muted)'
                  };margin-top:8px"
                >
                  ${f.t}
                </div>
              </div>
              ${
                i < flow.length - 1
                  ? siteIcon('arrow-right', { size: 16, color: 'var(--text-faint)' })
                  : null
              }
            `,
          )}
        </div>
      </div>
      <div class="grid3" style="margin-top:16px;align-items:start">
        ${tiles.map(([icon, k]) =>
          featureTile(icon, v.t(`security.${k}.title`), v.t(`security.${k}.body`)),
        )}
      </div>
    </section>
    <section class="band wrap" data-reveal>
      <div
        class="cn-card cn-card-default cn-card-pad-lg"
        style="display:flex;gap:32px;align-items:center;flex-wrap:wrap"
      >
        ${siteIcon('bug', { size: 26, color: 'var(--text-accent)' })}
        <div style="flex:1 1 320px">
          <div style="font-size:17px;font-weight:700;color:var(--text-bright)">
            ${v.t('security.vuln.title')}
          </div>
          <p style="font-size:14px;color:var(--text-muted);margin:6px 0 0;line-height:1.6">
            ${v.t('security.vuln.body')}
          </p>
        </div>
        ${btnLink(
          `/${l}/open-source`,
          'secondary',
          'md',
          html`${v.t('security.vuln.cta')} ${siteIcon('arrow-right', { size: 14 })}`,
        )}
      </div>
    </section>
  `;
}

function openSourceBody(v: SitePageView): SafeHtml {
  const steps: Array<[string, string]> = [
    [v.t('os.step1'), `git clone ${GITHUB_URL}`],
    [v.t('os.step2'), 'cp .env.example .env  # bot address, archive domain'],
    [v.t('os.step3'), 'docker compose up -d'],
  ];
  return html`
    ${pageHero({
      badge: badge('neutral', v.t('badge.agpl')),
      eyebrow: v.t('os.eyebrow'),
      title: html`${v.t('os.title')}`,
      lede: v.t('os.lede'),
    })}
    <section class="band wrap" data-reveal style="padding-top:64px">
      <div class="grid2" style="align-items:stretch">
        <div class="cn-card cn-card-default cn-card-pad-lg">
          <div style="display:flex;align-items:center;gap:10px">
            ${siteIcon('github', { size: 22, color: 'var(--text-accent)' })}<span
              style="font-size:17px;font-weight:700;color:var(--text-bright)"
              >${v.t('os.repo.title')}</span
            >
          </div>
          <p style="font-size:14px;line-height:1.7;color:var(--text-muted);margin:10px 0 16px">
            ${v.t('os.repo.body')}
          </p>
          <a
            class="cn-btn cn-btn-primary cn-btn-md"
            href="${GITHUB_URL}"
            target="_blank"
            rel="noopener"
            >${v.t('os.repo.cta')} ${siteIcon('external-link', { size: 14 })}</a
          >
        </div>
        <div class="cn-card cn-card-default cn-card-pad-lg">
          <div style="font-size:17px;font-weight:700;color:var(--text-bright)">
            ${v.t('os.why.title')}
          </div>
          <p style="font-size:14px;line-height:1.7;color:var(--text-muted);margin:10px 0 0">
            ${v.t('os.why.body')}
          </p>
        </div>
      </div>
    </section>
    <section class="band wrap" data-reveal>
      ${sectionHeader({
        eyebrow: v.t('os.self.eyebrow'),
        title: v.t('os.self.title'),
        lede: v.t('os.self.lede'),
      })}
      <div class="grid3" style="margin-top:36px">
        ${steps.map(
          ([t, code], i) =>
            html`<div class="cn-card cn-card-default cn-card-pad-md">
              <div
                style="font-family:var(--font-mono);font-size:11px;color:var(--text-accent);margin-bottom:8px"
              >
                0${i + 1}
              </div>
              <div
                style="font-size:15px;font-weight:700;color:var(--text-bright);margin-bottom:10px"
              >
                ${t}
              </div>
              <div class="mono-block" style="font-size:12px">${code}</div>
            </div>`,
        )}
      </div>
      <p style="font-size:13px;color:var(--text-faint);margin-top:16px">${v.t('os.self.note')}</p>
    </section>
  `;
}

// ---------- legal ----------

/** An accent-mono placeholder field: `[label]`. */
function ph(label: string): SafeHtml {
  return html`<span class="ph">[${label}]</span>`;
}

function legalTabs(v: SitePageView): SafeHtml {
  const l = v.locale;
  const items: Array<[string, string, string]> = [
    ['legal', `/${l}/legal`, v.t('legal.tab.impressum')],
    ['legal-privacy', `/${l}/legal/privacy`, v.t('legal.tab.privacy')],
    ['legal-terms', `/${l}/legal/terms`, v.t('legal.tab.terms')],
  ];
  return html`<nav class="cn-tabs cn-tabs-underline" aria-label="${v.t('legal.title')}">
    ${items.map(
      ([key, href, label]) =>
        html`<a
          class="cn-tab"
          href="${href}"
          ${v.page.key === key ? raw('aria-current="page"') : ''}
          >${label}</a
        >`,
    )}
  </nav>`;
}

function impressumDoc(v: SitePageView): SafeHtml {
  return html`<div class="doc">
    <h3>${v.t('impressum.title')}</h3>
    <p>${v.t('impressum.intro')}</p>
    <h3>${v.t('impressum.operator.h')}</h3>
    <p>
      Sascha Dämgen IT and More Systems<br />${ph(v.t('impressum.operator.street'))}<br />${ph(
        v.t('impressum.operator.city'),
      )}<br />${ph(v.t('impressum.operator.country'))}
    </p>
    <h3>${v.t('impressum.contact.h')}</h3>
    <p>
      ${v.t('impressum.contact.email')}
      <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br />${v.t('impressum.contact.phone')}
      ${ph('+49 …')}
    </p>
    <h3>${v.t('impressum.responsible.h')}</h3>
    <p>Sascha Dämgen${ph(v.t('impressum.responsible.suffix'))}</p>
    <h3>${v.t('impressum.ypo.h')}</h3>
    <p>${v.t('impressum.ypo.intro')}</p>
    <p>
      Dipl.-Kaufmann Eike Keller<br />Münsterstraße 34, 44145 Dortmund<br /><a
        href="mailto:e.keller@simplego.dev"
        >e.keller@simplego.dev</a
      >
    </p>
    <h3>${v.t('impressum.dispute.h')}</h3>
    <p>${v.t('impressum.dispute.body')}</p>
  </div>`;
}

function privacyDoc(v: SitePageView): SafeHtml {
  return html`<div class="doc">
    <h3>${v.t('privacy.title')}</h3>
    <p>${v.t('privacy.effective')} ${ph(v.t('privacy.effective.ph'))}. ${v.t('privacy.intro')}</p>
    <h3>${v.t('privacy.s1.h')}</h3>
    <p>${ph(v.t('privacy.s1.ph'))}</p>
    <h3>${v.t('privacy.s2.h')}</h3>
    <p>${v.t('privacy.s2.a')} ${ph('Art. 6(1) GDPR')}. ${v.t('privacy.s2.b')}</p>
    <h3>${v.t('privacy.s3.h')}</h3>
    <p>${v.t('privacy.s3.body')}</p>
    <h3>${v.t('privacy.s4.h')}</h3>
    <p>${ph(v.t('privacy.s4.ph'))}</p>
    <h3>${v.t('privacy.s5.h')}</h3>
    <p>${v.t('privacy.s5.body')}</p>
  </div>`;
}

function termsDoc(v: SitePageView): SafeHtml {
  return html`<div class="doc">
    <h3>${v.t('terms.title')}</h3>
    <p>${v.t('terms.effective')} ${ph(v.t('terms.effective.ph'))}</p>
    <h3>${v.t('terms.s1.h')}</h3>
    <p>${v.t('terms.s1.body')}</p>
    <h3>${v.t('terms.s2.h')}</h3>
    <p>${v.t('terms.s2.body')}</p>
    <h3>${v.t('terms.s3.h')}</h3>
    <p>${v.t('terms.s3.body')}</p>
    <h3>${v.t('terms.s4.h')}</h3>
    <p>${v.t('terms.s4.body')}</p>
    <h3>${v.t('terms.s5.h')}</h3>
    <p>${ph(v.t('terms.s5.ph'))}</p>
  </div>`;
}

function legalBody(v: SitePageView): SafeHtml {
  const doc =
    v.page.key === 'legal-privacy'
      ? privacyDoc(v)
      : v.page.key === 'legal-terms'
        ? termsDoc(v)
        : impressumDoc(v);
  const draft = v.page.key !== 'legal';
  return html`
    ${pageHero({
      eyebrow: v.t('legal.eyebrow'),
      title: html`${v.t('legal.title')}`,
      lede: v.t('legal.lede'),
    })}
    <section class="wrap" style="padding-top:40px">
      ${legalTabs(v)}
      <div class="cn-card cn-card-quiet cn-card-pad-lg" style="margin-top:24px;max-width:860px">
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${badge('outline', v.t('legal.badge.template'))}
          ${draft ? badge('warning', v.t('legal.badge.draft')) : null}
        </div>
        ${doc}
      </div>
    </section>
  `;
}

/** A clean "coming soon" stub (Docs — never a 404), in the template design. */
function stubBody(v: SitePageView): SafeHtml {
  return html`
    <section class="hero-bg fx-hero">
      <div class="wrap stub-hero">
        ${badge('warning', v.t('stub.badge'))}
        <h1>${v.t(v.page.navKey)}</h1>
        <p>${v.t('stub.lead')}</p>
        <p>${v.t('stub.body')}</p>
        <div class="stub-cta">
          <a
            class="cn-btn cn-btn-primary cn-btn-md"
            href="${GITHUB_URL}"
            target="_blank"
            rel="noopener"
            >${v.t('os.repo.cta')} ${siteIcon('external-link', { size: 14 })}</a
          >
          ${btnLink(pagePath(v.locale, HOME), 'secondary', 'md', html`${v.t('stub.back')}`)}
        </div>
      </div>
    </section>
  `;
}

// ---------- cookie banner + consent-gated analytics (D-023/D-025, unchanged) ----------

function consentScript(v: SitePageView): string {
  const url = JSON.stringify(v.site.analytics.scriptUrl).replace(/</g, '\\u003c');
  return `(function(){var KEY='cin-consent';var banner=document.getElementById('cin-cookie');
function stored(){try{return localStorage.getItem(KEY);}catch(e){return null;}}
function save(x){try{localStorage.setItem(KEY,x);}catch(e){}}
var loaded=false;function loadAnalytics(){if(loaded)return;loaded=true;var s=document.createElement('script');s.src=${url};s.async=true;document.head.appendChild(s);}
function accept(){save('granted');if(banner)banner.hidden=true;loadAnalytics();}
function reject(){save('denied');if(banner)banner.hidden=true;}
var d=stored();
if(d==='granted'){loadAnalytics();}
else if(d!=='denied'&&banner){banner.hidden=false;}
var a=document.getElementById('cin-accept'),r=document.getElementById('cin-reject');
if(a)a.addEventListener('click',accept);if(r)r.addEventListener('click',reject);})();`;
}

function cookieBanner(v: SitePageView): SafeHtml {
  const policyHref = v.site.cookieBanner.policyUrl || `/${v.locale}/legal/privacy`;
  return html`<div
    id="cin-cookie"
    class="cn-cookiebar"
    role="region"
    aria-live="polite"
    aria-label="${v.t('cookie.title')}"
    hidden
  >
    <div class="cn-cookiebar-inner">
      <div class="cn-cookiebar-text">
        <b>${v.t('cookie.title')}</b> — ${v.t('cookie.text')}
        <a href="${policyHref}">${v.t('cookie.policy')}</a>.
      </div>
      <div class="cn-cookiebar-actions">
        <button type="button" id="cin-reject" class="cn-btn cn-btn-ghost cn-btn-sm">
          ${v.t('cookie.reject')}
        </button>
        <button type="button" id="cin-accept" class="cn-btn cn-btn-primary cn-btn-sm">
          ${v.t('cookie.accept')}
        </button>
      </div>
    </div>
  </div>`;
}

// ---------- document ----------

function bodyFor(v: SitePageView): SafeHtml {
  if (!v.page.built) return stubBody(v);
  switch (v.page.key) {
    case 'features':
      return featuresBody(v);
    case 'pro':
      return proBody(v);
    case 'security':
      return securityBody(v);
    case 'open-source':
      return openSourceBody(v);
    case 'legal':
    case 'legal-privacy':
    case 'legal-terms':
      return legalBody(v);
    default:
      return homeBody(v);
  }
}

/** Renders a complete marketing page document. */
export function renderSitePage(v: SitePageView): string {
  const seo = v.seo;
  const dir = v.locales.meta[v.locale]?.dir ?? 'ltr';
  const gated = shouldLoadAnalytics(v.site);
  const body = bodyFor(v);
  const isHome = v.page.key === 'home' && v.page.built;

  const scripts = [
    chromeScript(THEME_COLORS.light, THEME_COLORS.dark),
    STARFIELD_SCRIPT,
    REVEAL_SCRIPT,
    ...(isHome ? [archiveDemoScript(demoConfig(v))] : []),
  ].join('\n');

  const doc = html`<!doctype html>
    <html lang="${v.locale}" dir="${dir}" class="no-js">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="${seo.robots}" />
        <meta name="theme-color" content="${THEME_COLORS.dark}" />
        <script nonce="${v.nonce}">
          ${raw(themeBootScript(THEME_COLORS.light))};
        </script>
        <title>${seo.title}</title>
        <meta name="description" content="${seo.description}" />
        <link rel="canonical" href="${seo.canonicalUrl}" />
        ${seo.alternates.map(
          (a) => html`<link rel="alternate" hreflang="${a.hreflang}" href="${a.href}" />`,
        )}
        <meta property="og:type" content="${seo.ogType}" />
        <meta property="og:title" content="${seo.ogTitle}" />
        <meta property="og:description" content="${seo.ogDescription}" />
        <meta property="og:site_name" content="${seo.ogSiteName}" />
        <meta property="og:locale" content="${seo.ogLocale}" />
        <meta property="og:url" content="${seo.ogUrl}" />
        <meta property="og:image" content="${v.origin}${AVATAR_SRC}" />
        <meta name="twitter:card" content="${seo.twitterCard}" />
        <meta name="twitter:title" content="${seo.ogTitle}" />
        <meta name="twitter:description" content="${seo.ogDescription}" />
        <script type="application/ld+json" nonce="${v.nonce}">
          ${raw(seo.jsonLd)}
        </script>
        <style nonce="${v.nonce}">
          ${raw(siteCss())}
        </style>
      </head>
      <body>
        <a class="skip" href="#main">${v.t('a11y.skip')}</a>
        <canvas id="cn-starfield" aria-hidden="true"></canvas>
        ${header(v)}
        <main id="main"><div class="screen">${body}</div></main>
        ${footer(v)} ${gated ? cookieBanner(v) : null}
        <script nonce="${v.nonce}">
          ${raw(scripts)};
        </script>
        ${
          gated
            ? html`<script nonce="${v.nonce}">
                ${raw(consentScript(v))};
              </script>`
            : null
        }
      </body>
    </html>`;
  return doc.toString();
}
