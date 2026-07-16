/**
 * Runtime status shared between the capture worker and the admin dashboard.
 * In-memory (per-process) — DB-derived numbers are queried live by the
 * dashboard; this covers what only the running process knows.
 */

export interface RecentError {
  at: string;
  message: string;
}

export interface FileFailure {
  at: string;
  itemId: number;
  groupId: number;
  fileName: string;
  reason: string;
}

export interface RuntimeStatus {
  startedAt: string;
  botState: 'starting' | 'running' | 'failed' | 'disabled';
  botError: string | null;
  groups: string[];
  lastCapturedAt: string | null;
  /** In-flight + recently failed file receipts (XFTP ~48h expiry — A3). */
  fileFailures: FileFailure[];
  recentErrors: RecentError[];
}

const MAX_RECENT = 50;

class StatusTracker implements RuntimeStatus {
  startedAt = new Date().toISOString();
  botState: RuntimeStatus['botState'] = 'starting';
  botError: string | null = null;
  groups: string[] = [];
  lastCapturedAt: string | null = null;
  fileFailures: FileFailure[] = [];
  recentErrors: RecentError[] = [];

  botRunning(groups: string[]): void {
    this.botState = 'running';
    this.botError = null;
    this.groups = groups;
  }

  botFailed(message: string): void {
    this.botState = 'failed';
    this.botError = message;
  }

  captured(): void {
    this.lastCapturedAt = new Date().toISOString();
  }

  fileFailed(failure: Omit<FileFailure, 'at'>): void {
    this.fileFailures.unshift({ at: new Date().toISOString(), ...failure });
    if (this.fileFailures.length > MAX_RECENT) this.fileFailures.length = MAX_RECENT;
  }

  error(message: string): void {
    this.recentErrors.unshift({ at: new Date().toISOString(), message });
    if (this.recentErrors.length > MAX_RECENT) this.recentErrors.length = MAX_RECENT;
  }
}

export const status = new StatusTracker();
