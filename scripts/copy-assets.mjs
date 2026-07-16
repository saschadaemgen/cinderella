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
console.log('copied htmx.min.js -> public/assets/');
