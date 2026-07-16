/**
 * File receipt orchestration.
 *
 * SimpleX media/files are preview-only until actively downloaded: an incoming
 * image/video/file carries only metadata (and a base64 thumbnail) inline; the
 * real bytes transfer over XFTP and must be *received* per file. XFTP relays
 * expire files after ~48h, so failed/late receipts are logged and surfaced
 * (briefing §10.2).
 *
 * Flow: register a pending entry, issue the receive-file command (storing the
 * file UNENCRYPTED so Cinderella can serve it later), then resolve when the
 * matching `rcvFileComplete` event arrives. The pending entry is registered
 * BEFORE the command is sent so a fast completion event is never missed. Errors,
 * a rejecting command response, and timeouts reject.
 */

import { isAbsolute, join } from 'node:path';
import { CC } from '@simplex-chat/types';
import type { CEvt } from '@simplex-chat/types';
import type { api } from 'simplex-chat';
import { log } from '../log.js';
import type { CapturedFile } from '../capture/message.js';

/** The embedded chat controller instance returned by the SDK. */
type Chat = api.ChatApi;

export interface ReceivedFile {
  fileId: number;
  /** Absolute (or files-folder-relative) path the core wrote the file to. */
  path: string;
  size: number;
  fileName: string;
}

interface Waiter {
  resolve: (r: ReceivedFile) => void;
  reject: (e: Error) => void;
}

interface Pending {
  fileName: string;
  timer: NodeJS.Timeout | undefined;
  waiters: Waiter[];
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolves a core-reported file path against the files folder if it is relative. */
export function resolveFilePath(filePath: string, filesFolder: string): string {
  return isAbsolute(filePath) ? filePath : join(filesFolder, filePath);
}

export class FileReceiver {
  private readonly pending = new Map<number, Pending>();

  constructor(
    private readonly chat: Chat,
    private readonly filesFolder: string,
    /** Timeout provider — read per receive so live setting changes apply. */
    private readonly getTimeoutMs: () => number = () => DEFAULT_TIMEOUT_MS,
  ) {}

  /**
   * Issues the receive-file command and resolves once the file finishes
   * downloading. `storeEncrypted: false` keeps the on-disk file readable so it
   * can be moved into the media store and later served.
   */
  async receive(file: CapturedFile): Promise<ReceivedFile> {
    const { fileId, fileName } = file;

    // Already receiving this file — attach to the in-flight receipt.
    const existing = this.pending.get(fileId);
    if (existing) {
      return new Promise<ReceivedFile>((resolve, reject) => {
        existing.waiters.push({ resolve, reject });
      });
    }

    // Register BEFORE sending, so a completion event that arrives during the
    // await below is not lost.
    const entry: Pending = { fileName, timer: undefined, waiters: [] };
    this.pending.set(fileId, entry);
    const result = new Promise<ReceivedFile>((resolve, reject) => {
      entry.waiters.push({ resolve, reject });
    });
    entry.timer = setTimeout(() => {
      this.reject(
        fileId,
        new Error(
          `file receive timed out after ${this.getTimeoutMs()}ms (${fileName}, id=${fileId})`,
        ),
      );
    }, this.getTimeoutMs());
    if (typeof entry.timer.unref === 'function') entry.timer.unref();

    try {
      const r = await this.chat.sendChatCmd(
        CC.ReceiveFile.cmdString({ fileId, userApprovedRelays: true, storeEncrypted: false }),
      );
      if (r.type === 'chatCmdError') {
        this.reject(
          fileId,
          new Error(`receive-file command rejected for ${fileName} (id=${fileId})`),
        );
      } else if (r.type === 'rcvFileAcceptedSndCancelled') {
        this.reject(fileId, new Error(`sender cancelled file ${fileName} (id=${fileId})`));
      }
      // rcvFileAccepted => wait for the rcvFileComplete event.
    } catch (err) {
      this.reject(fileId, err instanceof Error ? err : new Error(String(err)));
    }

    return result;
  }

  private settleResolve(fileId: number, value: ReceivedFile): void {
    const entry = this.pending.get(fileId);
    if (!entry) return;
    this.pending.delete(fileId);
    if (entry.timer) clearTimeout(entry.timer);
    for (const w of entry.waiters) w.resolve(value);
  }

  private reject(fileId: number, error: Error): void {
    const entry = this.pending.get(fileId);
    if (!entry) return;
    this.pending.delete(fileId);
    if (entry.timer) clearTimeout(entry.timer);
    for (const w of entry.waiters) w.reject(error);
  }

  /** Wire to the `rcvFileComplete` event. */
  handleComplete(ev: CEvt.RcvFileComplete): void {
    const file = ev.chatItem.chatItem.file;
    if (!file) return;
    if (!this.pending.has(file.fileId)) return;
    const rawPath = file.fileSource?.filePath;
    if (!rawPath) {
      this.reject(
        file.fileId,
        new Error(`rcvFileComplete without a file path (${file.fileName}, id=${file.fileId})`),
      );
      return;
    }
    this.settleResolve(file.fileId, {
      fileId: file.fileId,
      path: resolveFilePath(rawPath, this.filesFolder),
      size: file.fileSize,
      fileName: file.fileName,
    });
  }

  /** Wire to `rcvFileError` (a terminal failure). */
  handleError(ev: CEvt.RcvFileError): void {
    const { fileId } = ev.rcvFileTransfer;
    const entry = this.pending.get(fileId);
    if (!entry) return;
    this.reject(
      fileId,
      new Error(`file receive failed (${entry.fileName}, id=${fileId}): ${ev.agentError.type}`),
    );
  }

  /** Wire to `rcvFileWarning` — a TRANSIENT XFTP warning; the transfer continues. */
  handleWarning(ev: CEvt.RcvFileWarning): void {
    const { fileId } = ev.rcvFileTransfer;
    const entry = this.pending.get(fileId);
    if (!entry) return;
    log.warn(
      `Transient file-receive warning (${entry.fileName}, id=${fileId}): ${ev.agentError.type} — still trying.`,
    );
  }

  /** Rejects all in-flight receipts (used on shutdown so failures are recorded). */
  abortAll(reason: string): void {
    for (const fileId of [...this.pending.keys()]) {
      this.reject(fileId, new Error(reason));
    }
  }

  /** Number of in-flight receipts (for diagnostics). */
  get inFlight(): number {
    return this.pending.size;
  }
}
