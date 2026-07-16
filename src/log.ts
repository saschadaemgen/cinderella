/**
 * Minimal leveled logger. No external dependency — Cinderella logs to stdout/stderr
 * and systemd/journald captures it on the VPS.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

function isLogLevel(value: string): value is LogLevel {
  return value === 'error' || value === 'warn' || value === 'info' || value === 'debug';
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value && isLogLevel(value)) return value;
  return fallback;
}

let activeLevel: LogLevel = parseLogLevel(process.env['LOG_LEVEL']);

export function setLogLevel(level: LogLevel): void {
  activeLevel = level;
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] > LEVEL_ORDER[activeLevel]) return;
  const ts = new Date().toISOString();
  const prefix = `${ts} [${level.toUpperCase()}]`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  if (meta === undefined) {
    stream(`${prefix} ${message}`);
  } else {
    stream(`${prefix} ${message}`, meta);
  }
}

export const log = {
  error: (message: string, meta?: unknown): void => emit('error', message, meta),
  warn: (message: string, meta?: unknown): void => emit('warn', message, meta),
  info: (message: string, meta?: unknown): void => emit('info', message, meta),
  debug: (message: string, meta?: unknown): void => emit('debug', message, meta),
};
