/**
 * Hydra Self Snapshot — canonical structured "who/what am I right now?" view.
 *
 * Used by:
 * - Daemon: GET /self
 * - MCP:    hydra://self
 * - Operator: :self command
 *
 * Intentionally "best effort": failures (no git, no package.json, etc.) should
 * degrade to nulls rather than throwing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { HYDRA_ROOT, HYDRA_RUNTIME_ROOT, loadHydraConfig } from './hydra-config.ts';
import { getModelSummary, listAgents } from './hydra-agents.ts';
import { getMetricsSummary } from './hydra-metrics.ts';
import { spawnSyncCapture } from './hydra-proc.ts';

// ── Types ────────────────────────────────────────────────────────────────────

interface HydraPackageInfo {
  name: string;
  version: string;
  description: string;
}

export interface GitInfo {
  branch: string;
  commit: string;
  dirty: boolean;
  modifiedFiles: number;
}

interface SelfSnapshotOpts {
  projectRoot?: string;
  projectName?: string;
  includeAgents?: boolean;
  includeConfig?: boolean;
  includeMetrics?: boolean;
}

interface FormatSnapshotOpts {
  maxLines?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readJsonSafe(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function safeCall<T>(fn: () => T, fallback: T | null = null): T | null {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function gitExec(cwd: string, args: string[]): string {
  const r = spawnSyncCapture('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) {
    throw new Error(((r.stderr || r.stdout || r.error?.message) ?? 'git error').trim());
  }
  return (r.stdout || '').trim();
}

/**
 * Best-effort git info for a directory.
 * Returns null if not a git repo or git is unavailable.
 * @param {string} cwd
 */
export function getGitInfo(cwd: string | null): GitInfo | null {
  if (!cwd) return null;
  try {
    const branch = gitExec(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const commit = gitExec(cwd, ['rev-parse', '--short', 'HEAD']);
    const porcelain = gitExec(cwd, ['status', '--porcelain']);
    const modifiedFiles = porcelain ? porcelain.split(/\r?\n/).filter(Boolean).length : 0;
    return {
      branch,
      commit,
      dirty: modifiedFiles > 0,
      modifiedFiles,
    };
  } catch {
    return null;
  }
}

export function getHydraPackageInfo(): HydraPackageInfo {
  const pkg = readJsonSafe(path.join(HYDRA_ROOT, 'package.json')) ?? {};
  return {
    name: (pkg['name'] as string | undefined) ?? 'hydra',
    version: (pkg['version'] as string | undefined) ?? 'unknown',
    description: (pkg['description'] as string | undefined) ?? '',
  };
}

/**
 * Build a structured self snapshot.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] - Current target project root (daemon/operator context)
 * @param {string} [opts.projectName] - Optional friendly project name
 * @param {boolean} [opts.includeAgents=false]
 * @param {boolean} [opts.includeConfig=true]
 * @param {boolean} [opts.includeMetrics=true]
 * @returns {object}
 */
export function buildSelfSnapshot(opts: SelfSnapshotOpts = {}): Record<string, unknown> {
  const {
    projectRoot = '',
    projectName = '',
    includeAgents = false,
    includeConfig = true,
    includeMetrics = true,
  } = opts;

  const hydraPkg = getHydraPackageInfo();
  const cfg = (includeConfig ? safeCall(() => loadHydraConfig(), null) : null) as Record<
    string,
    unknown
  > | null;
  const models = safeCall(() => getModelSummary(), null);

  const snapshot: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    hydra: {
      ...hydraPkg,
      root: HYDRA_ROOT,
      runtimeRoot: HYDRA_RUNTIME_ROOT,
      packaged: Boolean((process as unknown as Record<string, unknown>)['pkg']),
      node: process.version,
      platform: process.platform,
      pid: process.pid,
    },
    git: {
      hydra: getGitInfo(HYDRA_ROOT),
      project: projectRoot ? getGitInfo(projectRoot) : null,
    },
    project: {
      name: projectName || (projectRoot ? path.basename(projectRoot) : 'unknown'),
      root: projectRoot || '',
    },
    models,
  };

  if (cfg) {
    const cfgConcierge = cfg['concierge'] as Record<string, unknown> | undefined;
    const cfgVerification = cfg['verification'] as Record<string, unknown> | undefined;
    const cfgModelRecovery = cfg['modelRecovery'] as Record<string, unknown> | undefined;
    const cfgWorkers = cfg['workers'] as Record<string, unknown> | undefined;
    snapshot['config'] = {
      mode: (cfg['mode'] as string | undefined) ?? 'performance',
      concierge: cfgConcierge
        ? {
            enabled: cfgConcierge['enabled'] !== false,
            model: (cfgConcierge['model'] as string | undefined) ?? null,
            reasoningEffort: (cfgConcierge['reasoningEffort'] as string | undefined) ?? null,
            fallbackChain: Array.isArray(cfgConcierge['fallbackChain'])
              ? cfgConcierge['fallbackChain']
              : [],
          }
        : null,
      verification: cfgVerification
        ? {
            onTaskDone: cfgVerification['onTaskDone'] !== false,
            command: cfgVerification['command'] ?? 'auto',
            timeoutMs: cfgVerification['timeoutMs'] ?? null,
            secretsScan: cfgVerification['secretsScan'] !== false,
          }
        : null,
      modelRecovery: cfgModelRecovery ? { enabled: cfgModelRecovery['enabled'] !== false } : null,
      workers: cfgWorkers ? { enabled: cfgWorkers['enabled'] !== false } : null,
    };
  }

  if (includeMetrics) {
    snapshot['metrics'] = safeCall(() => getMetricsSummary(), null);
  }

  if (includeAgents) {
    snapshot['agents'] = safeCall(() => listAgents(), null);
  }

  return snapshot;
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join('\n');
  return `${lines.slice(0, maxLines).join('\n')}\n... (truncated)`;
}

/**
 * Format a snapshot into a bounded text block for LLM prompt injection.
 * @param {object} snapshot
 * @param {object} [opts]
 * @param {number} [opts.maxLines=80]
 */
export function formatSelfSnapshotForPrompt(
  snapshot: Record<string, unknown>,
  opts: FormatSnapshotOpts = {},
): string {
  const maxLines = Number.isFinite(opts.maxLines) ? (opts.maxLines as number) : 80;
  const s = snapshot;
  const lines: string[] = [];

  lines.push('=== HYDRA SELF SNAPSHOT ===');
  const hydra = s['hydra'] as Record<string, unknown> | undefined;
  if (hydra) {
    const hydraName = hydra['name'] as string | undefined;
    const hydraVersion = hydra['version'] as string | undefined;
    const hydraRoot = hydra['root'] as string | undefined;
    const hydraNode = hydra['node'] as string | undefined;
    const hydraPlatform = hydra['platform'] as string | undefined;
    lines.push(`Hydra: ${hydraName ?? 'hydra'} v${hydraVersion ?? 'unknown'}`);
    if (hydraRoot) lines.push(`Hydra root: ${hydraRoot}`);
    if (hydraNode) lines.push(`Node: ${hydraNode} (${hydraPlatform ?? ''})`);
  }

  const git = s['git'] as Record<string, unknown> | undefined;
  const hg = git?.['hydra'] as GitInfo | undefined;
  if (hg) {
    lines.push(
      `Hydra git: ${hg.branch}@${hg.commit}${hg.dirty ? ` (+${String(hg.modifiedFiles)} dirty)` : ''}`,
    );
  }

  const project = s['project'] as Record<string, unknown> | undefined;
  if (project?.['root']) {
    const projectName = project['name'] as string | undefined;
    const projectRoot = project['root'] as string | undefined;
    lines.push(`Project: ${projectName ?? 'unknown'} (${projectRoot ?? ''})`);
  }

  const pg = git?.['project'] as GitInfo | undefined;
  if (pg) {
    lines.push(
      `Project git: ${pg.branch}@${pg.commit}${pg.dirty ? ` (+${String(pg.modifiedFiles)} dirty)` : ''}`,
    );
  }

  const config = s['config'] as Record<string, unknown> | undefined;
  const mode = config?.['mode'] as string | undefined;
  if (mode) {
    lines.push(`Mode: ${mode}`);
  }

  const models = s['models'];
  if (models && typeof models === 'object') {
    lines.push('Models:');
    for (const [agent, info] of Object.entries(models as Record<string, unknown>)) {
      if (agent === '_mode') continue;
      if (!info || typeof info !== 'object') continue;
      const infoRec = info as Record<string, unknown>;
      const active = (infoRec['active'] as string | undefined) ?? 'unknown';
      const tierSource = infoRec['tierSource'] as string | undefined;
      const src = tierSource ? ` (${tierSource})` : '';
      lines.push(`- ${agent}: ${active}${src}`);
    }
  }

  lines.push('=== END SNAPSHOT ===');
  return truncateLines(lines.join('\n'), maxLines);
}
