/**
 * Generates the Argon2id hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * Reads the password from stdin (not argv, so it never lands in shell history).
 * On a TTY, echo is disabled. Piped input (e.g. `printf 'pw\npw\n' | ...`) also
 * works — lines are buffered so the confirmation line is not lost.
 *
 * Prompts go to stderr so stdout carries only the resulting hash line.
 */

import { stdin, stderr, stdout } from 'node:process';
import argon2 from 'argon2';

const isTTY = Boolean(stdin.isTTY);
const lineQueue: string[] = [];
let buffer = '';
let pendingResolver: ((line: string | null) => void) | null = null;
let ended = false;

function deliver(line: string): void {
  if (pendingResolver) {
    const resolve = pendingResolver;
    pendingResolver = null;
    resolve(line);
  } else {
    lineQueue.push(line);
  }
}

function feed(chunk: string): void {
  for (const ch of chunk) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      deliver(buffer);
      buffer = '';
    } else if (ch === '\x03') {
      // Ctrl+C
      stderr.write('\n');
      process.exit(130);
    } else if (ch === '\x7f' || ch === '\b') {
      buffer = buffer.slice(0, -1);
    } else {
      buffer += ch;
    }
  }
}

stdin.setEncoding('utf8');
if (isTTY) stdin.setRawMode(true);
stdin.on('data', feed);
stdin.on('end', () => {
  ended = true;
  // Flush a trailing line without a newline, then signal EOF to any waiter.
  if (buffer.length > 0) {
    const last = buffer;
    buffer = '';
    deliver(last);
  } else if (pendingResolver) {
    const resolve = pendingResolver;
    pendingResolver = null;
    resolve(null);
  }
});

function nextLine(prompt: string): Promise<string | null> {
  stderr.write(prompt);
  return new Promise((resolve) => {
    if (lineQueue.length > 0) {
      resolve(lineQueue.shift() ?? null);
    } else if (ended) {
      resolve(null);
    } else {
      pendingResolver = resolve;
    }
  }).then((line) => {
    if (isTTY) stderr.write('\n');
    return line as string | null;
  });
}

async function main(): Promise<void> {
  const password = await nextLine('Password for the admin account: ');
  if (password === null) {
    stderr.write('No password provided on stdin.\n');
    process.exit(1);
  }
  if (password.length < 12) {
    stderr.write('Refusing: use at least 12 characters.\n');
    process.exit(1);
  }
  const confirm = await nextLine('Repeat password: ');
  if (confirm === null) {
    stderr.write('No confirmation provided on stdin.\n');
    process.exit(1);
  }
  if (password !== confirm) {
    stderr.write('Passwords do not match.\n');
    process.exit(1);
  }

  const hash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MiB
    timeCost: 3,
    parallelism: 4,
  });

  stderr.write('\nAdd this to your environment (.env or systemd env file):\n\n');
  stdout.write(`ADMIN_PASSWORD_HASH='${hash}'\n`);
  stderr.write('\n(Quote it — the hash contains $ characters.)\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  stderr.write(`hash-password failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
