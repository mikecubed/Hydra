/**
 * hydra-operator-self-awareness.ts
 *
 * AI self-patch helpers: natural language parsing of self-awareness commands,
 * config patching, and git-state caching.
 * Extracted from hydra-operator.ts to keep operator.ts focused on the interactive loop.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- polymorphic config patching */
/* eslint-disable @typescript-eslint/strict-boolean-expressions -- standard JS truthiness patterns */

import { spawnSync } from 'node:child_process';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';

const config = resolveProject();

// ── Self Awareness (Hyper-Aware Concierge Context) ────────────────────────────

/**
 * Mutable reference object for the self-index cache.
 * Exported so operator.ts can mutate its properties and share invalidation
 * with applySelfAwarenessPatch without ES-module live-binding reassignment issues.
 */
export const selfIndexCache = { block: '', builtAt: 0, key: '' };

export function normalizeSimpleCommandText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'object' || typeof input === 'symbol' || typeof input === 'function')
    return '';
  return String(input as string | number | boolean | bigint)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSelfAwarenessPlaintextCommand(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object' || typeof input === 'symbol' || typeof input === 'function')
    return null;
  const raw = String(input as string | number | boolean | bigint).trim();
  if (!raw) return null;
  if (raw.startsWith(':') || raw.startsWith('!')) return null;
  if (raw.includes('\n')) return null;

  const s = normalizeSimpleCommandText(raw);
  if (!s || s.length > 80) return null;

  const target = '(?:hyper\\s*aware(?:ness)?|self\\s*awareness)';
  const polite = '(?:please\\s+)?(?:can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+)?';
  const agentSuffix = '(?:\\s+agent)?';

  if (new RegExp(`^${polite}(?:turn\\s+off|disable)\\s+${target}${agentSuffix}$`).test(s))
    return 'off';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+off$`).test(s)) return 'off';

  if (new RegExp(`^${polite}(?:turn\\s+on|enable)\\s+${target}${agentSuffix}$`).test(s))
    return 'on';
  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+on$`).test(s)) return 'on';

  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?minimal$`).test(s))
    return 'minimal';
  if (new RegExp(`^${polite}(?:set\\s+)?${target}${agentSuffix}\\s+(?:to\\s+)?full$`).test(s))
    return 'full';

  if (new RegExp(`^${polite}${target}${agentSuffix}\\s+status$`).test(s)) return 'status';
  return null;
}

export async function applySelfAwarenessPatch(patch: Record<string, unknown> = {}): Promise<any> {
  const cfg = loadHydraConfig();
  const current =
    cfg.selfAwareness && typeof cfg.selfAwareness === 'object' ? cfg.selfAwareness : {};
  cfg.selfAwareness = { ...current, ...patch };
  const { saveHydraConfig: save } = await import('./hydra-config.ts');
  const merged = save(cfg);
  Object.assign(selfIndexCache, { block: '', builtAt: 0, key: '' });
  return merged.selfAwareness ?? cfg.selfAwareness;
}

// ── Git Info Cache ────────────────────────────────────────────────────────────

let _gitInfoCache: { data: any; at: number } = { data: null, at: 0 };
const GIT_CACHE_TTL = 30_000;

export function getGitInfo(): { branch: string; modifiedFiles: number } | null {
  const now = Date.now();
  if (_gitInfoCache.data && now - _gitInfoCache.at < GIT_CACHE_TTL) {
    return _gitInfoCache.data as { branch: string; modifiedFiles: number };
  }
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).stdout.trim();
    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: config.projectRoot,
      encoding: 'utf8',
      timeout: 5000,
    }).stdout.trim();
    const modifiedFiles = porcelain ? porcelain.split('\n').length : 0;
    const info = { branch, modifiedFiles };
    _gitInfoCache = { data: info, at: now };
    return info;
  } catch {
    return null;
  }
}
