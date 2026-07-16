/**
 * Cinderella entrypoint.
 *
 * Cinderella is the tireless worker: first into the group, never resting,
 * capturing everything opted-in members contribute so it can later be
 * republished as a consent-gated public archive.
 *
 * Stage 0: boot, read & validate config, report it (redacted), exit 0.
 * Later stages replace this with the long-lived capture loop.
 */

import { loadConfig, redactConfig } from './config.js';
import { log, setLogLevel } from './log.js';

function main(): void {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  log.info('Cinderella booting…');
  log.info('Configuration loaded:', redactConfig(cfg));
  log.info('Stage 0 scaffold OK — config valid. Exiting 0.');
}

try {
  main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error(`Startup failed: ${message}`);
  process.exit(1);
}
