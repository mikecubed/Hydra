/**
 * Daemon archive helpers: state persistence, snapshots, and idempotency.
 * Extracted from orchestrator-daemon.ts for focused reuse.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveProject } from '../hydra-config.ts';
import { nowIso, getEventSeq, readState } from './state.ts';
import type { EventRecord } from './state.ts';
import type {
  HydraStateShape,
  ArchiveState,
  TaskEntry,
  HandoffEntry,
  BlockerEntry,
} from '../types.ts';

const config = resolveProject();

const EVENTS_PATH = config.eventsPath;
const ARCHIVE_PATH = config.archivePath;
const SNAPSHOT_DIR = path.join(config.coordDir, 'snapshots');

// ── Events ────────────────────────────────────────────────────────────────

export function readEvents(limit = 50): EventRecord[] {
  if (!fs.existsSync(EVENTS_PATH)) {
    return [];
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter(Boolean);

  const parsed: EventRecord[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as EventRecord);
    } catch {
      // Skip malformed lines.
    }
  }
  return parsed.slice(-Math.max(1, Math.min(limit, 500)));
}

export function truncateEventsFile(maxLines = 500): number {
  if (!fs.existsSync(EVENTS_PATH)) {
    return 0;
  }
  const raw = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= maxLines) {
    return 0;
  }
  const trimmed = lines.slice(-maxLines);
  fs.writeFileSync(EVENTS_PATH, `${trimmed.join('\n')}\n`, 'utf8');
  return lines.length - maxLines;
}

// ── Archive ───────────────────────────────────────────────────────────────

export function readArchive(): ArchiveState {
  if (!fs.existsSync(ARCHIVE_PATH)) {
    return { tasks: [], handoffs: [], blockers: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ARCHIVE_PATH, 'utf8')) as ArchiveState;
  } catch {
    return { tasks: [], handoffs: [], blockers: [] };
  }
}

export function writeArchive(archive: ArchiveState): void {
  archive.archivedAt = nowIso();
  fs.writeFileSync(ARCHIVE_PATH, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
}

export function archiveState(state: HydraStateShape): number {
  const archive = readArchive();
  let moved = 0;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;

  const completedTasks = state.tasks.filter((t: TaskEntry) =>
    ['done', 'cancelled'].includes(t.status),
  );
  const completedTaskIds = new Set(completedTasks.map((t: TaskEntry) => t.id));
  if (completedTasks.length > 0) {
    archive.tasks.push(...completedTasks);
    state.tasks = state.tasks.filter((t: TaskEntry) => !completedTaskIds.has(t.id));
    moved += completedTasks.length;

    for (const task of state.tasks) {
      if (Array.isArray((task as unknown as Record<string, unknown>)['blockedBy'])) {
        (task as unknown as Record<string, string[]>)['blockedBy'] = (
          task as unknown as Record<string, string[]>
        )['blockedBy'].filter((dep: string) => !completedTaskIds.has(dep));
      }
    }
  }

  const oldHandoffs = state.handoffs.filter((h: HandoffEntry) => {
    if (h.acknowledgedAt == null || h.acknowledgedAt === '') {
      return false;
    }
    return new Date(h.acknowledgedAt).getTime() < oneHourAgo;
  });
  if (oldHandoffs.length > 0) {
    const oldHandoffIds = new Set(oldHandoffs.map((h: HandoffEntry) => h.id));
    archive.handoffs.push(...oldHandoffs);
    state.handoffs = state.handoffs.filter((h: HandoffEntry) => !oldHandoffIds.has(h.id));
    moved += oldHandoffs.length;
  }

  const resolvedBlockers = state.blockers.filter((b: BlockerEntry) => b.status === 'resolved');
  if (resolvedBlockers.length > 0) {
    const resolvedIds = new Set(resolvedBlockers.map((b: BlockerEntry) => b.id));
    archive.blockers.push(...resolvedBlockers);
    state.blockers = state.blockers.filter((b: BlockerEntry) => !resolvedIds.has(b.id));
    moved += resolvedBlockers.length;
  }

  if (moved > 0) {
    writeArchive(archive);
  }

  return moved;
}

// ── Snapshots ─────────────────────────────────────────────────────────────

export function createSnapshot(): { ok: boolean; seq?: number; filename?: string; error?: string } {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    }
    const state = readState();
    const seq = getEventSeq();
    const snapshot = {
      seq,
      createdAt: nowIso(),
      state,
    };
    const filename = `snapshot_${String(seq)}_${String(Date.now())}.json`;
    fs.writeFileSync(
      path.join(SNAPSHOT_DIR, filename),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      'utf8',
    );
    return { ok: true, seq, filename };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function cleanOldSnapshots(retentionCount = 5): number {
  try {
    if (!fs.existsSync(SNAPSHOT_DIR)) return 0;
    const files = fs
      .readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort();
    const toDelete = files.slice(0, Math.max(0, files.length - retentionCount));
    for (const f of toDelete) {
      try {
        fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
      } catch {
        /* skip */
      }
    }
    return toDelete.length;
  } catch {
    return 0;
  }
}

// ── Idempotency ───────────────────────────────────────────────────────────

const idempotencyLog = new Map<string, number>();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export function checkIdempotency(key: string): boolean {
  if (key === '') return false;
  const now = Date.now();
  // Prune stale entries periodically
  if (idempotencyLog.size > 200) {
    for (const [k, ts] of idempotencyLog) {
      if (now - ts > IDEMPOTENCY_TTL_MS) idempotencyLog.delete(k);
    }
  }
  if (idempotencyLog.has(key)) return true;
  idempotencyLog.set(key, now);
  return false;
}
