/**
 * Job handler registry (CCB-S3-022). A handler is registered once per type at
 * startup; the worker looks it up by the job's `type`. Kept separate from the
 * worker so tests can register fakes, and so a job type with no handler is a
 * clear, catchable condition rather than a silent no-op.
 */

import type { JobHandler } from './types.js';

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(type: string, handler: JobHandler): void {
  if (handlers.has(type)) throw new Error(`duplicate job handler for type "${type}"`);
  handlers.set(type, handler);
}

export function getJobHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export function registeredJobTypes(): string[] {
  return [...handlers.keys()];
}

/** Test hook. */
export function clearJobHandlers(): void {
  handlers.clear();
}
