/**
 * Hydra Version — derives version string from package.json + git state.
 *
 * Format:  1.2.0-40-g4bdb7b9  (semver-commitCount-gShortHash)
 * Falls back to plain semver if git is unavailable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { git } from './hydra-shared/git-ops.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const repoRoot = join(__dirname, '..');

interface VersionInfo {
  semver: string;
  commitCount: string | null;
  shortHash: string | null;
  dirty: boolean;
  full: string;
}

let _cached: VersionInfo | null = null;

function readGit(args: string[]): string | null {
  const r = git(args, repoRoot);
  if (r.status !== 0) return null;
  const trimmed = r.stdout.trim();
  return trimmed === '' ? null : trimmed;
}

export function getVersion(): VersionInfo {
  if (_cached) return _cached;

  let semver = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    semver = pkg.version ?? semver;
  } catch {
    /* use fallback */
  }

  const commitCount = readGit(['rev-list', '--count', 'HEAD']);
  const shortHash = readGit(['rev-parse', '--short', 'HEAD']);
  const dirty = readGit(['status', '--porcelain']);

  let full = semver;
  if (commitCount != null && shortHash != null) {
    full = `${semver}-${commitCount}-g${shortHash}`;
  }
  if (dirty != null && dirty !== '') full += '-dirty';

  _cached = { semver, commitCount, shortHash, dirty: dirty != null && dirty !== '', full };
  return _cached;
}

export function versionString(): string {
  return getVersion().full;
}
