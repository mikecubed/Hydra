/**
 * Daemon state management: read/write HydraStateShape, event log, and coord
 * files. Extracted from orchestrator-daemon.ts for focused reuse.
 */

import fs from 'node:fs';
import { resolveProject } from '../hydra-config.ts';
import type {
  HydraStateShape,
  TaskEntry,
  HandoffEntry,
  BlockerEntry,
  DecisionEntry,
} from '../types.ts';

const config = resolveProject();

const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const LOG_PATH = config.logPath;
const EVENTS_PATH = config.eventsPath;

// ── Types ──────────────────────────────────────────────────────────────────

export type EventRecord = {
  seq: number;
  at: string;
  type: string;
  category?: string;
  payload?: unknown;
};

// ── Timestamp helpers ──────────────────────────────────────────────────────

export function nowIso(): string {
  return new Date().toISOString();
}

export function toSessionId(date = new Date()): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SYNC_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// ── State factories ────────────────────────────────────────────────────────

export function createAgentRecord(): {
  installed: null;
  path: string;
  version: string;
  lastCheckedAt: null;
} {
  return {
    installed: null,
    path: '',
    version: '',
    lastCheckedAt: null,
  };
}

export function createDefaultState(): HydraStateShape {
  return {
    schemaVersion: 1,
    project: config.projectName,
    updatedAt: nowIso(),
    activeSession: null,
    agents: {
      gemini: createAgentRecord(),
      codex: createAgentRecord(),
      claude: createAgentRecord(),
    },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
    deadLetter: [],
  };
}

export function normalizeState(raw: unknown): HydraStateShape {
  const defaults = createDefaultState();
  const safe = (raw != null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  return {
    ...defaults,
    ...safe,
    agents: {
      ...(defaults.agents as Record<string, unknown>),
      ...((safe['agents'] ?? {}) as Record<string, unknown>),
    },
    tasks: Array.isArray(safe['tasks']) ? (safe['tasks'] as TaskEntry[]) : [],
    decisions: Array.isArray(safe['decisions']) ? (safe['decisions'] as DecisionEntry[]) : [],
    blockers: Array.isArray(safe['blockers']) ? (safe['blockers'] as BlockerEntry[]) : [],
    handoffs: Array.isArray(safe['handoffs']) ? (safe['handoffs'] as HandoffEntry[]) : [],
    deadLetter: Array.isArray(safe['deadLetter']) ? safe['deadLetter'] : [],
    childSessions: Array.isArray(safe['childSessions']) ? safe['childSessions'] : [],
  };
}

// ── Coord-file bootstrap ───────────────────────────────────────────────────

export function ensureCoordFiles(): void {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_PATH)) {
    const state = createDefaultState();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  if (!fs.existsSync(LOG_PATH)) {
    const lines = [
      '# AI Sync Log',
      '',
      `Created: ${nowIso()}`,
      '',
      'Use `npm run hydra:summary` to see current state.',
      '',
    ];
    fs.writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
  }

  if (!fs.existsSync(EVENTS_PATH)) {
    fs.writeFileSync(EVENTS_PATH, '', 'utf8');
  }

  initEventSeq();
}

// ── State I/O ──────────────────────────────────────────────────────────────

export function readState(): HydraStateShape {
  ensureCoordFiles();
  const raw = fs.readFileSync(STATE_PATH, 'utf8');
  return normalizeState(JSON.parse(raw));
}

/**
 * Atomically persist state to disk (write-tmp then rename).
 * @param state - The state object to persist
 * @returns The normalized, timestamped state that was written
 */
export function writeState(state: Record<string, unknown>): HydraStateShape {
  const next = normalizeState(state);
  next.updatedAt = nowIso();
  if (next.activeSession?.status === 'active') {
    next.activeSession.updatedAt = next.updatedAt;
  }
  const tempPath = `${STATE_PATH}.tmp`;
  const data = `${JSON.stringify(next, null, 2)}\n`;
  fs.writeFileSync(tempPath, data, 'utf8');

  let retries = 0;
  for (;;) {
    try {
      fs.renameSync(tempPath, STATE_PATH);
      break;
    } catch (err) {
      retries++;
      if (retries > 5) {
        // If rename fails consistently, try copy and unlink (less atomic but better than partial write)
        try {
          fs.copyFileSync(tempPath, STATE_PATH);
          fs.unlinkSync(tempPath);
          break;
        } catch (copyErr) {
          console.error(
            `Failed to write state: ${(err as Error).message} -> ${(copyErr as Error).message}`,
          );
          throw copyErr;
        }
      }
      // Sync sleep (busy wait) 50ms * retries
      const start = Date.now();
      while (Date.now() - start < 50 * retries);
    }
  }
  return next;
}

export function appendSyncLog(entry: string): void {
  ensureCoordFiles();
  fs.appendFileSync(LOG_PATH, `- ${nowIso()} | ${entry}\n`, 'utf8');
}

// ── Event log ──────────────────────────────────────────────────────────────

let eventSeq = 0;

export function getEventSeq(): number {
  return eventSeq;
}

export function resetEventSeq(): void {
  eventSeq = 0;
}

export function initEventSeq(): void {
  if (!fs.existsSync(EVENTS_PATH)) return;
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { seq?: number };
      if (typeof parsed.seq === 'number' && parsed.seq > eventSeq) {
        eventSeq = parsed.seq;
      }
      break;
    } catch {
      /* skip malformed */
    }
  }
}

export function categorizeEvent(type: string, payload: unknown): string {
  if (type === 'mutation') {
    const label =
      ((payload as Record<string, unknown>)['label'] as string | null | undefined) ?? '';
    if (label.startsWith('task:')) return 'task';
    if (label.startsWith('handoff:')) return 'handoff';
    if (label.startsWith('decision:')) return 'decision';
    if (label.startsWith('blocker:')) return 'blocker';
    if (label.startsWith('session:')) return 'session';
  }
  if (type === 'daemon_start' || type === 'daemon_stop' || type === 'auto_archive') return 'system';
  if (type === 'verification_start' || type === 'verification_complete') return 'task';
  if (typeof type === 'string' && type.startsWith('concierge:')) return 'concierge';
  return 'system';
}

export function appendEvent(type: string, payload?: unknown, id?: string): void {
  eventSeq += 1;
  const category = categorizeEvent(type, payload);
  const line = JSON.stringify({
    id: id ?? `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    seq: eventSeq,
    at: nowIso(),
    type,
    category,
    payload,
  });
  fs.appendFileSync(EVENTS_PATH, `${line}\n`, 'utf8');
}

export function replayEvents(fromSeq = 0): EventRecord[] {
  if (!fs.existsSync(EVENTS_PATH)) return [];
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const events: EventRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { seq?: number } & Partial<EventRecord>;
      if (typeof parsed.seq === 'number' && parsed.seq >= fromSeq) {
        events.push(parsed as EventRecord);
      }
    } catch {
      /* skip malformed */
    }
  }
  return events;
}
