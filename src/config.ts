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

/**
 * Admin console settings. Required only when the admin web server starts —
 * loaded separately so the capture-only paths (`--check`, `connect`) don't
 * demand them.
 */
export interface AdminConfig {
  /** Port the admin server listens on. Bound to 127.0.0.1 ONLY — nginx proxies. */
  adminPort: number;
  /** Operator account name. */
  adminUsername: string;
  /** Argon2id hash of the operator password (generate: npm run hash-password). */
  adminPasswordHash: string;
  /** Secret for signing session cookies (>= 32 chars, random). */
  sessionSecret: string;
  /** Public origin of the admin/embed host, used by the embed snippet generator. */
  publicOrigin: string;
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

let cachedAdmin: AdminConfig | undefined;

/**
 * Loads and validates the admin console configuration. Throws ConfigError with
 * an actionable message when something is missing or unsafe.
 */
export function loadAdminConfig(): AdminConfig {
  if (cachedAdmin) return cachedAdmin;

  const portRaw = optional('ADMIN_PORT', '8787');
  const adminPort = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
    throw new ConfigError(`ADMIN_PORT must be a valid port number (got "${portRaw}").`);
  }

  const adminPasswordHash = required('ADMIN_PASSWORD_HASH');
  if (!adminPasswordHash.startsWith('$argon2id$')) {
    throw new ConfigError(
      'ADMIN_PASSWORD_HASH must be an Argon2id hash. Generate one with: npm run hash-password',
    );
  }

  const sessionSecret = required('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    throw new ConfigError(
      'SESSION_SECRET must be at least 32 characters of random data (e.g. openssl rand -hex 32).',
    );
  }

  const cfg: AdminConfig = {
    adminPort,
    adminUsername: required('ADMIN_USERNAME'),
    adminPasswordHash,
    sessionSecret,
    publicOrigin: optional('PUBLIC_ORIGIN', 'https://cinderella.example.org'),
  };
  cachedAdmin = cfg;
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
    // Also scrub credential-bearing query parameters — some drivers accept the
    // password (and other secrets) as ?password=… rather than in the userinfo.
    for (const key of ['password', 'pgpassword', 'sslpassword', 'sslcert', 'sslkey']) {
      for (const actual of [...url.searchParams.keys()]) {
        if (actual.toLowerCase() === key) url.searchParams.set(actual, '***');
      }
    }
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
