/**
 * Security settings model (Addendum 4 / A4.5).
 *
 * Every A4.5 control lives here as a real, validated value persisted in the
 * `settings` table under the `security` key. The admin console edits these; each
 * change is audited. Secrets (SESSION_SECRET, DB creds, TOTP secret bytes) are
 * NEVER stored here and never rendered.
 *
 * All values are normalized from untrusted input — unknown/invalid inputs fall
 * back to secure defaults.
 */

import { getSetting, setSetting } from '../db/settings.js';
import type { Queryable } from '../db/pool.js';
import { writeAudit } from '../db/audit.js';

export type UserVerification = 'required' | 'preferred';
export type ResidentKey = 'required' | 'preferred';
export type Attestation = 'none' | 'indirect' | 'direct';
export type IpMode = 'off' | 'allow' | 'deny';
export type ConcurrentPolicy = 'multiple' | 'single';

export interface SecuritySettings {
  passkey: {
    userVerification: UserVerification;
    residentKey: ResidentKey;
    attestation: Attestation;
    /** Allowlisted authenticator AAGUIDs; empty = any model allowed. */
    allowedAaguids: string[];
  };
  breakGlass: {
    /** Password (Argon2id) recovery path on/off. */
    enabled: boolean;
    /** Require a TOTP second factor on the password path. */
    totpRequired: boolean;
  };
  session: {
    idleTimeoutMinutes: number;
    absoluteMaxHours: number;
    /** Re-verify a passkey before sensitive actions (takedown/config). */
    stepUpForSensitive: boolean;
    /** 'single' logs out other sessions on new login. */
    concurrent: ConcurrentPolicy;
  };
  rateLimit: {
    loginMaxAttempts: number;
    loginWindowMinutes: number;
    lockoutMinutes: number;
    /** Global requests/minute/client; 0 = disabled. */
    globalPerMinute: number;
  };
  ipAccess: {
    mode: IpMode;
    /** IPv4/IPv6 addresses or CIDRs. */
    list: string[];
  };
  headers: {
    csp: string;
    hstsMaxAge: number;
    hstsIncludeSubdomains: boolean;
    hstsPreload: boolean;
    referrerPolicy: string;
    permissionsPolicy: string;
  };
  argon2: {
    memoryCostKiB: number;
    timeCost: number;
    parallelism: number;
  };
  alerting: {
    /** Webhook URL for security events; empty = off. */
    webhookUrl: string;
  };
}

/** The strict, secure default CSP (matches the app's baseline). */
export const DEFAULT_CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";

export const DEFAULT_SECURITY: SecuritySettings = {
  passkey: {
    userVerification: 'required',
    residentKey: 'required',
    attestation: 'none',
    allowedAaguids: [],
  },
  // Enabled by default ONLY so the operator can bootstrap (log in, register
  // passkeys on >=2 devices), then disable. The admin refuses to disable it
  // while zero passkeys are registered.
  breakGlass: { enabled: true, totpRequired: false },
  session: {
    idleTimeoutMinutes: 720, // 12h
    absoluteMaxHours: 24,
    stepUpForSensitive: false,
    concurrent: 'multiple',
  },
  rateLimit: {
    loginMaxAttempts: 5,
    loginWindowMinutes: 15,
    lockoutMinutes: 15,
    globalPerMinute: 0,
  },
  ipAccess: { mode: 'off', list: [] },
  headers: {
    csp: DEFAULT_CSP,
    hstsMaxAge: 63072000, // 2 years
    hstsIncludeSubdomains: true,
    hstsPreload: false,
    referrerPolicy: 'no-referrer',
    permissionsPolicy: 'geolocation=(), microphone=(), camera=()',
  },
  argon2: { memoryCostKiB: 65536, timeCost: 3, parallelism: 4 },
  alerting: { webhookUrl: '' },
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function bool(v: unknown, d: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 'on' || v === 'true') return true;
  if (v === 'off' || v === 'false' || v === undefined) return v === undefined ? d : false;
  return d;
}
function int(v: unknown, min: number, max: number, d: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}
function str(v: unknown, d: string, maxLen = 4000): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : d;
}

const AAGUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// IPv4/IPv6 address or CIDR (loose but safe — used only for allow/deny matching).
const IP_CIDR_RE = /^[0-9a-fA-F:.]+(\/\d{1,3})?$/;

function strList(v: unknown, re: RegExp, maxItems = 200): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\s,]+/) : [];
  const out: string[] = [];
  for (const item of arr) {
    const s = String(item).trim().toLowerCase();
    if (s && re.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeSecurity(input: unknown): SecuritySettings {
  const d = DEFAULT_SECURITY;
  const o = rec(input);
  const passkey = rec(o['passkey']);
  const breakGlass = rec(o['breakGlass']);
  const session = rec(o['session']);
  const rl = rec(o['rateLimit']);
  const ip = rec(o['ipAccess']);
  const h = rec(o['headers']);
  const a2 = rec(o['argon2']);
  const alert = rec(o['alerting']);

  const webhook = str(alert['webhookUrl'], d.alerting.webhookUrl, 500).trim();
  const safeWebhook = /^https:\/\/\S+$/.test(webhook) ? webhook : '';

  return {
    passkey: {
      userVerification: pick(
        passkey['userVerification'],
        ['required', 'preferred'],
        d.passkey.userVerification,
      ),
      residentKey: pick(passkey['residentKey'], ['required', 'preferred'], d.passkey.residentKey),
      attestation: pick(
        passkey['attestation'],
        ['none', 'indirect', 'direct'],
        d.passkey.attestation,
      ),
      allowedAaguids: strList(passkey['allowedAaguids'], AAGUID_RE, 50),
    },
    breakGlass: {
      enabled: bool(breakGlass['enabled'], d.breakGlass.enabled),
      totpRequired: bool(breakGlass['totpRequired'], d.breakGlass.totpRequired),
    },
    session: {
      idleTimeoutMinutes: int(
        session['idleTimeoutMinutes'],
        5,
        43200,
        d.session.idleTimeoutMinutes,
      ),
      absoluteMaxHours: int(session['absoluteMaxHours'], 1, 720, d.session.absoluteMaxHours),
      stepUpForSensitive: bool(session['stepUpForSensitive'], d.session.stepUpForSensitive),
      concurrent: pick(session['concurrent'], ['multiple', 'single'], d.session.concurrent),
    },
    rateLimit: {
      loginMaxAttempts: int(rl['loginMaxAttempts'], 1, 100, d.rateLimit.loginMaxAttempts),
      loginWindowMinutes: int(rl['loginWindowMinutes'], 1, 1440, d.rateLimit.loginWindowMinutes),
      lockoutMinutes: int(rl['lockoutMinutes'], 1, 1440, d.rateLimit.lockoutMinutes),
      globalPerMinute: int(rl['globalPerMinute'], 0, 100000, d.rateLimit.globalPerMinute),
    },
    ipAccess: {
      mode: pick(ip['mode'], ['off', 'allow', 'deny'], d.ipAccess.mode),
      list: strList(ip['list'], IP_CIDR_RE, 200),
    },
    headers: {
      csp: str(h['csp'], d.headers.csp, 4000).trim() || d.headers.csp,
      hstsMaxAge: int(h['hstsMaxAge'], 0, 63072000, d.headers.hstsMaxAge),
      hstsIncludeSubdomains: bool(h['hstsIncludeSubdomains'], d.headers.hstsIncludeSubdomains),
      hstsPreload: bool(h['hstsPreload'], d.headers.hstsPreload),
      referrerPolicy: str(h['referrerPolicy'], d.headers.referrerPolicy, 100),
      permissionsPolicy: str(h['permissionsPolicy'], d.headers.permissionsPolicy, 500),
    },
    argon2: {
      memoryCostKiB: int(a2['memoryCostKiB'], 8192, 1048576, d.argon2.memoryCostKiB),
      timeCost: int(a2['timeCost'], 1, 20, d.argon2.timeCost),
      parallelism: int(a2['parallelism'], 1, 16, d.argon2.parallelism),
    },
    alerting: { webhookUrl: safeWebhook },
  };
}

const SECURITY_KEY = 'security';

/** In-process cache of the security settings, refreshed on write. */
export class SecurityService {
  private constructor(
    private readonly db: Queryable,
    private current: SecuritySettings,
  ) {}

  static async load(db: Queryable): Promise<SecurityService> {
    const stored = await getSetting(db, SECURITY_KEY);
    return new SecurityService(db, normalizeSecurity(stored ?? {}));
  }

  get(): SecuritySettings {
    return this.current;
  }

  /**
   * Persists a full normalized settings object and audits the change. The caller
   * (the admin route) is responsible for merging edited fields and for refusing
   * unsafe transitions (e.g. disabling break-glass with no passkeys).
   */
  async save(next: SecuritySettings, actor: string): Promise<void> {
    const normalized = normalizeSecurity(next);
    await setSetting(this.db, SECURITY_KEY, normalized);
    await writeAudit(this.db, actor, 'security.update', 'security', normalized);
    this.current = normalized;
  }
}
