/**
 * scripts/install-global.ts — Deterministic global-install helper.
 *
 * Replaces the shell-glob `install:global` one-liner with a script that:
 *   1. Runs `npm pack` and captures the exact tarball filename.
 *   2. Installs that specific file globally.
 *   3. Cleans up the tarball in a finally-style block (even on failure).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exit } from '../lib/hydra-process.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let tgzPath: string | undefined;
let exitCode = 0;

try {
  console.log('[install:global] Packing tarball…');
  const output = execSync('npm pack', { encoding: 'utf8', cwd: ROOT }).trim();

  // npm pack prints the filename on the last line of stdout
  const filename = output.split('\n').pop()?.trim();

  if (filename?.endsWith('.tgz') !== true) {
    throw new Error(`npm pack produced unexpected output: ${output}`);
  }

  tgzPath = path.join(ROOT, filename);

  if (!fs.existsSync(tgzPath)) {
    throw new Error(`Expected tarball not found: ${tgzPath}`);
  }

  console.log(`[install:global] Installing ${filename} globally…`);
  execSync(`npm install -g "${tgzPath}"`, { stdio: 'inherit', cwd: ROOT });
  console.log('[install:global] Done.');
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[install:global] Failed: ${message}`);
  exitCode = 1;
} finally {
  if (tgzPath != null) {
    try {
      if (fs.existsSync(tgzPath)) {
        fs.unlinkSync(tgzPath);
        console.log(`[install:global] Cleaned up ${path.basename(tgzPath)}`);
      }
    } catch {
      console.warn(`[install:global] Warning: could not remove ${tgzPath}`);
    }
  }
}

exit(exitCode);
