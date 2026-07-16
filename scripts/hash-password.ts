/**
 * Generates the Argon2id hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run hash-password
 *
 * Reads the password from stdin (not argv, so it never lands in shell history),
 * with terminal echo disabled where supported.
 */

import { stdin, stdout } from 'node:process';
import argon2 from 'argon2';

function readPassword(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(prompt);
    const chunks: string[] = [];
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          if (stdin.isTTY) stdin.setRawMode(wasRaw);
          stdin.pause();
          stdout.write('\n');
          resolve(chunks.join(''));
          return;
        }
        if (ch === '') {
          // Ctrl+C
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '' || ch === '\b') {
          chunks.pop();
          continue;
        }
        chunks.push(ch);
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readPassword('Password for the admin account: ');
if (password.length < 12) {
  console.error('Refusing: use at least 12 characters.');
  process.exit(1);
}
const confirm = await readPassword('Repeat password: ');
if (password !== confirm) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
});

console.log('\nAdd this to your environment (.env or systemd env file):\n');
console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
console.log('\n(Quote it — the hash contains $ characters.)');
process.exit(0);
