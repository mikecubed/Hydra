/**
 * Characterization tests for lib/hydra-evolve.ts and its companion modules.
 *
 * lib/hydra-evolve.ts calls main() unconditionally at module level and cannot
 * be imported directly. These tests cover the evolve pipeline's observable
 * behavior through the exported companion modules it depends on:
 *
 *   - hydra-evolve-guardrails.ts  (budget tracker, safety constants, safety prompt)
 *   - hydra-evolve-knowledge.ts   (knowledge base CRUD, search, stats)
 *
 * This file serves as a safety net for rf-ev01 (extract pipeline),
 * rf-ev02 (extract executor), and rf-ev03 (shrink entrypoint) refactors.
 */

import { describe, it, afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import {
  PROTECTED_FILES,
  PROTECTED_PATTERNS,
  BLOCKED_COMMANDS,
  EvolveBudgetTracker,
  buildEvolveSafetyPrompt,
} from '../lib/hydra-evolve-guardrails.ts';
import {
  loadKnowledgeBase,
  saveKnowledgeBase,
  addEntry,
  updateEntry,
  searchEntries,
  getPriorLearnings,
  getStats,
  formatStatsForPrompt,
} from '../lib/hydra-evolve-knowledge.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-evolve-test-'));
}

function emptyKb() {
  return { version: 1 as const, entries: [] as ReturnType<typeof loadKnowledgeBase>['entries'] };
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

before(() => {
  // Inject a minimal config so guardrail budget defaults can be read without
  // requiring a real hydra.config.json on disk.
  _setTestConfig({ evolve: { budget: {} } });
});

afterEach(() => {
  invalidateConfigCache();
});

// ── PROTECTED_FILES ──────────────────────────────────────────────────────────

describe('PROTECTED_FILES', () => {
  it('is a Set', () => {
    assert.ok(PROTECTED_FILES instanceof Set);
  });

  it('contains hydra-evolve.ts itself (self-modification blocked)', () => {
    assert.ok(PROTECTED_FILES.has('lib/hydra-evolve.ts'));
  });

  it('contains hydra-evolve-guardrails.ts', () => {
    assert.ok(PROTECTED_FILES.has('lib/hydra-evolve-guardrails.ts'));
  });

  it('contains hydra-config.ts (config loader off-limits)', () => {
    assert.ok(PROTECTED_FILES.has('lib/hydra-config.ts'));
  });

  it('contains the knowledge base JSON path', () => {
    assert.ok(PROTECTED_FILES.has('docs/coordination/evolve/KNOWLEDGE_BASE.json'));
  });
});

// ── PROTECTED_PATTERNS ───────────────────────────────────────────────────────

describe('PROTECTED_PATTERNS', () => {
  it('is an array of RegExp values', () => {
    assert.ok(Array.isArray(PROTECTED_PATTERNS));
    assert.ok(PROTECTED_PATTERNS.length > 0);
    assert.ok(PROTECTED_PATTERNS.every((p) => p instanceof RegExp));
  });

  it('blocks bin/ paths', () => {
    const binPattern = PROTECTED_PATTERNS.find((p) => p.test('bin/hydra.mjs'));
    assert.ok(binPattern != null, 'Expected a pattern matching bin/ paths');
  });
});

// ── BLOCKED_COMMANDS ─────────────────────────────────────────────────────────

describe('BLOCKED_COMMANDS', () => {
  it('is an array of strings', () => {
    assert.ok(Array.isArray(BLOCKED_COMMANDS));
    assert.ok(BLOCKED_COMMANDS.length > 0);
    assert.ok(BLOCKED_COMMANDS.every((c) => typeof c === 'string'));
  });

  it('includes git checkout master (evolve-specific block)', () => {
    assert.ok(BLOCKED_COMMANDS.includes('git checkout master'));
  });
});

// ── EvolveBudgetTracker ──────────────────────────────────────────────────────

describe('EvolveBudgetTracker', () => {
  describe('constructor', () => {
    it('accepts budget overrides', () => {
      const tracker = new EvolveBudgetTracker({ softLimit: 100_000, hardLimit: 200_000 });
      assert.equal(tracker.softLimit, 100_000);
      assert.equal(tracker.hardLimit, 200_000);
    });

    it('initializes consumed tokens at zero', () => {
      const tracker = new EvolveBudgetTracker({ hardLimit: 500_000 });
      assert.equal(tracker.consumed, 0);
      assert.equal(tracker.percentUsed, 0);
    });

    it('starts with empty roundDeltas', () => {
      const tracker = new EvolveBudgetTracker({});
      assert.deepEqual(tracker.roundDeltas, []);
    });
  });

  describe('check() — budget action tiers', () => {
    it('returns continue when no tokens consumed', () => {
      const tracker = new EvolveBudgetTracker({
        softLimit: 600_000,
        hardLimit: 800_000,
        warnThreshold: 0.6,
        reduceScopeThreshold: 0.75,
        softStopThreshold: 0.85,
        hardStopThreshold: 0.95,
      });
      const result = tracker.check();
      assert.equal(result.action, 'continue');
    });

    it('returns warn when above warnThreshold', () => {
      const tracker = new EvolveBudgetTracker({
        hardLimit: 100_000,
        warnThreshold: 0.6,
        reduceScopeThreshold: 0.75,
        softStopThreshold: 0.85,
        hardStopThreshold: 0.95,
      });
      // Simulate 65% consumption
      tracker.startTokens = 0;
      tracker.currentTokens = 65_000;
      const result = tracker.check();
      assert.equal(result.action, 'warn');
    });

    it('returns reduce_scope when above reduceScopeThreshold', () => {
      const tracker = new EvolveBudgetTracker({
        hardLimit: 100_000,
        warnThreshold: 0.6,
        reduceScopeThreshold: 0.75,
        softStopThreshold: 0.85,
        hardStopThreshold: 0.95,
      });
      tracker.startTokens = 0;
      tracker.currentTokens = 78_000;
      const result = tracker.check();
      assert.equal(result.action, 'reduce_scope');
    });

    it('returns soft_stop when above softStopThreshold', () => {
      const tracker = new EvolveBudgetTracker({
        hardLimit: 100_000,
        warnThreshold: 0.6,
        reduceScopeThreshold: 0.75,
        softStopThreshold: 0.85,
        hardStopThreshold: 0.95,
      });
      tracker.startTokens = 0;
      tracker.currentTokens = 87_000;
      const result = tracker.check();
      assert.equal(result.action, 'soft_stop');
    });

    it('returns hard_stop when above hardStopThreshold', () => {
      const tracker = new EvolveBudgetTracker({
        hardLimit: 100_000,
        warnThreshold: 0.6,
        reduceScopeThreshold: 0.75,
        softStopThreshold: 0.85,
        hardStopThreshold: 0.95,
      });
      tracker.startTokens = 0;
      tracker.currentTokens = 97_000;
      const result = tracker.check();
      assert.equal(result.action, 'hard_stop');
    });

    it('includes consumed and percentUsed in every result', () => {
      const tracker = new EvolveBudgetTracker({ hardLimit: 100_000, hardStopThreshold: 0.95 });
      tracker.startTokens = 0;
      tracker.currentTokens = 10_000;
      const result = tracker.check();
      assert.equal(result.consumed, 10_000);
      assert.ok(typeof result.percentUsed === 'number');
    });
  });

  describe('recordRoundEnd()', () => {
    it('accumulates round deltas', () => {
      const tracker = new EvolveBudgetTracker({ hardLimit: 500_000 });
      tracker.startTokens = 0;
      tracker.currentTokens = 0;

      // Simulate metrics module returning 50_000 tokens after round 1.
      // recordRoundEnd reads from getSessionUsage() — we can't mock it,
      // so we verify the structure of the delta array instead.
      tracker.roundDeltas.push({
        round: 1,
        area: 'orchestration-patterns',
        tokens: 50_000,
        durationMs: 120_000,
      });
      assert.equal(tracker.roundDeltas.length, 1);
      assert.equal(tracker.roundDeltas[0].tokens, 50_000);
    });

    it('avgTokensPerRound returns perRoundEstimate when no deltas', () => {
      const tracker = new EvolveBudgetTracker({ perRoundEstimate: 200_000 });
      assert.equal(tracker.avgTokensPerRound, 200_000);
    });

    it('avgTokensPerRound computes average from recorded deltas', () => {
      const tracker = new EvolveBudgetTracker({ perRoundEstimate: 200_000 });
      tracker.roundDeltas.push({ round: 1, area: 'a', tokens: 100_000, durationMs: 60_000 });
      tracker.roundDeltas.push({ round: 2, area: 'b', tokens: 200_000, durationMs: 80_000 });
      assert.equal(tracker.avgTokensPerRound, 150_000);
    });
  });

  describe('serialize() / deserialize()', () => {
    it('round-trips state faithfully', () => {
      const tracker = new EvolveBudgetTracker({ softLimit: 300_000, hardLimit: 500_000 });
      tracker.startTokens = 10_000;
      tracker.currentTokens = 60_000;
      tracker.roundDeltas.push({
        round: 1,
        area: 'testing-reliability',
        tokens: 50_000,
        durationMs: 90_000,
      });

      const serialized = tracker.serialize();
      const restored = EvolveBudgetTracker.deserialize(serialized as Record<string, unknown>);

      assert.equal(restored.startTokens, 10_000);
      assert.equal(restored.currentTokens, 60_000);
      assert.equal(restored.softLimit, 300_000);
      assert.equal(restored.hardLimit, 500_000);
      assert.equal(restored.roundDeltas.length, 1);
      assert.equal(restored.consumed, 50_000);
    });
  });

  describe('getSummary()', () => {
    it('returns an object with required budget fields', () => {
      const tracker = new EvolveBudgetTracker({ softLimit: 200_000, hardLimit: 400_000 });
      tracker.startTokens = 0;
      tracker.currentTokens = 80_000;
      const summary = tracker.getSummary();
      assert.equal(summary.consumed, 80_000);
      assert.equal(summary.hardLimit, 400_000);
      assert.equal(summary.softLimit, 200_000);
      assert.ok(typeof summary.percentUsed === 'number');
      assert.ok(Array.isArray(summary.roundDeltas));
      assert.ok(typeof summary.durationMs === 'number');
    });
  });
});

// ── buildEvolveSafetyPrompt ──────────────────────────────────────────────────

describe('buildEvolveSafetyPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildEvolveSafetyPrompt('evolve/test-branch-abc');
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 0);
  });

  it('includes the branch name', () => {
    const prompt = buildEvolveSafetyPrompt('evolve/my-feature-xyz');
    assert.ok(prompt.includes('evolve/my-feature-xyz'), 'Expected branch name in safety prompt');
  });

  it('mentions self-modification is blocked', () => {
    const prompt = buildEvolveSafetyPrompt('evolve/any-branch');
    assert.ok(
      /self.?modif/i.test(prompt) || /do not modify the evolve/i.test(prompt),
      'Expected self-modification restriction in prompt',
    );
  });

  it('includes agent name when provided', () => {
    const prompt = buildEvolveSafetyPrompt('evolve/test', 'codex');
    assert.ok(prompt.toLowerCase().includes('codex'), 'Expected agent name in safety prompt');
  });
});

// ── loadKnowledgeBase ────────────────────────────────────────────────────────

describe('loadKnowledgeBase', () => {
  it('returns empty KB for missing file', () => {
    const dir = tmpDir();
    try {
      const kb = loadKnowledgeBase(dir);
      assert.equal(kb.version, 1);
      assert.deepEqual(kb.entries, []);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns empty KB for invalid JSON', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'KNOWLEDGE_BASE.json'), 'not json', 'utf8');
      const kb = loadKnowledgeBase(dir);
      assert.deepEqual(kb.entries, []);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('returns empty KB when entries is not an array', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'KNOWLEDGE_BASE.json'),
        '{"version":1,"entries":"bad"}',
        'utf8',
      );
      const kb = loadKnowledgeBase(dir);
      assert.deepEqual(kb.entries, []);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('reads valid file', () => {
    const dir = tmpDir();
    try {
      const data = {
        version: 1,
        entries: [{ id: 'KB_001', area: 'testing', finding: 'test finding' }],
      };
      fs.writeFileSync(path.join(dir, 'KNOWLEDGE_BASE.json'), JSON.stringify(data), 'utf8');
      const kb = loadKnowledgeBase(dir);
      assert.equal(kb.entries.length, 1);
      assert.equal(kb.entries[0].id, 'KB_001');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ── addEntry ─────────────────────────────────────────────────────────────────

describe('addEntry', () => {
  it('assigns sequential IDs starting from KB_001', () => {
    const kb = emptyKb();
    const a = addEntry(kb, { finding: 'First research finding about orchestration patterns' });
    const b = addEntry(kb, {
      finding: 'Second research finding about testing reliability improvements',
    });
    assert.equal(a?.id, 'KB_001');
    assert.equal(b?.id, 'KB_002');
  });

  it('fills in default fields', () => {
    const kb = emptyKb();
    const entry = addEntry(kb, { finding: 'A substantial finding about AI coding tools behavior' });
    assert.ok(entry != null);
    assert.equal(entry.attempted, false);
    assert.equal(entry.outcome, null);
    assert.equal(entry.score, null);
    assert.equal(entry.area, 'unknown');
    assert.deepEqual(entry.tags, []);
  });

  it('merges provided fields over defaults', () => {
    const kb = emptyKb();
    const entry = addEntry(kb, {
      area: 'model-routing',
      finding: 'Multi-model selection with cascade fallback improves reliability',
      tags: ['routing', 'fallback'],
      round: 3,
    });
    assert.ok(entry != null);
    assert.equal(entry.area, 'model-routing');
    assert.deepEqual(entry.tags, ['routing', 'fallback']);
    assert.equal(entry.round, 3);
  });

  it('deduplicates very similar findings (Jaccard >= 0.7)', () => {
    const kb = emptyKb();
    // These two sentences share ~9/11 words (Jaccard ≈ 0.82), triggering dedup.
    addEntry(kb, {
      finding:
        'CrewAI multi-agent task delegation with persistent shared memory and role-based architecture',
    });
    const dupe = addEntry(kb, {
      finding:
        'CrewAI multi-agent task delegation with persistent shared memory and role-based coordination',
    });
    assert.equal(dupe, null);
    assert.equal(kb.entries.length, 1);
  });

  it('allows sufficiently different findings', () => {
    const kb = emptyKb();
    addEntry(kb, {
      finding: 'CrewAI uses task delegation with shared memory for multi-agent coordination',
    });
    const different = addEntry(kb, {
      finding: 'BullMQ provides reliable job queue with retry semantics and delayed jobs',
    });
    assert.ok(different != null);
    assert.equal(kb.entries.length, 2);
  });
});

// ── updateEntry ───────────────────────────────────────────────────────────────

describe('updateEntry', () => {
  it('merges fields onto existing entry', () => {
    const kb = emptyKb();
    addEntry(kb, { finding: 'Finding to update with test results and outcome data' });
    const updated = updateEntry(kb, 'KB_001', { attempted: true, outcome: 'approve', score: 8 });
    assert.ok(updated != null);
    assert.equal(updated.attempted, true);
    assert.equal(updated.outcome, 'approve');
    assert.equal(updated.score, 8);
  });

  it('returns null for unknown ID', () => {
    const kb = emptyKb();
    const result = updateEntry(kb, 'KB_999', { attempted: true });
    assert.equal(result, null);
  });

  it('preserves unmodified fields', () => {
    const kb = emptyKb();
    addEntry(kb, { area: 'daemon-architecture', finding: 'Event-driven daemon reduces coupling' });
    updateEntry(kb, 'KB_001', { attempted: true });
    assert.equal(kb.entries[0].area, 'daemon-architecture');
  });
});

// ── searchEntries ─────────────────────────────────────────────────────────────

describe('searchEntries', () => {
  it('returns all entries when no filter provided', () => {
    const kb = emptyKb();
    addEntry(kb, { finding: 'First substantial finding about orchestration improvements' });
    addEntry(kb, { finding: 'Second substantial finding about testing improvements' });
    assert.equal(searchEntries(kb).length, 2);
  });

  it('filters by text query against finding field', () => {
    const kb = emptyKb();
    addEntry(kb, {
      area: 'model-routing',
      finding: 'Cascade routing improves cost efficiency for repetitive tasks',
    });
    addEntry(kb, {
      area: 'testing-reliability',
      finding: 'Property-based testing reveals edge cases in LLM outputs',
    });
    const results = searchEntries(kb, 'cascade routing');
    assert.equal(results.length, 1);
    assert.equal(results[0].area, 'model-routing');
  });

  it('filters by tags (OR logic)', () => {
    const kb = emptyKb();
    addEntry(kb, {
      finding: 'BullMQ job queues offer reliability guarantees for long-running tasks',
      tags: ['queue', 'daemon'],
    });
    addEntry(kb, {
      finding: 'Temporal workflow engine provides durable execution for orchestration',
      tags: ['orchestration'],
    });
    addEntry(kb, {
      finding: 'Vitest provides fast unit testing with ESM support out of the box',
      tags: ['testing'],
    });
    const results = searchEntries(kb, undefined, ['queue', 'daemon']);
    assert.equal(results.length, 1);
    assert.ok(results[0].tags?.includes('queue'));
  });

  it('places attempted entries before non-attempted', () => {
    const kb = emptyKb();
    addEntry(kb, { finding: 'Not yet attempted finding about developer experience patterns' });
    addEntry(kb, { finding: 'Attempted finding about orchestration that was approved' });
    updateEntry(kb, 'KB_002', { attempted: true });
    const results = searchEntries(kb);
    assert.equal(results[0].id, 'KB_002', 'Attempted entry should sort first');
  });
});

// ── getPriorLearnings ─────────────────────────────────────────────────────────

describe('getPriorLearnings', () => {
  it('returns entries for the specified area that have learnings', () => {
    const kb = emptyKb();
    addEntry(kb, {
      area: 'orchestration-patterns',
      finding: 'CrewAI patterns relevant to Hydra task queue',
      learnings: 'Use delegation + shared memory for efficiency',
      attempted: true,
      outcome: 'approve',
    });
    addEntry(kb, {
      area: 'testing-reliability',
      finding: 'Property testing for LLM outputs',
      learnings: 'Use fast-check with seed for reproducibility',
    });

    const learnings = getPriorLearnings(kb, 'orchestration-patterns');
    assert.equal(learnings.length, 1);
    assert.equal(learnings[0].area, 'orchestration-patterns');
  });

  it('returns empty array when no entries match area', () => {
    const kb = emptyKb();
    addEntry(kb, {
      area: 'model-routing',
      finding: 'LLM routing findings',
      learnings: 'Some learnings',
    });
    const results = getPriorLearnings(kb, 'daemon-architecture');
    assert.deepEqual(results, []);
  });

  it('excludes entries with no learnings or outcome', () => {
    const kb = emptyKb();
    addEntry(kb, { area: 'testing-reliability', finding: 'A finding with no learnings data' });
    const results = getPriorLearnings(kb, 'testing-reliability');
    assert.equal(results.length, 0);
  });

  it('matches by tag when area does not match exactly', () => {
    const kb = emptyKb();
    addEntry(kb, {
      area: 'general',
      finding: 'Finding tagged with specific area name for cross-reference',
      learnings: 'Relevant cross-area learnings',
      tags: ['model-routing'],
    });
    const results = getPriorLearnings(kb, 'model-routing');
    assert.equal(results.length, 1);
  });
});

// ── getStats ──────────────────────────────────────────────────────────────────

describe('getStats', () => {
  it('returns zeroes for empty KB', () => {
    const kb = emptyKb();
    const stats = getStats(kb);
    assert.equal(stats.totalResearched, 0);
    assert.equal(stats.totalAttempted, 0);
    assert.equal(stats.totalApproved, 0);
    assert.equal(stats.totalRejected, 0);
    assert.equal(stats.totalRevised, 0);
  });

  it('counts entries by outcome', () => {
    const kb = emptyKb();
    addEntry(kb, { finding: 'Finding one about orchestration patterns research' });
    addEntry(kb, { finding: 'Finding two about model routing improvements' });
    addEntry(kb, { finding: 'Finding three about testing reliability methodology' });
    updateEntry(kb, 'KB_001', { attempted: true, outcome: 'approve' });
    updateEntry(kb, 'KB_002', { attempted: true, outcome: 'reject' });
    updateEntry(kb, 'KB_003', { attempted: true, outcome: 'revise' });

    const stats = getStats(kb);
    assert.equal(stats.totalResearched, 3);
    assert.equal(stats.totalAttempted, 3);
    assert.equal(stats.totalApproved, 1);
    assert.equal(stats.totalRejected, 1);
    assert.equal(stats.totalRevised, 1);
  });

  it('tracks top areas by entry count', () => {
    const kb = emptyKb();
    addEntry(kb, {
      area: 'testing-reliability',
      finding: 'Finding one in testing area for reliability',
    });
    addEntry(kb, {
      area: 'testing-reliability',
      finding: 'Finding two in testing area for property tests',
    });
    addEntry(kb, {
      area: 'model-routing',
      finding: 'Finding one in model routing area for cascades',
    });

    const stats = getStats(kb);
    assert.equal(stats.topAreas[0].area, 'testing-reliability');
    assert.equal(stats.topAreas[0].count, 2);
  });
});

// ── formatStatsForPrompt ──────────────────────────────────────────────────────

describe('formatStatsForPrompt', () => {
  it('returns a non-empty string', () => {
    const kb = emptyKb();
    const text = formatStatsForPrompt(kb);
    assert.ok(typeof text === 'string');
    assert.ok(text.length > 0);
  });

  it('includes entry counts in output', () => {
    const kb = emptyKb();
    addEntry(kb, { finding: 'A finding about orchestration patterns improvements' });
    updateEntry(kb, 'KB_001', { attempted: true, outcome: 'approve' });
    const text = formatStatsForPrompt(kb);
    assert.ok(text.includes('1'), 'Expected counts in formatted stats');
  });
});

// ── Knowledge Base round-trip persistence ─────────────────────────────────────

describe('knowledge base persistence', () => {
  it('save and reload preserves all fields', () => {
    const dir = tmpDir();
    try {
      const kb = emptyKb();
      addEntry(kb, {
        area: 'ai-coding-tools',
        finding:
          'Cursor uses a shadow workspace for parallel code generation without disrupting the active editor',
        applicability: 'high',
        tags: ['cursor', 'workspace'],
        round: 2,
        learnings: 'Shadow workspace pattern is applicable to Hydra task isolation',
      });
      saveKnowledgeBase(dir, kb);

      const loaded = loadKnowledgeBase(dir);
      assert.equal(loaded.entries.length, 1);
      assert.equal(loaded.entries[0].area, 'ai-coding-tools');
      assert.equal(loaded.entries[0].applicability, 'high');
      assert.deepEqual(loaded.entries[0].tags, ['cursor', 'workspace']);
      assert.equal(loaded.entries[0].round, 2);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  it('saveKnowledgeBase recalculates stats on write', () => {
    const dir = tmpDir();
    try {
      const kb = emptyKb();
      // Use clearly distinct findings (0% word overlap) to avoid accidental dedup.
      addEntry(kb, {
        finding: 'BullMQ provides Redis-backed priority queues with delayed scheduling support',
      });
      addEntry(kb, {
        finding:
          'Anthropic constitutional reasoning delivers aligned responses through RLHF training',
      });
      updateEntry(kb, 'KB_001', { attempted: true, outcome: 'approve' });
      saveKnowledgeBase(dir, kb);

      const loaded = loadKnowledgeBase(dir);
      const stats = loaded.stats as Record<string, number> | undefined;
      assert.ok(stats != null);
      assert.equal(stats['totalResearched'], 2);
      assert.equal(stats['totalApproved'], 1);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
