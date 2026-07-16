/**
 * Env-driven configuration. Every setting comes from the environment (via a
 * git-ignored `.env` in development, or systemd `Environment=`/`EnvironmentFile=`
 * in production). Secrets are NEVER hardcoded — see `.env.example`.
 *
 * Integration model: the `simplex-chat` SDK (6.x) embeds the SimpleX chat core
 * in-process (native addon). There is no separate daemon and no WebSocket port —
 * the bot owns a local SimpleX DB (SQLite) and a files folder on the same host.
 */

import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { parseLogLevel, type LogLevel } from './log.js';

loadDotenv();

export interface Config {
  /** Display name for the bot's own SimpleX profile. */
  botDisplayName: string;
  /**
   * File prefix for the embedded SimpleX core DB (SQLite). The core creates
   * `<prefix>_chat.db` and `<prefix>_agent.db`. This DB holds the bot's SimpleX
   * identity and state — protect it with filesystem permissions.
   */
  simplexDbPrefix: string;
  /**
   * Absolute path to the SimpleX core's files folder — where received (XFTP)
   * files are written before Cinderella moves them into its media store.
   */
  simplexFilesFolder: string;
  /** Optional group name to scope capture. Empty string => capture all groups. */
  groupName: string;
  /** Absolute path to Cinderella's own media store. */
  mediaRoot: string;
  /** PostgreSQL connection string (the archive DB — separate from the SimpleX DB). */
  databaseUrl: string;
  /** Log verbosity. */
  logLevel: LogLevel;
}

class ConfigError extends Error {
  override name = 'ConfigError';
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  return value.trim();
}

let cached: Config | undefined;

/**
 * Loads and validates configuration. Throws ConfigError with an actionable
 * message if a required variable is missing. Result is memoized.
 */
export function loadConfig(): Config {
  if (cached) return cached;

  const cfg: Config = {
    botDisplayName: optional('BOT_DISPLAY_NAME', 'Cinderella'),
    simplexDbPrefix: resolve(optional('SIMPLEX_DB_PREFIX', './state/simplex/cinderella')),
    simplexFilesFolder: resolve(optional('SIMPLEX_FILES_FOLDER', './state/files')),
    groupName: optional('GROUP_NAME', ''),
    mediaRoot: resolve(optional('MEDIA_ROOT', './media')),
    databaseUrl: required('DATABASE_URL'),
    logLevel: parseLogLevel(process.env['LOG_LEVEL']),
  };

  cached = cfg;
  return cfg;
}

/**
 * Returns a copy of the config safe to log — the database password is redacted.
 */
export function redactConfig(cfg: Config): Record<string, string> {
  let safeDbUrl = cfg.databaseUrl;
  try {
    const url = new URL(cfg.databaseUrl);
    if (url.password) url.password = '***';
    safeDbUrl = url.toString();
  } catch {
    // Non-URL connection string; redact defensively rather than leak it.
    safeDbUrl = '[unparseable connection string — redacted]';
  }
  return {
    botDisplayName: cfg.botDisplayName,
    simplexDbPrefix: cfg.simplexDbPrefix,
    simplexFilesFolder: cfg.simplexFilesFolder,
    groupName: cfg.groupName || '(all groups)',
    mediaRoot: cfg.mediaRoot,
    databaseUrl: safeDbUrl,
    logLevel: cfg.logLevel,
  };
}
