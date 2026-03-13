import fs from 'node:fs';
import path from 'node:path';
import type { TestFailure } from './hydra-utils.ts';

// ── Shared types ─────────────────────────────────────────────────────────────

export interface RoundResult {
  round: number;
  area: string;
  selectedImprovement: string | null;
  verdict: string | null;
  score: number | null;
  branchName: string | null;
  learnings: string | null;
  durationMs: number;
  researchSummary: string | null;
  investigations: {
    count: number;
    healed: number;
    diagnoses: Array<{ phase: string; diagnosis: string; explanation: string }>;
  } | null;
  testSummary: { total: number; passed: number; failed: number; summary: string } | null;
  testFailures: TestFailure[] | null;
  merged: boolean;
  mergeMethod: string | null;
  mergeConflicts: string[] | null;
  suggestionId: string | null;
  testsWritten?: number;
}

// ── Shared types ─────────────────────────────────────────────────────────────

export interface EvolveTimeouts {
  researchTimeoutMs: number;
  deliberateTimeoutMs: number;
  planTimeoutMs: number;
  testTimeoutMs: number;
  implementTimeoutMs: number;
  analyzeTimeoutMs: number;
}

export interface EvolveSummary {
  approved?: number;
  rejected?: number;
  skipped?: number;
  errors?: number;
  totalKBAdded?: number;
}

export interface EvolveCheckpoint {
  sessionId?: string;
  startedAt?: number;
  dateStr?: string;
  projectRoot?: string;
  baseBranch?: string;
  maxRounds?: number;
  maxHoursMs?: number;
  focusAreas?: string[];
  timeouts?: Partial<EvolveTimeouts>;
  budgetOverrides?: Record<string, unknown>;
  budgetState?: Record<string, unknown>;
  completedRounds?: RoundResult[];
  lastRoundNum?: number;
  kbStartCount?: number;
  activeSuggestionId?: string | null;
  reason?: string;
}

export interface EvolveSessionState {
  sessionId?: string;
  status?: string;
  startedAt?: number;
  finishedAt?: number;
  dateStr?: string;
  maxRounds?: number;
  maxHours?: number;
  focusAreas?: string[];
  timeouts?: Partial<EvolveTimeouts>;
  kbStartCount?: number;
  completedRounds?: RoundResult[];
  nextRound?: number;
  resumable?: boolean;
  activeSuggestionId?: string | null;
  summary?: EvolveSummary;
  budgetState?: Record<string, unknown>;
  stopReason?: string | null;
  actionNeeded?: string;
  interruptedAt?: number;
}

// ── Checkpoint & Hot-Restart ─────────────────────────────────────────────────

export const CHECKPOINT_FILE = '.session-checkpoint.json';

export function getCheckpointPath(evolveDir: string): string {
  return path.join(evolveDir, CHECKPOINT_FILE);
}

/**
 * Load a session checkpoint from disk. Returns null if none exists.
 */
export function loadCheckpoint(evolveDir: string): EvolveCheckpoint | null {
  const cpPath = getCheckpointPath(evolveDir);
  try {
    if (!fs.existsSync(cpPath)) return null;
    const raw = fs.readFileSync(cpPath, 'utf8');
    return JSON.parse(raw) as EvolveCheckpoint;
  } catch {
    return null;
  }
}

/**
 * Save a session checkpoint to disk for hot-restart.
 * @returns The path to the saved checkpoint file.
 */
export function saveCheckpoint(evolveDir: string, data: EvolveCheckpoint): string {
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
 * @returns {'running'|'completed'|'partial'|'failed'}
 */
export function computeSessionStatus(
  roundResults: RoundResult[],
  maxRounds: number,
  stopReason: string | null,
  isRunning: boolean,
): 'running' | 'completed' | 'partial' | 'failed' {
  if (isRunning) return 'running';
  if (roundResults.length === 0) return 'failed';

  const allErrored = roundResults.every(
    (r: RoundResult) => r.verdict === 'error' || r.verdict === 'reject',
  );
  if (allErrored) return 'failed';

  if (stopReason !== null) return 'partial'; // stopped early by time/budget
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
  return 'Session in progress';
}

export function saveSessionState(evolveDir: string, state: EvolveSessionState): void {
  const statePath = getSessionStatePath(evolveDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function loadSessionState(evolveDir: string): EvolveSessionState | null {
  const statePath = getSessionStatePath(evolveDir);
  try {
    if (!fs.existsSync(statePath)) return null;
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as EvolveSessionState;
  } catch {
    return null;
  }
}
