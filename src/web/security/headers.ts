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
  // The admin console is never indexable — set it at the HTTP layer too (the shell
  // also carries a `<meta name="robots">`). CCB-S2-012 made the app authoritative for
  // robots policy so the public site (which skips these headers) can be indexable
  // without nginx blanket-noindexing the whole host.
  reply.header('x-robots-tag', 'noindex, nofollow');
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
