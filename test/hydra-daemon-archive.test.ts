/**
 * Unit tests for lib/daemon/archive.ts — state persistence helpers
 * extracted from orchestrator-daemon.ts.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HydraStateShape,
  ArchiveState,
  TaskEntry,
  BlockerEntry,
  HandoffEntry,
} from '../lib/types.ts';
import type { EventRecord } from '../lib/daemon/state.ts';

type ArchiveModule = {
  readEvents: (limit?: number) => EventRecord[];
  readArchive: () => ArchiveState;
  writeArchive: (archive: ArchiveState) => void;
  archiveState: (state: HydraStateShape) => number;
  truncateEventsFile: (maxLines?: number) => number;
  createSnapshot: () => { ok: boolean; seq?: number; filename?: string; error?: string };
  cleanOldSnapshots: (retentionCount?: number) => number;
  checkIdempotency: (key: string) => boolean;
};

let tmpDir = '';
let mod: ArchiveModule;

// Helper to write NDJSON event lines to the events file.
function writeEvents(eventsPath: string, events: EventRecord[]) {
  fs.writeFileSync(eventsPath, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8');
}

// Minimal HydraStateShape stub for tests.
function makeState(overrides: Partial<HydraStateShape> = {}): HydraStateShape {
  return {
    schemaVersion: 1,
    project: 'test',
    updatedAt: new Date().toISOString(),
    activeSession: null,
    agents: { gemini: {} as never, codex: {} as never, claude: {} as never },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
    deadLetter: [],
    ...overrides,
  };
}

describe('daemon/archive unit tests', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-archive-unit-'));
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'hydra-archive-test', version: '0.0.1' }),
      'utf8',
    );
    process.env['HYDRA_PROJECT'] = tmpDir;
    mod = (await import('../lib/daemon/archive.ts')) as ArchiveModule;
  });

  after(() => {
    if (tmpDir !== '') {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
    delete process.env['HYDRA_PROJECT'];
  });

  beforeEach(() => {
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    if (fs.existsSync(coordDir)) {
      fs.rmSync(coordDir, { recursive: true, force: true });
    }
    fs.mkdirSync(coordDir, { recursive: true });
    // Bootstrap state file (readState() needs it)
    const defaultState = {
      schemaVersion: 1,
      project: 'hydra-archive-test',
      updatedAt: new Date().toISOString(),
      activeSession: null,
      agents: { gemini: {}, codex: {}, claude: {} },
      tasks: [],
      decisions: [],
      blockers: [],
      handoffs: [],
      deadLetter: [],
    };
    fs.writeFileSync(
      path.join(coordDir, 'AI_SYNC_STATE.json'),
      `${JSON.stringify(defaultState, null, 2)}\n`,
      'utf8',
    );
  });

  // ── readEvents ────────────────────────────────────────────────────────────

  describe('readEvents', () => {
    it('returns empty array when events file does not exist', () => {
      const result = mod.readEvents();
      assert.deepEqual(result, []);
    });

    it('returns parsed events from NDJSON file', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      const events: EventRecord[] = [
        { seq: 1, at: '2024-01-01T00:00:00Z', type: 'test' },
        { seq: 2, at: '2024-01-01T00:01:00Z', type: 'test2' },
      ];
      writeEvents(eventsPath, events);

      const result = mod.readEvents();
      assert.equal(result.length, 2);
      assert.equal(result.at(0)?.seq, 1);
      assert.equal(result.at(1)?.seq, 2);
    });

    it('limits results to the requested count (last N lines)', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      const events: EventRecord[] = Array.from({ length: 20 }, (_, i) => ({
        seq: i + 1,
        at: '2024-01-01T00:00:00Z',
        type: 'test',
      }));
      writeEvents(eventsPath, events);

      const result = mod.readEvents(5);
      assert.equal(result.length, 5);
      assert.equal(result.at(0)?.seq, 16); // last 5 of 20
    });

    it('skips malformed lines without throwing', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      fs.writeFileSync(
        eventsPath,
        `not-json\n{"seq":1,"at":"2024-01-01T00:00:00Z","type":"ok"}\nbroken\n`,
        'utf8',
      );

      const result = mod.readEvents();
      assert.equal(result.length, 1);
      assert.equal(result.at(0)?.seq, 1);
    });

    it('clamps limit to max of 500', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      const events: EventRecord[] = Array.from({ length: 600 }, (_, i) => ({
        seq: i + 1,
        at: '2024-01-01T00:00:00Z',
        type: 'test',
      }));
      writeEvents(eventsPath, events);

      const result = mod.readEvents(1000);
      assert.ok(result.length <= 500, `Expected <= 500, got ${String(result.length)}`);
    });
  });

  // ── readArchive / writeArchive ────────────────────────────────────────────

  describe('readArchive', () => {
    it('returns empty archive when file does not exist', () => {
      const result = mod.readArchive();
      assert.deepEqual(result, { tasks: [], handoffs: [], blockers: [] });
    });

    it('returns parsed archive from file', () => {
      const archivePath = path.join(tmpDir, 'docs', 'coordination', 'AI_SYNC_ARCHIVE.json');
      const archive: ArchiveState = {
        tasks: [{ id: 't1', status: 'done' } as unknown as TaskEntry],
        handoffs: [],
        blockers: [],
        archivedAt: '2024-01-01T00:00:00Z',
      };
      fs.writeFileSync(archivePath, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');

      const result = mod.readArchive();
      assert.equal(result.tasks.length, 1);
      assert.equal(result.tasks.at(0)?.id, 't1');
    });

    it('returns empty archive when file is malformed JSON', () => {
      const archivePath = path.join(tmpDir, 'docs', 'coordination', 'AI_SYNC_ARCHIVE.json');
      fs.writeFileSync(archivePath, 'not-json', 'utf8');

      const result = mod.readArchive();
      assert.deepEqual(result, { tasks: [], handoffs: [], blockers: [] });
    });
  });

  describe('writeArchive', () => {
    it('writes archive to disk and sets archivedAt', () => {
      const archive: ArchiveState = { tasks: [], handoffs: [], blockers: [] };
      mod.writeArchive(archive);

      const archivePath = path.join(tmpDir, 'docs', 'coordination', 'AI_SYNC_ARCHIVE.json');
      assert.ok(fs.existsSync(archivePath));
      const written = JSON.parse(fs.readFileSync(archivePath, 'utf8')) as ArchiveState;
      assert.ok(typeof written.archivedAt === 'string' && written.archivedAt.length > 0);
    });
  });

  // ── archiveState ──────────────────────────────────────────────────────────

  describe('archiveState', () => {
    it('returns 0 when nothing needs archiving', () => {
      const state = makeState({ tasks: [{ id: 't1', status: 'pending' } as unknown as TaskEntry] });

      const moved = mod.archiveState(state);
      assert.equal(moved, 0);
      assert.equal(state.tasks.length, 1, 'active task should remain');
    });

    it('moves completed tasks to archive', () => {
      const state = makeState({
        tasks: [
          { id: 't1', status: 'done' } as unknown as TaskEntry,
          { id: 't2', status: 'pending' } as unknown as TaskEntry,
        ],
      });

      const moved = mod.archiveState(state);
      assert.ok(moved >= 1);
      assert.equal(state.tasks.length, 1, 'only pending task should remain');
      assert.equal(state.tasks.at(0)?.id, 't2');

      const archive = mod.readArchive();
      assert.equal(archive.tasks.length, 1);
      assert.equal(archive.tasks.at(0)?.id, 't1');
    });

    it('moves resolved blockers to archive', () => {
      const state = makeState({
        blockers: [{ id: 'b1', status: 'resolved' } as unknown as BlockerEntry],
      });

      const moved = mod.archiveState(state);
      assert.ok(moved >= 1);
      assert.equal(state.blockers.length, 0);
    });

    it('prunes blockedBy references for completed tasks', () => {
      const state = makeState({
        tasks: [
          { id: 't1', status: 'done' } as unknown as TaskEntry,
          { id: 't2', status: 'pending', blockedBy: ['t1'] } as unknown as TaskEntry,
        ],
      });

      mod.archiveState(state);
      const remaining = state.tasks.find((t) => t.id === 't2');
      assert.ok(remaining);
      assert.deepEqual((remaining as unknown as { blockedBy: string[] }).blockedBy, []);
    });

    // ── handoff archiving ───────────────────────────────────────────────────

    it('archives acknowledged handoffs older than 1 hour', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const state = makeState({
        handoffs: [
          {
            id: 'h1',
            from: 'gemini',
            to: 'codex',
            summary: 'Old handoff',
            createdAt: twoHoursAgo,
            acknowledgedAt: twoHoursAgo,
          } as HandoffEntry,
        ],
      });

      const moved = mod.archiveState(state);
      assert.ok(moved >= 1);
      assert.equal(state.handoffs.length, 0, 'handoff should be removed from active state');

      const archive = mod.readArchive();
      assert.equal(archive.handoffs.length, 1);
      assert.equal(archive.handoffs.at(0)?.id, 'h1');
    });

    it('does not archive a recently acknowledged handoff (< 1 hour ago)', () => {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const state = makeState({
        handoffs: [
          {
            id: 'h2',
            from: 'gemini',
            to: 'codex',
            summary: 'Recent handoff',
            createdAt: fiveMinutesAgo,
            acknowledgedAt: fiveMinutesAgo,
          } as HandoffEntry,
        ],
      });

      const moved = mod.archiveState(state);
      assert.equal(moved, 0);
      assert.equal(state.handoffs.length, 1, 'recent handoff should stay in active state');
    });

    it('does not archive an unacknowledged handoff', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const state = makeState({
        handoffs: [
          {
            id: 'h3',
            from: 'gemini',
            to: 'codex',
            summary: 'Pending handoff',
            createdAt: twoHoursAgo,
            acknowledgedAt: null,
          } as HandoffEntry,
        ],
      });

      const moved = mod.archiveState(state);
      assert.equal(moved, 0);
      assert.equal(state.handoffs.length, 1, 'unacknowledged handoff should stay in active state');
    });
  });

  // ── truncateEventsFile ────────────────────────────────────────────────────

  describe('truncateEventsFile', () => {
    it('returns 0 when events file does not exist', () => {
      const result = mod.truncateEventsFile();
      assert.equal(result, 0);
    });

    it('returns 0 when file has fewer lines than maxLines', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      writeEvents(eventsPath, [
        { seq: 1, at: '2024-01-01T00:00:00Z', type: 'test' },
        { seq: 2, at: '2024-01-01T00:00:00Z', type: 'test' },
      ]);

      const result = mod.truncateEventsFile(500);
      assert.equal(result, 0);
    });

    it('truncates file to last maxLines lines and returns removed count', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      const events: EventRecord[] = Array.from({ length: 20 }, (_, i) => ({
        seq: i + 1,
        at: '2024-01-01T00:00:00Z',
        type: 'test',
      }));
      writeEvents(eventsPath, events);

      const removed = mod.truncateEventsFile(10);
      assert.equal(removed, 10);

      const remaining = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
      assert.equal(remaining.length, 10);
      const first = JSON.parse(remaining.at(0) ?? '{}') as EventRecord;
      assert.equal(first.seq, 11); // last 10 of 20
    });
  });

  // ── createSnapshot ────────────────────────────────────────────────────────

  describe('createSnapshot', () => {
    it('creates a snapshot file and returns ok:true with filename', () => {
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      fs.writeFileSync(eventsPath, '', 'utf8');

      const result = mod.createSnapshot();
      assert.ok(result.ok, `Expected ok:true, got: ${result.error ?? 'unknown'}`);
      assert.ok(typeof result.filename === 'string' && result.filename.startsWith('snapshot_'));

      const snapshotDir = path.join(tmpDir, 'docs', 'coordination', 'snapshots');
      assert.ok(fs.existsSync(path.join(snapshotDir, result.filename ?? '')));
    });

    it('creates snapshot dir if it does not exist', () => {
      const snapshotDir = path.join(tmpDir, 'docs', 'coordination', 'snapshots');
      if (fs.existsSync(snapshotDir)) {
        fs.rmSync(snapshotDir, { recursive: true });
      }
      const eventsPath = path.join(tmpDir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson');
      fs.writeFileSync(eventsPath, '', 'utf8');

      const result = mod.createSnapshot();
      assert.ok(result.ok);
      assert.ok(fs.existsSync(snapshotDir));
    });
  });

  // ── cleanOldSnapshots ─────────────────────────────────────────────────────

  describe('cleanOldSnapshots', () => {
    it('returns 0 when snapshot dir does not exist', () => {
      const result = mod.cleanOldSnapshots();
      assert.equal(result, 0);
    });

    it('deletes oldest snapshots beyond retention count', () => {
      const snapshotDir = path.join(tmpDir, 'docs', 'coordination', 'snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });
      for (let i = 0; i < 8; i++) {
        fs.writeFileSync(
          path.join(snapshotDir, `snapshot_${String(i)}_${String(i)}.json`),
          '{}',
          'utf8',
        );
      }

      const deleted = mod.cleanOldSnapshots(5);
      assert.equal(deleted, 3);

      const remaining = fs.readdirSync(snapshotDir).filter((f) => f.endsWith('.json'));
      assert.equal(remaining.length, 5);
    });

    it('does not delete if count is at or below retention', () => {
      const snapshotDir = path.join(tmpDir, 'docs', 'coordination', 'snapshots');
      fs.mkdirSync(snapshotDir, { recursive: true });
      for (let i = 0; i < 3; i++) {
        fs.writeFileSync(
          path.join(snapshotDir, `snapshot_${String(i)}_${String(i)}.json`),
          '{}',
          'utf8',
        );
      }

      const deleted = mod.cleanOldSnapshots(5);
      assert.equal(deleted, 0);
    });
  });

  // ── checkIdempotency ──────────────────────────────────────────────────────

  describe('checkIdempotency', () => {
    it('returns false for a new key and registers it', () => {
      const key = `idem-test-${String(Date.now())}-${String(Math.random())}`;
      const result = mod.checkIdempotency(key);
      assert.equal(result, false);
    });

    it('returns true for a duplicate key', () => {
      const key = `idem-dup-${String(Date.now())}-${String(Math.random())}`;
      mod.checkIdempotency(key); // register
      const result = mod.checkIdempotency(key); // duplicate
      assert.equal(result, true);
    });

    it('returns false for an empty string key', () => {
      const result = mod.checkIdempotency('');
      assert.equal(result, false);
    });
  });
});
