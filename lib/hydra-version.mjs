/**
 * Hydra Version — derives version string from package.json + git state.
 *
 * Format:  1.2.0-40-g4bdb7b9  (semver-commitCount-gShortHash)
 * Falls back to plain semver if git is unavailable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { git } from './hydra-shared/git-ops.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const repoRoot = join(__dirname, '..');

let _cached = null;

function readGit(args) {
  const r = git(args, repoRoot);
  return r.status === 0 ? (r.stdout || '').trim() || null : null;
}

export function getVersion() {
  if (_cached) return _cached;

  let semver = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    semver = pkg.version || semver;
  } catch { /* use fallback */ }

  const commitCount = readGit(['rev-list', '--count', 'HEAD']);
  const shortHash = readGit(['rev-parse', '--short', 'HEAD']);
  const dirty = readGit(['status', '--porcelain']);

  let full = semver;
  if (commitCount && shortHash) {
    full = `${semver}-${commitCount}-g${shortHash}`;
  }
  if (dirty) full += '-dirty';

  _cached = { semver, commitCount, shortHash, dirty: !!dirty, full };
  return _cached;
}

export function versionString() {
  return getVersion().full;
}
