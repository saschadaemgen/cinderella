/**
 * Optional IP allowlist / denylist for the admin routes (A4.5). Off by default —
 * unsuitable for the operator's dynamic CGNAT address, so it is opt-in.
 *
 * Supports IPv4 (with CIDR) and IPv6 (exact match, or prefix via CIDR on the
 * expanded address). Malformed rules never match.
 */

import type { IpMode } from '../../security/settings.js';

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n << 8) | o;
  }
  return n >>> 0;
}

/** Expand an IPv6 address to 32 hex chars (no colons). Null if invalid. */
function ipv6ToHex(ip: string): string | null {
  let addr = ip;
  // Strip zone id.
  const pct = addr.indexOf('%');
  if (pct >= 0) addr = addr.slice(0, pct);
  if (!addr.includes(':')) return null;
  const dbl = addr.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  const missing = 8 - (head.length + tail.length);
  if (dbl.length === 1 && head.length !== 8) return null;
  if (dbl.length === 2 && missing < 0) return null;
  const fill = Array.from<string>({ length: dbl.length === 2 ? missing : 0 }).fill('0');
  const groups = [...head, ...fill, ...tail];
  if (groups.length !== 8) return null;
  let hex = '';
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    hex += g.padStart(4, '0');
  }
  return hex.toLowerCase();
}

function matchIpv4(client: number, rule: string): boolean {
  const [base, bitsRaw] = rule.split('/');
  const baseInt = ipv4ToInt(base ?? '');
  if (baseInt === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
  return (client & mask) === (baseInt & mask);
}

function matchIpv6(clientHex: string, rule: string): boolean {
  const [base, bitsRaw] = rule.split('/');
  const baseHex = ipv6ToHex(base ?? '');
  if (baseHex === null) return false;
  const bits = bitsRaw === undefined ? 128 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const nibbles = Math.floor(bits / 4);
  if (clientHex.slice(0, nibbles) !== baseHex.slice(0, nibbles)) return false;
  if (bits % 4 === 0) return true;
  const cN = parseInt(clientHex[nibbles] ?? '0', 16);
  const bN = parseInt(baseHex[nibbles] ?? '0', 16);
  const shift = 4 - (bits % 4);
  return cN >> shift === bN >> shift;
}

/** True if the client IP matches any rule in the list. */
export function ipMatchesAny(clientIp: string, rules: readonly string[]): boolean {
  const v4 = ipv4ToInt(clientIp);
  const v6 = v4 === null ? ipv6ToHex(clientIp) : null;
  for (const rule of rules) {
    if (v4 !== null && matchIpv4(v4, rule)) return true;
    if (v6 !== null && matchIpv6(v6, rule)) return true;
  }
  return false;
}

/** Enforces the configured IP access policy. Returns true if the client is allowed. */
export function ipAllowed(clientIp: string, mode: IpMode, list: readonly string[]): boolean {
  if (mode === 'off' || list.length === 0) return true;
  const matches = ipMatchesAny(clientIp, list);
  return mode === 'allow' ? matches : !matches;
}
