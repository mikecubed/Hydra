/**
 * Hydra Resume Scanner — Unified resumable state detection.
 *
 * Scans all sources in parallel and returns a flat array of resumable items
 * for the operator's :resume command. Each scanner is independently try/catch
 * wrapped so one failure never blocks others.
 *
 * Designed as a standalone module so any flow (operator, concierge, nightly)
 * can query "what can be resumed?" without coupling to the operator REPL.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResumableItem {
  source: string;
  label: string;
  hint: string;
  value: string;
  detail?: string;
}

interface DaemonTask {
  id: string;
  owner: string;
}

interface DaemonHandoff {
  from: string;
  to: string;
}

interface DaemonStatus {
  activeSession?: { status: string; pauseReason?: string };
  staleTasks?: DaemonTask[];
  pendingHandoffs?: DaemonHandoff[];
  inProgressTasks?: DaemonTask[];
}

interface EvolveState {
  resumable?: boolean;
  status?: string;
  completedRounds?: unknown[];
  maxRounds?: number | string;
  actionNeeded?: string;
  sessionId?: string;
}

interface CouncilData {
  prompt?: string;
  phase?: string;
}

// ── Main Export ─────────────────────────────────────────────────────────────

/**
 * Scan all resumable state sources in parallel.
 *
 * @param opts.baseUrl      - Daemon base URL (e.g. 'http://localhost:4173')
 * @param opts.projectRoot  - Project root directory
 */
export async function scanResumableState({
  baseUrl,
  projectRoot,
}: {
  baseUrl: string;
  projectRoot: string;
}): Promise<ResumableItem[]> {
  const evolveDir = path.join(projectRoot, 'docs', 'coordination', 'evolve');
  const coordDir = path.join(projectRoot, 'docs', 'coordination');

  const results = await Promise.allSettled([
    scanDaemon(baseUrl),
    Promise.resolve(scanEvolveSession(evolveDir)),
    Promise.resolve(scanCouncilCheckpoints(coordDir)),
    scanUnmergedBranches(projectRoot),
    scanSuggestions(evolveDir),
  ]);

  const items: ResumableItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      if (Array.isArray(r.value)) {
        items.push(...r.value);
      } else {
        items.push(r.value);
      }
    }
  }
  return items;
}

// ── Individual Scanners ─────────────────────────────────────────────────────

function buildPausedSessionItem(session: DaemonStatus['activeSession']): ResumableItem | null {
  if (session?.status !== 'paused') return null;
  const reason = session.pauseReason;
  return {
    source: 'daemon',
    label: 'Unpause session',
    hint: reason != null && reason !== '' ? `Paused: "${reason}"` : 'Session is paused',
    value: 'daemon:unpause',
  };
}

function buildStaleTasksItem(stale: DaemonTask[]): ResumableItem | null {
  if (stale.length === 0) return null;
  return {
    source: 'daemon',
    label: `Reset ${String(stale.length)} stale task${stale.length > 1 ? 's' : ''}`,
    hint: stale.map((t) => `${t.id} (${t.owner})`).join(', '),
    value: 'daemon:stale',
  };
}

function buildHandoffsItem(handoffs: DaemonHandoff[]): ResumableItem | null {
  if (handoffs.length === 0) return null;
  return {
    source: 'daemon',
    label: `Ack ${String(handoffs.length)} pending handoff${handoffs.length > 1 ? 's' : ''}`,
    hint: handoffs.map((h) => `${h.from}→${h.to}`).join(', '),
    value: 'daemon:handoffs',
  };
}

function buildInProgressItem(
  inProgress: DaemonTask[],
  stale: DaemonTask[],
  handoffs: DaemonHandoff[],
): ResumableItem | null {
  if (inProgress.length === 0 || stale.length > 0 || handoffs.length > 0) return null;
  return {
    source: 'daemon',
    label: `Resume ${String(inProgress.length)} in-progress task${inProgress.length > 1 ? 's' : ''}`,
    hint: inProgress.map((t) => `${t.id} (${t.owner})`).join(', '),
    value: 'daemon:resume',
  };
}

async function scanDaemon(baseUrl: string): Promise<ResumableItem[] | null> {
  if (baseUrl === '') return null;
  try {
    const { request } = await import('./hydra-utils.ts');
    const statusUnknown: unknown = await request('GET', baseUrl, '/session/status');
    const status = statusUnknown as DaemonStatus;
    const stale = status.staleTasks ?? [];
    const handoffs = status.pendingHandoffs ?? [];
    const inProgress = status.inProgressTasks ?? [];
    const candidates = [
      buildPausedSessionItem(status.activeSession),
      buildStaleTasksItem(stale),
      buildHandoffsItem(handoffs),
      buildInProgressItem(inProgress, stale, handoffs),
    ];
    const items = candidates.filter((x): x is ResumableItem => x !== null);
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

function scanEvolveSession(evolveDir: string): ResumableItem | null {
  try {
    const statePath = path.join(evolveDir, 'EVOLVE_SESSION_STATE.json');
    if (!fs.existsSync(statePath)) return null;
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as EvolveState;

    if (state.resumable !== true) return null;
    const status = state.status;
    if (status !== 'partial' && status !== 'failed' && status !== 'interrupted') return null;

    const completed = (state.completedRounds ?? []).length;
    const max = state.maxRounds ?? '?';
    const action = state.actionNeeded ?? `${status} — can resume`;

    return {
      source: 'evolve',
      label: `Resume evolve session (${String(completed)}/${String(max)} rounds)`,
      hint: action,
      value: 'evolve',
      detail: state.sessionId,
    };
  } catch {
    return null;
  }
}

function scanCouncilCheckpoints(coordDir: string): ResumableItem[] | null {
  try {
    const councilDir = coordDir;
    if (!fs.existsSync(councilDir)) return null;

    const files = fs
      .readdirSync(councilDir)
      .filter((f) => /^COUNCIL_CHECKPOINT_.*\.json$/i.test(f));
    if (files.length === 0) return null;

    const items: ResumableItem[] = [];
    for (const file of files.slice(0, 3)) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(councilDir, file), 'utf8'),
        ) as CouncilData;
        const hash = file.replace(/^COUNCIL_CHECKPOINT_/, '').replace(/\.json$/, '');
        items.push({
          source: 'council',
          label: `Council checkpoint: ${(data.prompt ?? hash).slice(0, 50)}`,
          hint: `Phase: ${data.phase ?? 'unknown'}`,
          value: `council:${hash}`,
          detail: file,
        });
      } catch {
        /* skip malformed */
      }
    }
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function scanUnmergedBranches(projectRoot: string): Promise<ResumableItem[] | null> {
  try {
    const { listBranches } = await import('./hydra-shared/git-ops.ts');
    const items: ResumableItem[] = [];

    for (const prefix of ['evolve', 'nightly', 'tasks']) {
      const branches = listBranches(projectRoot, prefix);
      if (branches.length > 0) {
        items.push({
          source: 'branches',
          label: `${String(branches.length)} unmerged ${prefix}/* branch${branches.length > 1 ? 'es' : ''}`,
          hint:
            branches.slice(0, 3).join(', ') +
            (branches.length > 3 ? ` +${String(branches.length - 3)} more` : ''),
          value: `branches:${prefix}`,
        });
      }
    }

    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

async function scanSuggestions(evolveDir: string): Promise<ResumableItem | null> {
  try {
    const { loadSuggestions, getPendingSuggestions } =
      await import('./hydra-evolve-suggestions.ts');
    const sg = loadSuggestions(evolveDir);
    const pending = getPendingSuggestions(sg);
    if (pending.length === 0) return null;

    const topTitles = pending
      .slice(0, 3)
      .map((s) => s.title)
      .join('; ');
    return {
      source: 'suggestions',
      label: `${String(pending.length)} pending evolve suggestion${pending.length > 1 ? 's' : ''}`,
      hint: topTitles,
      value: 'suggestions',
    };
  } catch {
    return null;
  }
}
