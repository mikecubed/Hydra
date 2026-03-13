/**
 * Unit tests for lib/daemon/state.ts — pure state management functions
 * extracted from orchestrator-daemon.ts.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HydraStateShape } from '../lib/types.ts';

type EventRecord = { seq: number; at: string; type: string; category?: string; payload?: unknown };

type StateModule = {
  nowIso: () => string;
  toSessionId: (date?: Date) => string;
  createAgentRecord: () => Record<string, unknown>;
  createDefaultState: () => HydraStateShape;
  normalizeState: (raw: unknown) => HydraStateShape;
  ensureCoordFiles: () => void;
  readState: () => HydraStateShape;
  writeState: (state: Record<string, unknown>) => HydraStateShape;
  appendSyncLog: (entry: string) => void;
  initEventSeq: () => void;
  categorizeEvent: (type: string, payload: unknown) => string;
  appendEvent: (type: string, payload?: unknown) => void;
  replayEvents: (fromSeq?: number) => EventRecord[];
};

let tmpDir = '';
let mod: StateModule;

describe('daemon/state unit tests', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-state-unit-'));
    // Create a package.json so resolveProject() accepts this as a valid project dir
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'hydra-state-test', version: '0.0.1' }),
      'utf8',
    );
    process.env['HYDRA_PROJECT'] = tmpDir;
    // Dynamic import after env is set so resolveProject() picks up tmpDir
    mod = (await import('../lib/daemon/state.ts')) as StateModule;
  });

  after(() => {
    if (tmpDir !== '') {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
    delete process.env['HYDRA_PROJECT'];
  });

  beforeEach(() => {
    // Wipe coord dir before each test for isolation
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    if (fs.existsSync(coordDir)) {
      fs.rmSync(coordDir, { recursive: true, force: true });
    }
    // Reset event sequence to 0 by re-initialising against the (now missing) events file
    mod.initEventSeq();
  });

  // ── nowIso ────────────────────────────────────────────────────────────

  it('nowIso() returns a valid ISO-8601 UTC string', () => {
    const ts = mod.nowIso();
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
    assert.ok(Number.isFinite(new Date(ts).getTime()));
  });

  // ── toSessionId ───────────────────────────────────────────────────────

  it('toSessionId() produces SYNC_YYYYMMDD_HHMMSS format', () => {
    const d = new Date('2025-06-15T10:30:45.000Z');
    const id = mod.toSessionId(d);
    assert.match(id, /^SYNC_\d{8}_\d{6}$/);
  });

  it('toSessionId() starts with SYNC_', () => {
    assert.ok(mod.toSessionId().startsWith('SYNC_'));
  });

  it('toSessionId() uses current date when no argument is supplied', () => {
    const id = mod.toSessionId();
    assert.match(id, /^SYNC_\d{8}_\d{6}$/);
  });

  // ── createAgentRecord ─────────────────────────────────────────────────

  it('createAgentRecord() has required fields with correct defaults', () => {
    const rec = mod.createAgentRecord();
    assert.equal(rec['installed'], null);
    assert.equal(rec['path'], '');
    assert.equal(rec['version'], '');
    assert.equal(rec['lastCheckedAt'], null);
  });

  // ── createDefaultState ────────────────────────────────────────────────

  it('createDefaultState() returns a valid HydraStateShape', () => {
    const state = mod.createDefaultState();
    assert.equal(state.schemaVersion, 1);
    assert.ok(Array.isArray(state.tasks));
    assert.ok(Array.isArray(state.handoffs));
    assert.ok(Array.isArray(state.blockers));
    assert.ok(Array.isArray(state.decisions));
  });

  it('createDefaultState() starts with all arrays empty', () => {
    const state = mod.createDefaultState();
    assert.equal(state.tasks.length, 0);
    assert.equal(state.handoffs.length, 0);
    assert.equal(state.blockers.length, 0);
    assert.equal(state.decisions.length, 0);
  });

  it('createDefaultState() includes agents for gemini/codex/claude', () => {
    const state = mod.createDefaultState();
    const agents = state['agents'] as Record<string, unknown>;
    assert.ok('gemini' in agents, 'missing gemini');
    assert.ok('codex' in agents, 'missing codex');
    assert.ok('claude' in agents, 'missing claude');
  });

  it('createDefaultState() has null activeSession', () => {
    const state = mod.createDefaultState();
    assert.equal(state.activeSession, null);
  });

  // ── normalizeState ────────────────────────────────────────────────────

  it('normalizeState(null) returns default-shaped state', () => {
    const state = mod.normalizeState(null);
    assert.ok(Array.isArray(state.tasks));
    assert.equal(state.tasks.length, 0);
    assert.equal(state.schemaVersion, 1);
  });

  it('normalizeState() merges provided tasks array', () => {
    const task = { id: 'T001', status: 'todo', title: 'Test task' };
    const state = mod.normalizeState({ tasks: [task] });
    assert.equal(state.tasks.length, 1);
    assert.equal(state.tasks[0].id, 'T001');
  });

  it('normalizeState() replaces non-array tasks with empty array', () => {
    const state = mod.normalizeState({ tasks: 'not-an-array' });
    assert.ok(Array.isArray(state.tasks));
    assert.equal(state.tasks.length, 0);
  });

  it('normalizeState() fills missing schemaVersion from defaults', () => {
    const state = mod.normalizeState({});
    assert.equal(state.schemaVersion, 1);
  });

  // ── readState / writeState ────────────────────────────────────────────

  it('readState() returns default state when no file exists', () => {
    const state = mod.readState();
    assert.ok(Array.isArray(state.tasks));
    assert.equal(state.tasks.length, 0);
  });

  it('writeState() persists data retrievable by readState()', () => {
    const initial = mod.readState();
    const modified = {
      ...initial,
      tasks: [{ id: 'T001', title: 'Persisted', status: 'todo', owner: 'codex' }],
    };
    mod.writeState(modified as unknown as Record<string, unknown>);
    const loaded = mod.readState();
    assert.equal(loaded.tasks.length, 1);
    assert.equal(loaded.tasks[0].id, 'T001');
  });

  it('writeState() updates updatedAt timestamp on the returned state', () => {
    const initial = mod.readState();
    const beforeTs = initial.updatedAt ?? '';
    // Ensure at least 1 ms passes
    const start = Date.now();
    while (Date.now() - start < 2);
    const returned = mod.writeState(initial as unknown as Record<string, unknown>);
    assert.ok(
      returned.updatedAt !== undefined && returned.updatedAt >= beforeTs,
      'updatedAt should be >= previous value',
    );
  });

  // ── appendSyncLog ─────────────────────────────────────────────────────

  it('appendSyncLog() appends a line containing the entry text', () => {
    mod.ensureCoordFiles();
    mod.appendSyncLog('my-test-entry-xyz');
    const coordDir = path.join(tmpDir, 'docs', 'coordination');
    const logPath = path.join(coordDir, 'AI_SYNC_LOG.md');
    const contents = fs.readFileSync(logPath, 'utf8');
    assert.ok(contents.includes('my-test-entry-xyz'));
  });

  // ── categorizeEvent ───────────────────────────────────────────────────

  it('categorizeEvent("mutation", {label:"task:add"}) returns "task"', () => {
    assert.equal(mod.categorizeEvent('mutation', { label: 'task:add' }), 'task');
  });

  it('categorizeEvent("mutation", {label:"handoff:create"}) returns "handoff"', () => {
    assert.equal(mod.categorizeEvent('mutation', { label: 'handoff:create' }), 'handoff');
  });

  it('categorizeEvent("daemon_start", null) returns "system"', () => {
    assert.equal(mod.categorizeEvent('daemon_start', null), 'system');
  });

  it('categorizeEvent("concierge:reply", {}) returns "concierge"', () => {
    assert.equal(mod.categorizeEvent('concierge:reply', {}), 'concierge');
  });

  it('categorizeEvent("verification_start", null) returns "task"', () => {
    assert.equal(mod.categorizeEvent('verification_start', null), 'task');
  });

  // ── appendEvent / replayEvents ────────────────────────────────────────

  it('replayEvents() returns empty array when events file does not exist', () => {
    const events = mod.replayEvents(0);
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 0);
  });

  it('appendEvent() creates events that replayEvents() can retrieve', () => {
    mod.ensureCoordFiles();
    mod.appendEvent('daemon_start');
    const events = mod.replayEvents(0);
    assert.ok(events.length >= 1);
    assert.equal(events.at(-1)?.type, 'daemon_start');
  });

  it('appendEvent() increments sequence numbers monotonically', () => {
    mod.ensureCoordFiles();
    mod.appendEvent('a');
    mod.appendEvent('b');
    mod.appendEvent('c');
    const events = mod.replayEvents(0);
    assert.ok(events.length >= 3);
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].seq > events[i - 1].seq, 'seq must be monotonically increasing');
    }
  });

  it('replayEvents(fromSeq) filters out events below fromSeq', () => {
    mod.ensureCoordFiles();
    mod.appendEvent('e1');
    mod.appendEvent('e2');
    mod.appendEvent('e3');
    const all = mod.replayEvents(0);
    assert.ok(all.length >= 3);
    const cutoff = all[1].seq; // second event's seq
    const subset = mod.replayEvents(cutoff);
    assert.ok(subset.every((e) => e.seq >= cutoff));
    assert.ok(subset.length < all.length);
  });

  it('appendEvent() stores category on each event', () => {
    mod.ensureCoordFiles();
    mod.appendEvent('daemon_start');
    const events = mod.replayEvents(0);
    const last = events.at(-1);
    assert.ok(last.category !== undefined && last.category !== '');
  });
});
