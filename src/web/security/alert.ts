/**
 * Optional security-event alerting hook (A4.5). Posts a compact JSON payload to
 * a configured HTTPS webhook. Off when no webhook URL is set. Best-effort:
 * failures are swallowed (they must never break the auth path).
 */

import type { SecuritySettings } from '../../security/settings.js';
import { log } from '../../log.js';

export async function alertSecurityEvent(
  sec: SecuritySettings,
  event: string,
  details: Record<string, unknown>,
): Promise<void> {
  const url = sec.alerting.webhookUrl;
  if (!url) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'cinderella-admin',
        event,
        at: new Date().toISOString(),
        details,
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    log.warn(`Security alert webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
