/**
 * Public marketing site presentation (CCB-S2-012).
 *
 * Self-contained SSR in the archive-front style: themed CSS + tiny scripts inlined
 * under a per-response CSP nonce, no external assets. Reuses the shared SimpleGo
 * theme (src/web/theme.ts) so the site and the archive look identical. Content is
 * server-rendered (not deferred to JS) so it indexes.
 *
 * Building blocks (all OFF by default, D-025): the cookie banner + first-party
 * analytics load NOTHING until the visitor accepts (consent-gated in the inline
 * boot); social share is script-free links. Essential storage — the theme (`sg-theme`)
 * and the language cookie — needs no consent.
 *
 * PLACEHOLDER COPY: all visible strings come from the locale files, which are marked
 * provisional (CCB-S2-012) pending final copy from the planning chat.
 */

import { html, raw, type SafeHtml } from '../html.js';
import { THEME_TOGGLE, THEME_TOGGLE_SCRIPT, THEME_VARS_CSS, themeBootScript } from '../theme.js';
import type { LocaleSet } from './i18n.js';
import { NAV_PAGES, pagePath, type SitePage } from './pages.js';
import { GITHUB_URL, LICENSE_URL, type SiteSeoHead } from './seo.js';
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

/** Inline glyphs (currentColor). */
const LOCK_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
const MENU_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
const SHARE_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;

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

/** Marketing layout CSS — palette shared with the archive front via THEME_VARS_CSS. */
function siteCss(): string {
  return `
${THEME_VARS_CSS}
*{box-sizing:border-box}
html{background:var(--bg);transition:background var(--tr),color var(--tr)}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--font);transition:background var(--tr),color var(--tr)}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-bright)}
.container{max-width:1080px;margin:0 auto;padding:0 20px}
.skip{position:absolute;left:-9999px;top:0;background:var(--accent);color:#fff;padding:8px 14px;border-radius:var(--radius-sm);z-index:10}
.skip:focus{left:12px;top:12px}
.theme-toggle{flex:none;width:40px;height:40px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--accent);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:var(--tr)}
.theme-toggle:hover{border-color:var(--accent)}
.theme-toggle svg{width:20px;height:20px}
.theme-toggle .sun{display:none}
.theme-toggle .moon{display:block}
[data-theme="dark"] .theme-toggle .sun{display:block}
[data-theme="dark"] .theme-toggle .moon{display:none}
/* Header */
.site-header{position:sticky;top:0;z-index:9;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.header-row{display:flex;align-items:center;gap:16px;height:64px}
.brand{display:inline-flex;align-items:center;gap:8px;font-weight:700;font-size:1.15rem;color:var(--text-bright)}
.brand:hover{color:var(--text-bright)}
.primary-nav{display:flex;gap:4px;margin-left:8px}
.primary-nav a{padding:8px 12px;border-radius:var(--radius-sm);color:var(--muted);font-size:.92rem;font-weight:600;transition:var(--tr)}
.primary-nav a:hover{color:var(--text-bright);background:var(--bg-card)}
.primary-nav a[aria-current="page"]{color:var(--accent);background:var(--bg-card)}
.header-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
.lang-switch{display:flex;gap:2px;align-items:center;font-size:.82rem}
.lang-switch a{padding:4px 7px;border-radius:6px;color:var(--muted);font-weight:600;text-transform:uppercase}
.lang-switch a[aria-current="true"]{color:var(--accent);background:var(--bg-card)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 18px;border-radius:var(--radius-sm);font-weight:600;font-size:.95rem;cursor:pointer;transition:var(--tr);border:1px solid transparent;white-space:nowrap}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover{background:var(--accent-bright);color:#fff;border-color:var(--accent-bright)}
.btn-secondary{background:var(--bg-card);color:var(--accent);border-color:var(--border)}
.btn-secondary:hover{border-color:var(--accent);color:var(--accent-bright)}
.btn-login{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-card);color:var(--muted);font-size:.85rem;font-weight:600}
.btn-login:hover{border-color:var(--accent);color:var(--accent)}
.nav-toggle{display:none}
.nav-toggle>summary{list-style:none;cursor:pointer;width:40px;height:40px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--fg);display:inline-flex;align-items:center;justify-content:center}
.nav-toggle>summary::-webkit-details-marker{display:none}
.nav-toggle .drawer{position:absolute;right:20px;left:20px;margin-top:10px;padding:10px;background:var(--bg-deep);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column;gap:2px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.nav-toggle .drawer a{padding:10px 12px;border-radius:var(--radius-sm);color:var(--fg);font-weight:600}
.nav-toggle .drawer a:hover{background:var(--bg-card);color:var(--accent)}
/* Hero */
.hero{padding:72px 0 48px;text-align:center}
.eyebrow{display:inline-block;font-size:.82rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);background:var(--bg-card);border:1px solid var(--border);padding:5px 12px;border-radius:999px;margin-bottom:20px}
.hero h1{font-size:clamp(2rem,5vw,3.3rem);line-height:1.1;margin:0 auto 18px;max-width:16ch;color:var(--text-bright);letter-spacing:-.02em}
.hero .lead{font-size:clamp(1.05rem,2.2vw,1.3rem);color:var(--muted);max-width:60ch;margin:0 auto 30px}
.cta-row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
/* Sections */
.section{padding:56px 0;border-top:1px solid var(--border)}
.section h2{font-size:clamp(1.6rem,3.5vw,2.2rem);margin:0 0 10px;color:var(--text-bright);letter-spacing:-.01em}
.section .section-lead{color:var(--muted);font-size:1.08rem;margin:0 0 32px;max-width:60ch}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}
.tile{background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;transition:var(--tr)}
.tile:hover{border-color:var(--accent)}
.tile h3{margin:0 0 8px;font-size:1.15rem;color:var(--text-bright)}
.tile p{margin:0;color:var(--muted);font-size:.97rem}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;margin-top:8px}
.points{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.point{display:flex;gap:12px;align-items:flex-start}
.point .dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--accent);margin-top:7px}
.point h3{margin:0 0 4px;font-size:1.02rem;color:var(--text-bright)}
.point p{margin:0;color:var(--muted);font-size:.95rem}
.cta-band{text-align:center;background:var(--card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:44px 24px}
.cta-band h2{border:0}
.cta-band .section-lead{margin:10px auto 24px}
.stub .cta-row{margin-top:22px}
/* Stub */
.stub{padding:80px 0;text-align:center}
.stub .badge{display:inline-block;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--accent);background:var(--bg-card);border:1px solid var(--border);padding:5px 12px;border-radius:999px;margin-bottom:18px}
.stub h1{font-size:clamp(1.8rem,4vw,2.6rem);margin:0 0 12px;color:var(--text-bright)}
.stub p{color:var(--muted);max-width:52ch;margin:0 auto 10px}
/* Footer */
.site-footer{border-top:1px solid var(--border);margin-top:24px;padding:44px 0 32px}
.footer-grid{display:flex;flex-wrap:wrap;gap:24px;justify-content:space-between;align-items:flex-start}
.footer-brand{max-width:34ch}
.footer-brand .brand{margin-bottom:8px}
.footer-brand p{color:var(--muted);font-size:.9rem;margin:0}
.footer-cols{display:flex;gap:48px;flex-wrap:wrap}
.footer-col h4{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:0 0 10px}
.footer-col a{display:block;color:var(--fg);font-size:.92rem;padding:3px 0}
.footer-col a:hover{color:var(--accent)}
.footer-share{margin-top:28px;padding-top:20px;border-top:1px solid var(--border)}
.footer-share .share-title{font-size:.82rem;color:var(--muted);margin:0 0 10px;display:flex;align-items:center;gap:6px}
.share-links{display:flex;flex-wrap:wrap;gap:8px}
.share-links a{display:inline-flex;align-items:center;padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--bg-card);color:var(--fg);font-size:.85rem;font-weight:600}
.share-links a:hover{border-color:var(--accent);color:var(--accent)}
.footer-legal{margin-top:24px;color:var(--muted);font-size:.82rem;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
/* Cookie banner */
.cookie-banner{position:fixed;left:16px;right:16px;bottom:16px;z-index:20;background:var(--bg-deep);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:0 16px 48px rgba(0,0,0,.3);display:flex;gap:16px;align-items:center;flex-wrap:wrap;max-width:720px;margin:0 auto}
.cookie-banner p{margin:0;flex:1;min-width:240px;font-size:.9rem;color:var(--fg)}
.cookie-banner .cookie-actions{display:flex;gap:8px;flex-wrap:wrap}
.cookie-banner button{padding:8px 16px;border-radius:var(--radius-sm);font-weight:600;font-size:.9rem;cursor:pointer;border:1px solid var(--border)}
.cookie-banner .accept{background:var(--accent);color:#fff;border-color:var(--accent)}
.cookie-banner .reject{background:var(--bg-card);color:var(--fg)}
@media (max-width:760px){
  .primary-nav{display:none}
  .header-actions .btn-login span{display:none}
  .nav-toggle{display:block}
}
`.trim();
}

/** The nav links (used in the desktop bar and the mobile drawer). */
function navLinks(v: SitePageView): SafeHtml {
  return html`${NAV_PAGES.map((p) => {
    const current = p.key === v.page.key;
    return html`<a href="${pagePath(v.locale, p)}" ${current ? raw('aria-current="page"') : ''}
      >${v.t(p.navKey)}</a
    >`;
  })}`;
}

function langSwitch(v: SitePageView): SafeHtml {
  return html`<div class="lang-switch" aria-label="${v.t('lang.label')}">
    ${v.locales.codes.map((code) => {
      const current = code === v.locale;
      return html`<a
        href="${pagePath(code, v.page)}"
        hreflang="${code}"
        ${current ? raw('aria-current="true"') : ''}
        >${code}</a
      >`;
    })}
  </div>`;
}

function header(v: SitePageView): SafeHtml {
  return html`<header class="site-header">
    <div class="container header-row">
      <a class="brand" href="${pagePath(v.locale, NAV_PAGES[0] as SitePage)}"
        >🕯️ ${v.t('brand.name')}</a
      >
      <nav class="primary-nav" aria-label="Primary">${navLinks(v)}</nav>
      <div class="header-actions">
        ${langSwitch(v)} ${raw(THEME_TOGGLE)}
        <a class="btn-login" href="/login">${raw(LOCK_ICON)}<span>${v.t('nav.login')}</span></a>
        <details class="nav-toggle">
          <summary aria-label="${v.t('a11y.menu')}">${raw(MENU_ICON)}</summary>
          <nav class="drawer" aria-label="Menu">${navLinks(v)}</nav>
        </details>
      </div>
    </div>
  </header>`;
}

function footer(v: SitePageView): SafeHtml {
  const docsHref = `/${v.locale}/docs`;
  const share = shareBlock(v);
  return html`<footer class="site-footer">
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="brand" href="${pagePath(v.locale, NAV_PAGES[0] as SitePage)}"
            >🕯️ ${v.t('brand.name')}</a
          >
          <p>${v.t('brand.tagline')}</p>
        </div>
        <div class="footer-cols">
          <div class="footer-col">
            <h4>${v.t('footer.links')}</h4>
            <a href="${GITHUB_URL}" target="_blank" rel="noopener">${v.t('footer.github')}</a>
            <a href="${docsHref}">${v.t('footer.docs')}</a>
          </div>
          <div class="footer-col">
            <h4>${v.t('footer.legal')}</h4>
            <a href="/${v.locale}/legal">${v.t('footer.legalnotice')}</a>
            <a href="/${v.locale}/legal">${v.t('footer.privacy')}</a>
            <a href="/${v.locale}/legal">${v.t('footer.terms')}</a>
          </div>
        </div>
      </div>
      ${share}
      <div class="footer-legal">
        <span>© ${v.t('brand.name')}</span>
        <a href="${LICENSE_URL}" target="_blank" rel="noopener">${v.t('footer.license')}</a>
        <span>· ${v.t('footer.built')}</span>
      </div>
    </div>
  </footer>`;
}

function shareBlock(v: SitePageView): SafeHtml {
  if (!v.site.socialShare.enabled || v.site.socialShare.networks.length === 0) return html``;
  const pageUrl = v.seo.canonicalUrl;
  const title = v.seo.title;
  return html`<div class="footer-share">
    <p class="share-title">${raw(SHARE_ICON)} ${v.t('share.label')}</p>
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

/** The home page body. */
function homeBody(v: SitePageView): SafeHtml {
  const docsHref = `/${v.locale}/docs`;
  const tile = (k: string): SafeHtml =>
    html`<div class="tile">
      <h3>${v.t(`what.${k}.title`)}</h3>
      <p>${v.t(`what.${k}.body`)}</p>
    </div>`;
  const point = (k: string): SafeHtml =>
    html`<div class="point">
      <span class="dot" aria-hidden="true"></span>
      <div>
        <h3>${v.t(`security.${k}.title`)}</h3>
        <p>${v.t(`security.${k}.body`)}</p>
      </div>
    </div>`;
  return html`
    <section class="hero container">
      <span class="eyebrow">${v.t('hero.eyebrow')}</span>
      <h1>${v.t('hero.title')}</h1>
      <p class="lead">${v.t('hero.subtitle')}</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="${GITHUB_URL}" target="_blank" rel="noopener"
          >${v.t('hero.cta_primary')}</a
        >
        <a class="btn btn-secondary" href="/login">${v.t('hero.cta_secondary')}</a>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2>${v.t('what.title')}</h2>
        <p class="section-lead">${v.t('what.subtitle')}</p>
        <div class="tiles">
          ${tile('consent')} ${tile('permanent')} ${tile('secure')} ${tile('public')}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2>${v.t('suite.title')}</h2>
        <p class="section-lead">${v.t('suite.body')}</p>
        <div class="split">
          <div class="tile">
            <h3>${v.t('suite.archive.title')}</h3>
            <p>${v.t('suite.archive.body')}</p>
          </div>
          <div class="tile">
            <h3>${v.t('suite.more.title')}</h3>
            <p>${v.t('suite.more.body')}</p>
          </div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <h2>${v.t('security.title')}</h2>
        <p class="section-lead">${v.t('security.body')}</p>
        <div class="points">
          ${point('passwordless')} ${point('encrypted')} ${point('localai')} ${point('yourdata')}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="container">
        <div class="cta-band">
          <h2>${v.t('cta.title')}</h2>
          <p class="section-lead">${v.t('cta.body')}</p>
          <div class="cta-row">
            <a class="btn btn-primary" href="${GITHUB_URL}" target="_blank" rel="noopener"
              >${v.t('cta.primary')}</a
            >
            <a class="btn btn-secondary" href="${docsHref}">${v.t('cta.secondary')}</a>
          </div>
        </div>
      </div>
    </section>
  `;
}

/** A clean "coming soon" stub (never a 404). */
function stubBody(v: SitePageView): SafeHtml {
  return html`
    <section class="stub container">
      <span class="badge">${v.t('stub.badge')}</span>
      <h1>${v.t(`nav.${navKeyFor(v.page)}`)}</h1>
      <p>${v.t('stub.lead')}</p>
      <p>${v.t('stub.body')}</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="${GITHUB_URL}" target="_blank" rel="noopener"
          >${v.t('hero.cta_primary')}</a
        >
        <a class="btn btn-secondary" href="${pagePath(v.locale, NAV_PAGES[0] as SitePage)}"
          >${v.t('stub.back')}</a
        >
      </div>
    </section>
  `;
}

/** The nav-key suffix for a page's label (`nav.suite` → `suite`). */
function navKeyFor(page: SitePage): string {
  return page.navKey.replace(/^nav\./, '');
}

/** Cookie-consent + analytics boot (only emitted when analytics is consent-gated). */
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
  const policyHref = v.site.cookieBanner.policyUrl || `/${v.locale}/legal`;
  return html`<div
    id="cin-cookie"
    class="cookie-banner"
    role="dialog"
    aria-live="polite"
    aria-label="${v.t('cookie.accept')}"
    hidden
  >
    <p>
      ${v.t('cookie.text')}
      <a href="${policyHref}">${v.t('cookie.policy')}</a>
    </p>
    <div class="cookie-actions">
      <button type="button" id="cin-reject" class="reject">${v.t('cookie.reject')}</button>
      <button type="button" id="cin-accept" class="accept">${v.t('cookie.accept')}</button>
    </div>
  </div>`;
}

/** Renders a complete marketing page document. */
export function renderSitePage(v: SitePageView): string {
  const seo = v.seo;
  const dir = v.locales.meta[v.locale]?.dir ?? 'ltr';
  const themeColor = '#050A12';
  const gated = shouldLoadAnalytics(v.site);
  const body = v.page.built ? homeBody(v) : stubBody(v);

  const doc = html`<!doctype html>
    <html lang="${v.locale}" dir="${dir}" data-theme="dark">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="${seo.robots}" />
        <meta name="theme-color" content="${themeColor}" />
        <script nonce="${v.nonce}">
          ${raw(themeBootScript(true, false))};
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
        <!-- CCB-S2-012: placeholder marketing copy, pending final copy from the planning chat -->
        <a class="skip" href="#main">${v.t('a11y.skip')}</a>
        ${header(v)}
        <main id="main">${body}</main>
        ${footer(v)} ${gated ? cookieBanner(v) : null}
        <script nonce="${v.nonce}">
          ${raw(THEME_TOGGLE_SCRIPT)};
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
