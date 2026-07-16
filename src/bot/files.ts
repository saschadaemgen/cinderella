/**
 * File receipt orchestration.
 *
 * SimpleX media/files are preview-only until actively downloaded: an incoming
 * image/video/file carries only metadata (and a base64 thumbnail) inline; the
 * real bytes transfer over XFTP and must be *received* per file. XFTP relays
 * expire files after ~48h, so failed/late receipts are logged and surfaced
 * (briefing §10.2).
 *
 * Flow: on a message with a file we issue the receive-file command (storing the
 * file UNENCRYPTED so Cinderella can serve it later), then resolve when the
 * matching `rcvFileComplete` event arrives. Errors and timeouts reject.
 */

import { isAbsolute, join } from 'node:path';
import { CC } from '@simplex-chat/types';
import type { CEvt } from '@simplex-chat/types';
import type { api } from 'simplex-chat';
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

interface Pending {
  fileName: string;
  resolve: (r: ReceivedFile) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Resolves a core-reported file path against the files folder if it is relative. */
export function resolveFilePath(filePath: string, filesFolder: string): string {
  return isAbsolute(filePath) ? filePath : join(filesFolder, filePath);
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

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
    if (this.pending.has(fileId)) {
      // Already receiving — reuse the in-flight promise rather than double-accept.
      return new Promise<ReceivedFile>((resolve, reject) => {
        const existing = this.pending.get(fileId);
        if (!existing) {
          reject(new Error(`file receipt state lost (fileId=${fileId})`));
          return;
        }
        // Chain onto the existing pending entry.
        const priorResolve = existing.resolve;
        const priorReject = existing.reject;
        existing.resolve = (r) => {
          priorResolve(r);
          resolve(r);
        };
        existing.reject = (e) => {
          priorReject(e);
          reject(e);
        };
      });
    }

    await this.chat.sendChatCmd(
      CC.ReceiveFile.cmdString({ fileId, userApprovedRelays: true, storeEncrypted: false }),
    );

    const timeoutMs = this.getTimeoutMs();
    return new Promise<ReceivedFile>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(fileId);
        reject(
          new Error(`file receive timed out after ${timeoutMs}ms (${fileName}, id=${fileId})`),
        );
      }, timeoutMs);
      // Do not keep the process alive solely for this timer.
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(fileId, { fileName, resolve, reject, timer });
    });
  }

  /** Wire to the `rcvFileComplete` event. */
  handleComplete(ev: CEvt.RcvFileComplete): void {
    const file = ev.chatItem.chatItem.file;
    if (!file) return;
    const p = this.pending.get(file.fileId);
    if (!p) return;
    this.pending.delete(file.fileId);
    clearTimeout(p.timer);

    const rawPath = file.fileSource?.filePath;
    if (!rawPath) {
      p.reject(new Error(`rcvFileComplete without a file path (${p.fileName}, id=${file.fileId})`));
      return;
    }
    p.resolve({
      fileId: file.fileId,
      path: resolveFilePath(rawPath, this.filesFolder),
      size: file.fileSize,
      fileName: file.fileName,
    });
  }

  /** Wire to `rcvFileError` and `rcvFileWarning`. */
  handleError(ev: CEvt.RcvFileError | CEvt.RcvFileWarning): void {
    const { fileId } = ev.rcvFileTransfer;
    const p = this.pending.get(fileId);
    if (!p) return;
    this.pending.delete(fileId);
    clearTimeout(p.timer);
    p.reject(new Error(`file receive failed (${p.fileName}, id=${fileId}): ${ev.agentError.type}`));
  }

  /** Number of in-flight receipts (for diagnostics). */
  get inFlight(): number {
    return this.pending.size;
  }
}
