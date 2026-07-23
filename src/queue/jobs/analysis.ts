/**
 * Placeholder content-analysis job (CCB-S3-022 §7).
 *
 * This does NOT analyse anything. It exists so the enqueue-on-capture and
 * enqueue-on-publication path is wired and proven end to end, and so the future AI
 * briefing has a job type to attach a real handler to without touching the capture
 * pipeline again. Today it records that no analysis provider is configured and
 * succeeds. It is idempotent by construction: it writes nothing and has no effect,
 * so a repeat run is identical.
 *
 * The analysis INTERFACE is deliberately not defined here; that belongs with the AI
 * briefing, once we know what the model actually returns.
 */

import { log } from '../../log.js';
import type { JobHandler } from '../types.js';

/** The stable job type. Capture/publication enqueue this; the AI briefing swaps the handler. */
export const CONTENT_ANALYSIS_JOB = 'content.analyze';

/** Idempotency key for analysing one archive message. */
export function contentAnalysisKey(messageId: number): string {
  return `content.analyze:${messageId}`;
}

export const contentAnalysisHandler: JobHandler = (payload) => {
  const messageId = typeof payload['messageId'] === 'number' ? payload['messageId'] : null;
  log.debug(
    `Queue: content analysis requested for message ${messageId ?? '(unknown)'}: ` +
      'no analysis provider configured, nothing to do.',
  );
  return Promise.resolve();
};
