import fs from 'node:fs';
import path from 'node:path';

// ── Checkpoint & Hot-Restart ─────────────────────────────────────────────────

export const CHECKPOINT_FILE = '.session-checkpoint.json';

export function getCheckpointPath(evolveDir: string): string {
  return path.join(evolveDir, CHECKPOINT_FILE);
}

/**
 * Load a session checkpoint from disk. Returns null if none exists.
 */
export function loadCheckpoint(evolveDir: string): unknown {
  const cpPath = getCheckpointPath(evolveDir);
  try {
    if (!fs.existsSync(cpPath)) return null;
    const raw = fs.readFileSync(cpPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save a session checkpoint to disk for hot-restart.
 * @returns The path to the saved checkpoint file.
 */
export function saveCheckpoint(evolveDir: string, data: unknown): string {
  const cpPath = getCheckpointPath(evolveDir);
  fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
  return cpPath;
}

/**
 * Delete the checkpoint file (consumed after resume).
 */
export function deleteCheckpoint(evolveDir: string): void {
  const cpPath = getCheckpointPath(evolveDir);
  try {
    fs.unlinkSync(cpPath);
  } catch {
    /* ok if missing */
  }
}

// ── Session State Tracking ───────────────────────────────────────────────────

export const SESSION_STATE_FILE = 'EVOLVE_SESSION_STATE.json';

export function getSessionStatePath(evolveDir: string): string {
  return path.join(evolveDir, SESSION_STATE_FILE);
}

/**
 * Compute session status from round results.
 * @returns {'running'|'completed'|'partial'|'failed'|'interrupted'}
 */
export function computeSessionStatus(
  roundResults: Array<{ verdict?: string | null }>,
  maxRounds: number,
  stopReason: unknown,
  isRunning: boolean,
): 'running' | 'completed' | 'partial' | 'failed' | 'interrupted' {
  if (isRunning) return 'running';
  if (roundResults.length === 0) return 'failed';

  const allErrored = roundResults.every(
    (r: { verdict?: string | null }) => r.verdict === 'error' || r.verdict === 'reject',
  );
  if (allErrored) return 'failed';

  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- runtime safety
  if (stopReason) return 'partial'; // stopped early by time/budget
  if (roundResults.length < maxRounds) return 'partial';
  return 'completed';
}

/**
 * Compute human-readable action needed string.
 */
export function computeActionNeeded(
  roundResults: { length: number },
  maxRounds: number,
  status: string,
): string {
  if (status === 'completed') return 'Session complete. Review branches with :evolve status';
  if (status === 'failed') return 'All rounds failed. Check agent configs and retry';
  if (status === 'partial') {
    const remaining = maxRounds - roundResults.length;
    return `${String(remaining)} round(s) remaining. Resume with :evolve resume`;
  }
  if (status === 'interrupted') return 'Session was interrupted. Resume with :evolve resume';
  return 'Session in progress';
}

export function saveSessionState(evolveDir: string, state: unknown): void {
  const statePath = getSessionStatePath(evolveDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function loadSessionState(evolveDir: string): unknown {
  const statePath = getSessionStatePath(evolveDir);
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}
