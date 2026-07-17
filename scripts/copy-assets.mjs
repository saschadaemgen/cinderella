// Copies vendored front-end assets (htmx) into public/assets/.
// Runs as part of `npm run assets`. No CDN dependencies — everything is
// served same-origin under the admin console's strict CSP.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'assets');
mkdirSync(outDir, { recursive: true });

const htmxSrc = join(root, 'node_modules', 'htmx.org', 'dist', 'htmx.min.js');
copyFileSync(htmxSrc, join(outDir, 'htmx.min.js'));

// WebAuthn browser helper (UMD global: SimpleWebAuthnBrowser).
const webauthnSrc = join(
  root,
  'node_modules',
  '@simplewebauthn',
  'browser',
  'dist',
  'bundle',
  'index.umd.min.js',
);
copyFileSync(webauthnSrc, join(outDir, 'webauthn-browser.js'));

// Our own auth glue.
copyFileSync(join(root, 'assets', 'auth.js'), join(outDir, 'auth.js'));

console.log('copied htmx.min.js, webauthn-browser.js, auth.js -> public/assets/');
