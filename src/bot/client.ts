/**
 * Boots the embedded SimpleX chat core and returns a handle the rest of
 * Cinderella uses. There is no external daemon — `bot.run` loads the native
 * chat core in-process, opens the local SimpleX DB, and starts the event loop.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bot } from 'simplex-chat';
import type { api } from 'simplex-chat';
import type { T } from '@simplex-chat/types';
import type { Config } from '../config.js';
import { log } from '../log.js';
import { FileReceiver } from './files.js';
import { loadAvatarDataUri } from './avatar.js';

type Chat = api.ChatApi;

export interface BotHandle {
  chat: Chat;
  user: T.User;
  fileReceiver: FileReceiver;
  close: () => Promise<void>;
}

/**
 * Creates the directories the core and media store need, and pins the process
 * temp dir to the files-folder filesystem.
 *
 * XFTP downloads are staged + decrypted in a temp dir, then `rename()`d into the
 * files folder. If temp is on a different device (the default OS temp is `/tmp`,
 * a tmpfs — and the systemd unit's PrivateTmp isolates it further) that rename
 * fails with EXDEV ("Invalid cross-device link") and the file never lands, so
 * every receive stalls. Putting temp on the same filesystem as the files folder
 * makes the move a cheap same-device rename.
 */
async function ensureDirs(cfg: Config): Promise<void> {
  await mkdir(dirname(cfg.simplexDbPrefix), { recursive: true });
  await mkdir(cfg.simplexFilesFolder, { recursive: true });
  await mkdir(cfg.mediaRoot, { recursive: true });
  const tmpDir = join(dirname(cfg.simplexFilesFolder), 'xftp-tmp');
  await mkdir(tmpDir, { recursive: true });
  // The Haskell core reads TMPDIR at each temp operation; set it before startup.
  process.env['TMPDIR'] = tmpDir;
}

/**
 * Tells the core where to write received files. Without this the core has no
 * deterministic place to put XFTP downloads. Sent as a raw core command since
 * the SDK does not wrap it.
 */
async function configureFilesFolder(chat: Chat, filesFolder: string): Promise<void> {
  const r = await chat.sendChatCmd(`/_files_folder ${filesFolder}`);
  if (r.type === 'cmdOk') {
    log.info(`SimpleX files folder set to ${filesFolder}`);
  } else {
    log.warn(
      `Unexpected response setting files folder (${r.type}); received files may land elsewhere.`,
    );
  }
}

export interface StartBotOptions {
  /** Live file-receive timeout provider (admin-configurable). */
  getFileTimeoutMs?: () => number;
}

/**
 * Starts the bot. Registers the file-transfer event handlers (which drive the
 * FileReceiver); the caller registers message/deletion handlers on `chat`.
 */
export async function startBot(cfg: Config, opts: StartBotOptions = {}): Promise<BotHandle> {
  await ensureDirs(cfg);

  // Carry the avatar IN the boot profile so the SDK's updateBotUserProfile applies
  // it (and self-heals it on any boot where it differs). undefined if no file.
  const image = await loadAvatarDataUri(cfg.avatarPath);

  log.info('Starting embedded SimpleX chat core…');
  const [chat, user] = await bot.run({
    profile: {
      displayName: cfg.botDisplayName,
      fullName: '',
      // Only set `image` when we actually have one — a profile with image:undefined
      // must deep-equal the stored profile so bot.run doesn't churn the update.
      ...(image ? { image } : {}),
    },
    dbOpts: { type: 'sqlite', filePrefix: cfg.simplexDbPrefix },
    options: {
      // Consent bot: no open contact address (commands arrive in-group), but
      // allow files so the core will accept file transfers.
      createAddress: false,
      updateAddress: false,
      allowFiles: true,
      // Reconcile the profile ONLY when we actually loaded an avatar: then bot.run
      // applies the FULL profile (image included) and self-heals it whenever it
      // differs from the stored one. If the avatar file is missing/unreadable at
      // boot, `image` is undefined — we must NOT let the SDK reconcile, or it
      // would deep-diff the image-less profile against the stored one and WIPE the
      // avatar (then propagate the blank to the group). false = leave the stored
      // profile untouched. Existing members get the avatar via flushAvatarToGroups
      // (a profile update alone only reaches direct contacts, of which we have 0).
      updateProfile: image !== undefined,
      logContacts: true,
      logNetwork: false,
    },
  });
  log.info(
    `SimpleX core started as "${user.profile.displayName}" (userId=${user.userId})` +
      `${image ? ' with avatar' : ' (no avatar file)'}.`,
  );

  await configureFilesFolder(chat, cfg.simplexFilesFolder);

  const fileReceiver = new FileReceiver(chat, cfg.simplexFilesFolder, opts.getFileTimeoutMs);
  chat.on('rcvFileComplete', (ev) => fileReceiver.handleComplete(ev));
  chat.on('rcvFileError', (ev) => fileReceiver.handleError(ev));
  // rcvFileWarning is transient (the XFTP agent keeps retrying) — do NOT treat it
  // as terminal, or media that later completes would be dropped.
  chat.on('rcvFileWarning', (ev) => fileReceiver.handleWarning(ev));

  const close = async (): Promise<void> => {
    // Reject in-flight receipts so their failure handlers record a media_error
    // (best-effort — the pool is still open at this point in the shutdown order).
    fileReceiver.abortAll('bot shutting down before file receipt completed');
    // Give the detached failure handlers a tick to flush their DB writes.
    await new Promise((r) => setTimeout(r, 250));
    try {
      await chat.stopChat();
      await chat.close();
    } catch (err) {
      log.warn(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { chat, user, fileReceiver, close };
}
