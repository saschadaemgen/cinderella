/**
 * Live-editable settings service (A3 "Configuration").
 *
 * Settings live in the `settings` table and are cached in-process. Writing a
 * setting persists it AND applies its side effect immediately (e.g. log level),
 * so edits take effect without a restart. Boot/secret settings (DB connection,
 * admin credentials, session secret, SimpleX paths) are environment-only and
 * never pass through here.
 */

import { getAllSettings, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { log, parseLogLevel, setLogLevel, type LogLevel } from '../log.js';

export interface LiveSettings {
  /** Log verbosity — applied immediately. */
  logLevel: LogLevel;
  /** Per-file receive timeout in minutes — applied to subsequent receipts. */
  fileTimeoutMinutes: number;
  /** Dashboard: a pending file older than this (hours) counts as "at risk". */
  fileAlertHours: number;
}

export const SETTING_DEFS: {
  key: keyof LiveSettings;
  label: string;
  help: string;
}[] = [
  {
    key: 'logLevel',
    label: 'Log level',
    help: 'Verbosity of the bot + admin logs (applies immediately).',
  },
  {
    key: 'fileTimeoutMinutes',
    label: 'File receive timeout (minutes)',
    help: 'How long to wait for an XFTP file download before treating it as failed.',
  },
  {
    key: 'fileAlertHours',
    label: 'File alert threshold (hours)',
    help: 'Dashboard flags media still missing after this long (XFTP relays expire files after ~48h).',
  },
];

function defaults(envLogLevel: LogLevel): LiveSettings {
  return {
    logLevel: envLogLevel,
    fileTimeoutMinutes: 5,
    fileAlertHours: 24,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export class SettingsService {
  private values: LiveSettings;

  private constructor(
    private readonly db: Queryable,
    envLogLevel: LogLevel,
  ) {
    this.values = defaults(envLogLevel);
  }

  /** Loads persisted settings and applies side effects. */
  static async load(db: Queryable, envLogLevel: LogLevel): Promise<SettingsService> {
    const svc = new SettingsService(db, envLogLevel);
    const stored = await getAllSettings(db);
    const storedLogLevel = stored.get('logLevel');
    svc.values = {
      logLevel: parseLogLevel(
        typeof storedLogLevel === 'string' ? storedLogLevel : undefined,
        svc.values.logLevel,
      ),
      fileTimeoutMinutes: clampInt(
        stored.get('fileTimeoutMinutes'),
        1,
        720,
        svc.values.fileTimeoutMinutes,
      ),
      fileAlertHours: clampInt(stored.get('fileAlertHours'), 1, 168, svc.values.fileAlertHours),
    };
    svc.applySideEffects();
    return svc;
  }

  get(): LiveSettings {
    return { ...this.values };
  }

  get fileTimeoutMs(): number {
    return this.values.fileTimeoutMinutes * 60 * 1000;
  }

  /**
   * Validates, persists, applies, and returns the new value of one setting.
   * Throws on unknown keys or invalid values.
   */
  async set(key: string, rawValue: string): Promise<LiveSettings[keyof LiveSettings]> {
    switch (key) {
      case 'logLevel': {
        const v = rawValue.trim().toLowerCase();
        if (v !== 'error' && v !== 'warn' && v !== 'info' && v !== 'debug') {
          throw new Error('Log level must be one of: error, warn, info, debug.');
        }
        this.values.logLevel = v;
        await setSetting(this.db, 'logLevel', v);
        this.applySideEffects();
        return v;
      }
      case 'fileTimeoutMinutes': {
        const n = clampInt(rawValue, 1, 720, NaN);
        if (!Number.isFinite(n))
          throw new Error('File timeout must be a number of minutes (1–720).');
        this.values.fileTimeoutMinutes = n;
        await setSetting(this.db, 'fileTimeoutMinutes', n);
        return n;
      }
      case 'fileAlertHours': {
        const n = clampInt(rawValue, 1, 168, NaN);
        if (!Number.isFinite(n)) throw new Error('File alert threshold must be hours (1–168).');
        this.values.fileAlertHours = n;
        await setSetting(this.db, 'fileAlertHours', n);
        return n;
      }
      default:
        throw new Error(`Unknown setting: ${key}`);
    }
  }

  private applySideEffects(): void {
    setLogLevel(this.values.logLevel);
    log.debug(`Live settings applied: ${JSON.stringify(this.values)}`);
  }
}
