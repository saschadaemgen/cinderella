/**
 * Configurable browser-hardening headers (A4.5). Values come from the admin
 * security settings; the defaults are strict.
 */

import type { FastifyReply } from 'fastify';
import type { SecuritySettings } from '../../security/settings.js';

export function applySecurityHeaders(reply: FastifyReply, sec: SecuritySettings): void {
  const h = sec.headers;
  reply.header('content-security-policy', h.csp);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('x-frame-options', 'DENY');
  reply.header('referrer-policy', h.referrerPolicy);
  if (h.permissionsPolicy) reply.header('permissions-policy', h.permissionsPolicy);
  reply.header('cache-control', 'no-store');
  if (h.hstsMaxAge > 0) {
    let hsts = `max-age=${h.hstsMaxAge}`;
    if (h.hstsIncludeSubdomains) hsts += '; includeSubDomains';
    if (h.hstsPreload) hsts += '; preload';
    reply.header('strict-transport-security', hsts);
  }
}
