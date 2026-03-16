/**
 * lib/check-install.ts — Postinstall guard for unsupported install methods.
 *
 * Detects when Hydra is installed from a raw local-folder path
 * (e.g. `npm install /path/to/Hydra`) which bypasses the prepack build step
 * and results in missing JS runtime artifacts. Exits with a clear error
 * directing users to supported install methods.
 *
 * In valid installs (tarball, registry, or dev checkout), exits silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { exit } from './hydra-process.ts';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

/** Bin/lib entry points that prepack generates as .js for the packaged tarball. */
export const REQUIRED_JS_ARTIFACTS: readonly string[] = [
  'bin/hydra-cli.js',
  'lib/orchestrator-client.js',
  'lib/orchestrator-daemon.js',
];

/**
 * Determines whether the current install has the required JS runtime surface.
 *
 * @param rootDir  Package root directory to check.
 * @param initCwd  Value of INIT_CWD (the directory where `npm install` was invoked).
 *                 Pass `null` to simulate absent INIT_CWD.
 * @returns `{ ok: true }` for valid installs, `{ ok: false, reason }` for broken ones.
 */
export function checkInstall(
  rootDir: string = ROOT,
  initCwd: string | null | undefined = process.env['INIT_CWD'],
): { ok: boolean; reason?: string } {
  const allArtifactsPresent = REQUIRED_JS_ARTIFACTS.every((rel) =>
    fs.existsSync(path.join(rootDir, rel)),
  );

  if (allArtifactsPresent) {
    return { ok: true };
  }

  // Artifacts missing — allow if this is a dev checkout (npm install in repo root)
  // or if INIT_CWD is unset (script invoked outside of npm lifecycle).
  if (initCwd == null || initCwd === '' || path.resolve(initCwd) === path.resolve(rootDir)) {
    return { ok: true, reason: 'dev-install' };
  }

  return { ok: false, reason: 'missing-artifacts' };
}

// ── CLI entry point (runs when executed directly via npm postinstall) ─────────

const self = path.resolve(__filename);
const invoked = path.resolve(process.argv[1] ?? '');

if (invoked === self) {
  const result = checkInstall();
  if (result.ok) {
    exit(0);
  }

  const msg = [
    '',
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║  Hydra: unsupported install method detected                        ║',
    '╠══════════════════════════════════════════════════════════════════════╣',
    '║                                                                    ║',
    '║  You installed Hydra from a raw local folder path, which bypasses  ║',
    '║  the build that generates the required JavaScript runtime files.   ║',
    '║                                                                    ║',
    '║  Supported install methods:                                        ║',
    '║                                                                    ║',
    '║    From tarball:   npm install hydra-<version>.tgz                 ║',
    '║    From registry:  npm install hydra                               ║',
    '║    Development:    git clone <url> && cd Hydra && npm install      ║',
    '║                                                                    ║',
    '║  To create an installable tarball:                                 ║',
    '║    cd /path/to/Hydra && npm pack                                   ║',
    '║                                                                    ║',
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
  ];
  console.error(msg.join('\n'));
  exit(1);
}
