/**
 * Moves a received file out of the SimpleX files folder and into Cinderella's
 * own media store, returning the path to record in the DB.
 *
 * The DB stores a path *relative* to MEDIA_ROOT (posix-style) so the archive is
 * relocatable and the future web front can map it to a URL. The bytes are never
 * stored in the DB.
 */

import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { ReceivedFile } from '../bot/files.js';
import type { CapturedMessage } from './message.js';

export interface StoredMedia {
  /** Path relative to MEDIA_ROOT, using forward slashes. */
  mediaPath: string;
  mediaMime: string;
  mediaSize: number;
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.json': 'application/json',
};

export function mimeForFileName(fileName: string): string {
  return MIME_BY_EXT[extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/** Strips directory separators and unsafe characters from a file name. */
function sanitizeFileName(fileName: string): string {
  const base = fileName.replace(/[/\\]/g, '_');
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^[._]+/, '').slice(0, 120);
  return trimmed.length > 0 ? trimmed : 'file';
}

/** `YYYY/MM` bucket from the message timestamp (UTC), falling back to unknown. */
function dateBucket(sentAt: string): string {
  const d = new Date(sentAt);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const year = String(d.getUTCFullYear()).padStart(4, '0');
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${year}/${month}`;
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    // Cross-device (files folder and media store on different mounts): copy+unlink.
    if (err instanceof Error && 'code' in err && err.code === 'EXDEV') {
      await copyFile(from, to);
      await unlink(from);
      return;
    }
    throw err;
  }
}

/**
 * Moves `received` into MEDIA_ROOT under a `YYYY/MM/<fileId>-<name>` path and
 * returns the relative path, mime, and on-disk size.
 */
export async function storeMedia(
  received: ReceivedFile,
  msg: CapturedMessage,
  mediaRoot: string,
): Promise<StoredMedia> {
  const bucket = dateBucket(msg.sentAt);
  const fileName = `${received.fileId}-${sanitizeFileName(received.fileName)}`;
  const relDir = bucket;
  const relPath = `${relDir}/${fileName}`;

  const absDir = join(mediaRoot, relDir);
  const absPath = join(mediaRoot, relDir, fileName);

  await mkdir(absDir, { recursive: true });
  await moveFile(received.path, absPath);

  const info = await stat(absPath);
  return {
    mediaPath: relPath,
    mediaMime: mimeForFileName(received.fileName),
    mediaSize: info.size,
  };
}
