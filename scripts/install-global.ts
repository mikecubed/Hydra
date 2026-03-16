/**
 * scripts/install-global.ts — Deterministic global-install helper.
 *
 * Replaces the shell-glob `install:global` one-liner with a script that:
 *   1. Runs `npm pack` and captures the exact tarball filename.
 *   2. Installs that specific file globally.
 *   3. Cleans up the tarball in a finally-style block (even on failure).
 *
 * Uses spawnSync with args-array for Windows-safe arg handling (no shell interpolation).
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exit } from '../lib/hydra-process.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/**
 * Run a command synchronously, returning trimmed stdout.
 * Throws on non-zero exit code or spawn error.
 */
function run(
  cmd: string,
  args: string[],
  opts: { cwd: string; stdio?: 'inherit' | 'pipe' },
): string {
  const result: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    cwd: opts.cwd,
    stdio: opts.stdio ?? 'pipe',
    encoding: 'utf8',
    // Windows needs shell for npm (.cmd shim)
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
    throw new Error(
      `Command "${cmd} ${args.join(' ')}" exited with code ${String(result.status)}${stderr === '' ? '' : `: ${stderr}`}`,
    );
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

let tgzPath: string | undefined;
let exitCode = 0;

try {
  console.log('[install:global] Packing tarball…');
  const output = run('npm', ['pack'], { cwd: ROOT });

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
  run('npm', ['install', '-g', tgzPath], { cwd: ROOT, stdio: 'inherit' });
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
