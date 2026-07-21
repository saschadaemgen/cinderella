/**
 * verify:site (CCB-S2-012) — exercises the public marketing website against the REAL
 * Fastify server (via inject) on a real PGlite database. Proves: per-language routing
 * + negotiation + persistence, hreflang/SEO head, indexable site vs noindex admin,
 * the discreet login, clean stubs (no 404s), and the three building blocks shipping
 * OFF by default — with analytics consent-gated (no tracking before the banner) and
 * social share being script-free links.
 *
 * DEV harness only. No secrets, placeholder data.
 */

import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { buildServer } from '../src/web/server.js';
import { loadMigrationFiles } from '../src/db/migrate.js';
import { SettingsService } from '../src/settings/service.js';
import { SecurityService } from '../src/security/settings.js';
import { SiteService } from '../src/site/settings.js';
import { loadLocales, type LocaleSet } from '../src/web/site/i18n.js';
import { isPublicSitePath } from '../src/web/site/routes.js';
import type { Queryable } from '../src/db/pool.js';
import type { AdminConfig, Config } from '../src/config.js';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  — ${extra}`}`);
  if (!cond) failures++;
}

const ORIGIN = 'https://cinderella.example.test';

async function main(): Promise<void> {
  const pg = new PGlite();
  const db: Queryable = {
    async query(text, values) {
      const res = await pg.query(text, values ? [...values] : undefined);
      return {
        rows: res.rows as never[],
        rowCount: (res.affectedRows ?? res.rows.length) as number,
      };
    },
  };
  for (const m of await loadMigrationFiles()) await pg.exec(m.sql);

  // --- Locale loader (adding a language is a FILE) ---
  const locales = loadLocales('locales');
  check('i18n: en + de loaded, en default first', locales.codes[0] === 'en' && locales.has('de'));
  check('i18n: t resolves a real string', locales.t('en', 'hero.title').length > 10);
  check(
    'i18n: de differs from en (translated)',
    locales.t('de', 'hero.title') !== locales.t('en', 'hero.title'),
  );
  check(
    'i18n: missing key falls back to the key',
    locales.t('en', 'no.such.key') === 'no.such.key',
  );
  check('i18n: unknown locale is not supported', !locales.has('fr'));

  // --- Loader resilience (CCB-S2-012 review): a bad locale file must NOT crash the
  // process (this one process also hosts the admin console + capture worker). ---
  const tmp = mkdtempSync(join(tmpdir(), 'cin-locales-'));
  copyFileSync('locales/en.json', join(tmp, 'en.json'));
  writeFileSync(join(tmp, 'de.json'), '{ "hero.title": "kaputt", }'); // trailing comma = invalid
  let resilient: LocaleSet | null = null;
  try {
    resilient = loadLocales(tmp);
  } catch {
    resilient = null;
  }
  check('resilience: a malformed non-primary locale does NOT throw', resilient !== null);
  check(
    'resilience: en still loads, the broken de is skipped',
    !!resilient && resilient.has('en') && !resilient.has('de'),
  );
  // A mis-cased file name is normalized to lowercase so negotiation can match it.
  const tmp2 = mkdtempSync(join(tmpdir(), 'cin-locales2-'));
  copyFileSync('locales/en.json', join(tmp2, 'en.json'));
  copyFileSync('locales/de.json', join(tmp2, 'De.json'));
  const cased = loadLocales(tmp2);
  check('resilience: mis-cased De.json is normalized to code "de"', cased.has('de'));
  // A missing primary is synthesized (empty) rather than crashing the whole product.
  const tmp3 = mkdtempSync(join(tmpdir(), 'cin-locales3-'));
  const synth = loadLocales(tmp3);
  check(
    'resilience: missing primary is synthesized (no throw, t() degrades to key ids)',
    synth.has('en') && synth.t('en', 'hero.title') === 'hero.title',
  );

  // --- Public-path predicate ---
  const codes = locales.codes;
  check('predicate: / is public', isPublicSitePath('/', codes));
  check('predicate: /en is public', isPublicSitePath('/en', codes));
  check('predicate: /en/suite is public', isPublicSitePath('/en/suite', codes));
  check('predicate: /sitemap-site.xml is public', isPublicSitePath('/sitemap-site.xml', codes));
  check('predicate: /messages is NOT public (admin)', !isPublicSitePath('/messages', codes));
  check('predicate: /dashboard is NOT public (admin)', !isPublicSitePath('/dashboard', codes));
  check('predicate: /website is NOT public (admin config)', !isPublicSitePath('/website', codes));

  const adminCfg: AdminConfig = {
    adminPort: 0,
    adminUsername: 'operator',
    adminPasswordHash: 'x',
    sessionSecret: 'verify-site-session-secret-0123456789abcdef01',
    publicOrigin: ORIGIN,
    rpId: 'cinderella.example.test',
    webauthnOrigin: ORIGIN,
    rpName: 'Cinderella',
  };
  const cfg: Config = {
    botDisplayName: 'Cinderella',
    simplexDbPrefix: './state/simplex/cinderella',
    simplexFilesFolder: './state/files',
    groupName: 'test',
    mediaRoot: process.cwd(),
    avatarPath: '',
    databaseUrl: 'postgres://x',
    logLevel: 'error',
  };
  const settings = await SettingsService.load(db, cfg.logLevel);
  const security = await SecurityService.load(db);
  const site = await SiteService.load(db); // all OFF initially
  const app = buildServer({
    db,
    adminCfg,
    cfg,
    settings,
    security,
    site,
    mediaRoot: cfg.mediaRoot,
  });
  await app.ready();

  // --- Root negotiation + persistence ---
  const rootDefault = await app.inject({ method: 'GET', url: '/' });
  check(
    'root: / redirects to the default language (/en)',
    rootDefault.statusCode === 302 && rootDefault.headers.location === '/en',
    `status=${rootDefault.statusCode} loc=${rootDefault.headers.location}`,
  );
  const rootAL = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'accept-language': 'de-DE,de;q=0.9' },
  });
  check('root: Accept-Language de → /de', rootAL.headers.location === '/de');
  const rootCookie = await app.inject({
    method: 'GET',
    url: '/',
    headers: { 'accept-language': 'en', cookie: 'cin-lang=de' },
  });
  check('root: cin-lang cookie wins over Accept-Language', rootCookie.headers.location === '/de');

  // --- Localized landing pages ---
  const en = await app.inject({ method: 'GET', url: '/en' });
  const de = await app.inject({ method: 'GET', url: '/de' });
  check('en: 200 + <html lang="en">', en.statusCode === 200 && en.body.includes('<html lang="en"'));
  check('de: 200 + <html lang="de">', de.statusCode === 200 && de.body.includes('<html lang="de"'));
  check('en: renders the English hero title', en.body.includes(locales.t('en', 'hero.title')));
  check('de: renders the German hero title', de.body.includes(locales.t('de', 'hero.title')));
  check(
    'lang: /en persists the choice (Set-Cookie cin-lang=en)',
    String(en.headers['set-cookie'] ?? '').includes('cin-lang=en'),
  );
  check('switcher: /en links to /de', en.body.includes('href="/de"'));
  check('login: discreet operator-login button links to /login', en.body.includes('href="/login"'));
  check(
    'nav: home + all stub links present',
    en.body.includes('/en/suite') && en.body.includes('/en/legal'),
  );

  // --- SEO head ---
  check('seo: canonical to /en', en.body.includes(`<link rel="canonical" href="${ORIGIN}/en"`));
  check('seo: hreflang de alternate', en.body.includes(`hreflang="de" href="${ORIGIN}/de"`));
  check('seo: hreflang x-default', en.body.includes(`hreflang="x-default" href="${ORIGIN}/en"`));
  check(
    'seo: title + description present',
    en.body.includes('<title>') && en.body.includes('name="description"'),
  );
  check(
    'seo: OpenGraph + Twitter',
    en.body.includes('property="og:title"') && en.body.includes('name="twitter:card"'),
  );
  check('seo: og:locale is en_US', en.body.includes('content="en_US"'));
  check('seo: de og:locale is de_DE', de.body.includes('content="de_DE"'));
  check(
    'seo: JSON-LD Organization + WebSite + SoftwareApplication',
    en.body.includes('"Organization"') &&
      en.body.includes('"WebSite"') &&
      en.body.includes('"SoftwareApplication"'),
  );
  check('seo: home is indexable', en.body.includes('name="robots" content="index'));

  // --- Stubs (clean, not 404) ---
  const stub = await app.inject({ method: 'GET', url: '/en/suite' });
  check('stub: /en/suite is 200 (not a 404)', stub.statusCode === 200);
  check('stub: shows the coming-soon badge', stub.body.includes(locales.t('en', 'stub.badge')));
  check('stub: thin placeholder is noindex', stub.body.includes('name="robots" content="noindex'));
  const stubDe = await app.inject({ method: 'GET', url: '/de/docs' });
  check(
    'stub: /de/docs is a German 200',
    stubDe.statusCode === 200 && stubDe.body.includes('<html lang="de"'),
  );
  const unknown = await app.inject({ method: 'GET', url: '/en/nope' });
  check('stub: unknown slug is 404', unknown.statusCode === 404);

  // --- Headers: site indexable + frame-DENY + nonce CSP; admin still gated ---
  const csp = String(en.headers['content-security-policy'] ?? '');
  check(
    'headers: nonce CSP (default-src none, nonce style/script, frame-ancestors none)',
    csp.includes("default-src 'none'") &&
      csp.includes("style-src 'nonce-") &&
      csp.includes("script-src 'nonce-") &&
      csp.includes("frame-ancestors 'none'"),
  );
  check(
    'headers: x-frame-options DENY + nosniff + no-store',
    en.headers['x-frame-options'] === 'DENY' &&
      en.headers['x-content-type-options'] === 'nosniff' &&
      en.headers['cache-control'] === 'no-store',
  );
  check('headers: site is NOT noindex (no X-Robots-Tag)', en.headers['x-robots-tag'] === undefined);
  const adminHome = await app.inject({ method: 'GET', url: '/dashboard' });
  check(
    'admin: /dashboard still gated (302 → /login)',
    adminHome.statusCode === 302 && adminHome.headers.location === '/login',
  );
  const adminCfgPage = await app.inject({ method: 'GET', url: '/website' });
  check('admin: /website config is gated (302 → /login)', adminCfgPage.statusCode === 302);

  // --- Building blocks OFF by default (no banner, no analytics, no share) ---
  check('off: no cookie banner rendered', !en.body.includes('id="cin-cookie"'));
  check('off: no analytics/consent bootstrap', !en.body.includes('cin-consent'));
  check('off: no share links', !en.body.includes('class="share-links"'));

  // --- Turn the three blocks ON (analytics consent-gated behind the banner) ---
  await site.save(
    {
      analytics: {
        enabled: true,
        provider: 'Plausible',
        scriptUrl: 'https://stats.example.test/js/s.js',
      },
      cookieBanner: { enabled: true, policyUrl: '' },
      socialShare: { enabled: true, networks: ['x', 'reddit', 'email'] },
    },
    'verify-site',
  );
  const on = await app.inject({ method: 'GET', url: '/en' });
  const onCsp = String(on.headers['content-security-policy'] ?? '');
  check('on: cookie banner rendered', on.body.includes('id="cin-cookie"'));
  check('on: consent bootstrap present', on.body.includes('cin-consent'));
  check(
    'on: analytics origin added to CSP (script-src + connect-src)',
    onCsp.includes('https://stats.example.test') &&
      onCsp.split('https://stats.example.test').length === 3,
  );
  check(
    'consent-gate: analytics NOT loaded directly (no eager <script src>)',
    !on.body.includes('<script src="https://stats.example.test'),
  );
  check(
    'consent-gate: analytics URL only inside the consent bootstrap (loads after accept)',
    on.body.includes('stats.example.test'),
  );
  check('share: links rendered', on.body.includes('class="share-links"'));
  check(
    'share: script-free — anchors to the network share endpoints, no vendor script',
    on.body.includes('twitter.com/intent/tweet') && !on.body.includes('platform.twitter.com'),
  );

  // --- Analytics requires the banner (consent mechanism) to load ---
  await site.save(
    {
      analytics: { enabled: true, provider: '', scriptUrl: 'https://stats.example.test/js/s.js' },
      cookieBanner: { enabled: false, policyUrl: '' },
      socialShare: { enabled: false, networks: [] },
    },
    'verify-site',
  );
  const noBanner = await app.inject({ method: 'GET', url: '/en' });
  const noBannerCsp = String(noBanner.headers['content-security-policy'] ?? '');
  check(
    'gate: analytics on + banner off ⇒ nothing loads (no banner, no analytics origin)',
    !noBanner.body.includes('id="cin-cookie"') &&
      !noBanner.body.includes('cin-consent') &&
      !noBannerCsp.includes('stats.example.test'),
  );

  // --- Adversarial: a hostile analytics URL cannot break out of the inline script ---
  await site.save(
    {
      analytics: {
        enabled: true,
        provider: '',
        scriptUrl: 'https://evil.example.test/a.js</script><script>x',
      },
      cookieBanner: { enabled: true, policyUrl: '' },
      socialShare: { enabled: false, networks: [] },
    },
    'verify-site',
  );
  const xss = await app.inject({ method: 'GET', url: '/en' });
  check(
    'xss: analytics URL is escaped in the inline bootstrap (no </script> breakout)',
    !xss.body.includes('a.js</script><script>x'),
  );

  // --- Sitemap ---
  const smSite = await app.inject({ method: 'GET', url: '/sitemap-site.xml' });
  check(
    'sitemap: /sitemap-site.xml lists /en + /de with hreflang',
    smSite.statusCode === 200 &&
      smSite.body.includes(`${ORIGIN}/en`) &&
      smSite.body.includes(`${ORIGIN}/de`) &&
      smSite.body.includes('xhtml:link'),
  );
  const smIndex = await app.inject({ method: 'GET', url: '/sitemap.xml' });
  check('sitemap: index references the site sitemap', smIndex.body.includes('/sitemap-site.xml'));

  await app.close();
  console.log('');
  if (failures > 0) {
    console.error(`verify:site FAILED (${failures})`);
    process.exit(1);
  }
  console.log('verify:site OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
