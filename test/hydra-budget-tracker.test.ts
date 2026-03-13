import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BudgetTracker,
  type BudgetTrackerData,
  type Threshold,
} from '../lib/hydra-shared/budget-tracker.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTracker(overrides: Partial<ConstructorParameters<typeof BudgetTracker>[0]> = {}) {
  return new BudgetTracker({
    softLimit: 80_000,
    hardLimit: 100_000,
    unitEstimate: 5_000,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Constructor defaults
// ---------------------------------------------------------------------------

describe('BudgetTracker — constructor', () => {
  it('stores softLimit, hardLimit, unitEstimate', () => {
    const t = makeTracker();
    assert.equal(t.softLimit, 80_000);
    assert.equal(t.hardLimit, 100_000);
    assert.equal(t.unitEstimate, 5_000);
  });

  it('defaults unitLabel to "task"', () => {
    const t = makeTracker();
    assert.equal(t.unitLabel, 'task');
  });

  it('stores a custom unitLabel', () => {
    const t = makeTracker({ unitLabel: 'round' });
    assert.equal(t.unitLabel, 'round');
  });

  it('defaults thresholds to []', () => {
    const t = makeTracker();
    assert.deepEqual(t.thresholds, []);
  });

  it('stores custom thresholds', () => {
    const thresholds: Threshold[] = [{ pct: 0.9, action: 'warn', reason: 'at {pct}%' }];
    const t = makeTracker({ thresholds });
    assert.equal(t.thresholds.length, 1);
    assert.equal(t.thresholds[0].action, 'warn');
  });

  it('initialises startTokens and currentTokens to 0', () => {
    const t = makeTracker();
    assert.equal(t.startTokens, 0);
    assert.equal(t.currentTokens, 0);
  });

  it('initialises unitDeltas to []', () => {
    const t = makeTracker();
    assert.deepEqual(t.unitDeltas, []);
  });

  it('initialises _firedOnce as an empty Set', () => {
    const t = makeTracker();
    assert.ok(t._firedOnce instanceof Set);
    assert.equal(t._firedOnce.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

describe('BudgetTracker — consumed getter', () => {
  it('returns currentTokens minus startTokens', () => {
    const t = makeTracker();
    t.startTokens = 10_000;
    t.currentTokens = 50_000;
    assert.equal(t.consumed, 40_000);
  });

  it('returns 0 when both are equal', () => {
    const t = makeTracker();
    t.startTokens = 5_000;
    t.currentTokens = 5_000;
    assert.equal(t.consumed, 0);
  });
});

describe('BudgetTracker — percentUsed getter', () => {
  it('returns consumed / hardLimit as a fraction', () => {
    const t = makeTracker({ hardLimit: 100_000 });
    t.startTokens = 0;
    t.currentTokens = 50_000;
    assert.equal(t.percentUsed, 0.5);
  });

  it('returns 0 when hardLimit is 0', () => {
    const t = makeTracker({ hardLimit: 0 });
    t.startTokens = 0;
    t.currentTokens = 1_000;
    assert.equal(t.percentUsed, 0);
  });
});

describe('BudgetTracker — avgTokensPerUnit getter', () => {
  it('returns unitEstimate when no deltas', () => {
    const t = makeTracker({ unitEstimate: 3_000 });
    assert.equal(t.avgTokensPerUnit, 3_000);
  });

  it('returns average of unitDeltas.tokens (rounded)', () => {
    const t = makeTracker({ unitEstimate: 1_000 });
    t.unitDeltas = [
      { label: 'a', tokens: 10_000, durationMs: 500 },
      { label: 'b', tokens: 20_000, durationMs: 500 },
    ];
    assert.equal(t.avgTokensPerUnit, 15_000);
  });

  it('rounds fractional averages to integer', () => {
    const t = makeTracker({ unitEstimate: 1_000 });
    t.unitDeltas = [
      { label: 'a', tokens: 10_000, durationMs: 500 },
      { label: 'b', tokens: 10_001, durationMs: 500 },
      { label: 'c', tokens: 10_002, durationMs: 500 },
    ];
    assert.equal(typeof t.avgTokensPerUnit, 'number');
    assert.ok(Number.isInteger(t.avgTokensPerUnit));
  });
});

// ---------------------------------------------------------------------------
// check()
// ---------------------------------------------------------------------------

describe('BudgetTracker — check() — no threshold match', () => {
  it('returns action "continue" and "Budget OK" when no thresholds', () => {
    const t = makeTracker();
    t.startTokens = 0;
    t.currentTokens = 0;
    const result = t.check();
    assert.equal(result.action, 'continue');
    assert.equal(result.reason, 'Budget OK');
  });

  it('returns consumed and percentUsed in result', () => {
    const t = makeTracker({ hardLimit: 100_000 });
    t.startTokens = 0;
    t.currentTokens = 20_000;
    const result = t.check();
    assert.equal(result.consumed, 20_000);
    assert.equal(result.percentUsed, 0.2);
  });
});

describe('BudgetTracker — check() — threshold matching', () => {
  it('fires the first matching threshold in array order', () => {
    const thresholds: Threshold[] = [
      { pct: 0.8, action: 'hard_stop', reason: 'at {pct}%' },
      { pct: 0.5, action: 'warn', reason: 'halfway' },
    ];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 85_000; // 85%
    const result = t.check();
    assert.equal(result.action, 'hard_stop');
  });

  it('fires lower threshold when consumption is only past the lower one', () => {
    const thresholds: Threshold[] = [
      { pct: 0.9, action: 'hard_stop', reason: 'critical' },
      { pct: 0.5, action: 'warn', reason: 'halfway' },
    ];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 60_000; // 60%, only warn threshold triggered
    const result = t.check();
    assert.equal(result.action, 'warn');
  });

  it('interpolates {pct} in the reason template', () => {
    const thresholds: Threshold[] = [{ pct: 0.5, action: 'warn', reason: 'At {pct}% capacity' }];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 60_000;
    const result = t.check();
    assert.ok(result.reason.includes('60'), `reason: ${result.reason}`);
  });

  it('interpolates {consumed} in the reason template', () => {
    const thresholds: Threshold[] = [
      { pct: 0.5, action: 'warn', reason: 'Consumed {consumed} tokens' },
    ];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 50_000;
    const result = t.check();
    assert.ok(result.reason.includes('50'), `reason: ${result.reason}`);
  });
});

describe('BudgetTracker — check() — once semantics', () => {
  it('fires once:true threshold on first check', () => {
    const thresholds: Threshold[] = [
      { pct: 0.5, action: 'warn', reason: 'first time', once: true },
    ];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 60_000;
    const result = t.check();
    assert.equal(result.action, 'warn');
  });

  it('skips once:true threshold on second check', () => {
    const thresholds: Threshold[] = [{ pct: 0.5, action: 'warn', reason: 'once only', once: true }];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 60_000;
    t.check(); // first time — fires
    const second = t.check(); // second time — should skip
    assert.equal(second.action, 'continue');
  });

  it('fires non-once threshold every time', () => {
    const thresholds: Threshold[] = [{ pct: 0.5, action: 'warn', reason: 'always' }];
    const t = makeTracker({ hardLimit: 100_000, thresholds });
    t.startTokens = 0;
    t.currentTokens = 60_000;
    const r1 = t.check();
    const r2 = t.check();
    assert.equal(r1.action, 'warn');
    assert.equal(r2.action, 'warn');
  });
});

describe('BudgetTracker — check() — result shape', () => {
  it('includes canFitNext<CapLabel> key', () => {
    const t = makeTracker({ unitLabel: 'task', hardLimit: 100_000, unitEstimate: 5_000 });
    t.startTokens = 0;
    t.currentTokens = 0;
    const result = t.check();
    assert.ok('canFitNextTask' in result);
    assert.equal(typeof result['canFitNextTask'], 'boolean');
  });

  it('includes avgPer<CapLabel> key', () => {
    const t = makeTracker({ unitLabel: 'round', hardLimit: 100_000, unitEstimate: 5_000 });
    t.startTokens = 0;
    t.currentTokens = 0;
    const result = t.check();
    assert.ok('avgPerRound' in result);
  });
});

// ---------------------------------------------------------------------------
// getSummary()
// ---------------------------------------------------------------------------

describe('BudgetTracker — getSummary()', () => {
  it('includes <label>Deltas key based on unitLabel', () => {
    const t = makeTracker({ unitLabel: 'task' });
    const summary = t.getSummary();
    assert.ok('taskDeltas' in summary, `keys: ${Object.keys(summary).join(', ')}`);
  });

  it('includes avgPer<CapLabel> key based on unitLabel', () => {
    const t = makeTracker({ unitLabel: 'task' });
    const summary = t.getSummary();
    assert.ok('avgPerTask' in summary);
  });

  it('uses custom unitLabel in summary keys', () => {
    const t = makeTracker({ unitLabel: 'round' });
    const summary = t.getSummary();
    assert.ok('roundDeltas' in summary);
    assert.ok('avgPerRound' in summary);
  });

  it('includes consumed and percentUsed', () => {
    const t = makeTracker({ hardLimit: 100_000 });
    t.startTokens = 10_000;
    t.currentTokens = 30_000;
    const summary = t.getSummary();
    assert.equal(summary['consumed'], 20_000);
    assert.equal(summary['percentUsed'], 0.2);
  });
});

// ---------------------------------------------------------------------------
// serialize() / deserialize()
// ---------------------------------------------------------------------------

describe('BudgetTracker — serialize()', () => {
  it('includes all expected keys', () => {
    const t = makeTracker();
    const data = t.serialize();
    const keys = Object.keys(data);
    for (const k of [
      'startTokens',
      'currentTokens',
      'unitDeltas',
      'softLimit',
      'hardLimit',
      'unitEstimate',
      'unitLabel',
      '_startedAt',
      '_firedOnce',
    ]) {
      assert.ok(keys.includes(k), `Missing key: ${k}`);
    }
  });

  it('returns _firedOnce as an array', () => {
    const t = makeTracker();
    t._firedOnce.add('warn');
    const data = t.serialize();
    assert.ok(Array.isArray(data._firedOnce));
    assert.ok((data._firedOnce ?? []).includes('warn'));
  });

  it('serializes unitDeltas array', () => {
    const t = makeTracker();
    t.unitDeltas = [{ label: 'x', tokens: 1_000, durationMs: 100 }];
    const data = t.serialize();
    assert.equal((data.unitDeltas ?? []).length, 1);
  });
});

describe('BudgetTracker — deserialize()', () => {
  it('restores all numeric fields', () => {
    const t = makeTracker({ softLimit: 50_000, hardLimit: 100_000, unitEstimate: 2_000 });
    t.startTokens = 5_000;
    t.currentTokens = 15_000;
    const data = t.serialize();
    const restored = BudgetTracker.deserialize(data);
    assert.equal(restored.startTokens, 5_000);
    assert.equal(restored.currentTokens, 15_000);
    assert.equal(restored.softLimit, 50_000);
    assert.equal(restored.hardLimit, 100_000);
    assert.equal(restored.unitEstimate, 2_000);
  });

  it('restores _firedOnce as a Set', () => {
    const t = makeTracker();
    t._firedOnce.add('hard_stop');
    const data = t.serialize();
    const restored = BudgetTracker.deserialize(data);
    assert.ok(restored._firedOnce instanceof Set);
    assert.ok(restored._firedOnce.has('hard_stop'));
  });

  it('restores provided thresholds', () => {
    const thresholds: Threshold[] = [{ pct: 0.9, action: 'hard_stop', reason: 'critical' }];
    const t = makeTracker();
    const data = t.serialize();
    const restored = BudgetTracker.deserialize(data, thresholds);
    assert.equal(restored.thresholds.length, 1);
  });

  it('handles missing _firedOnce — defaults to empty Set', () => {
    const t = makeTracker();
    const data = t.serialize();
    const partial = { ...data, _firedOnce: undefined } as unknown as BudgetTrackerData;
    const restored = BudgetTracker.deserialize(partial);
    assert.ok(restored._firedOnce instanceof Set);
    assert.equal(restored._firedOnce.size, 0);
  });

  it('handles missing unitDeltas — defaults to []', () => {
    const t = makeTracker();
    const data = t.serialize();
    const partial = { ...data, unitDeltas: undefined } as unknown as BudgetTrackerData;
    const restored = BudgetTracker.deserialize(partial);
    assert.deepEqual(restored.unitDeltas, []);
  });

  it('handles missing unitLabel — defaults to "task"', () => {
    const t = makeTracker();
    const data = t.serialize();
    const partial = { ...data, unitLabel: undefined } as unknown as BudgetTrackerData;
    const restored = BudgetTracker.deserialize(partial);
    assert.equal(restored.unitLabel, 'task');
  });

  it('restores unitDeltas', () => {
    const t = makeTracker();
    t.unitDeltas = [{ label: 'a', tokens: 5_000, durationMs: 200 }];
    const data = t.serialize();
    const restored = BudgetTracker.deserialize(data);
    assert.equal(restored.unitDeltas.length, 1);
    assert.equal(restored.unitDeltas[0].tokens, 5_000);
  });
});

// ---------------------------------------------------------------------------
// recordStart() / recordUnitEnd()
// ---------------------------------------------------------------------------

describe('BudgetTracker — recordStart() and recordUnitEnd()', () => {
  it('recordStart() snapshots start tokens', () => {
    const t = makeTracker();
    t.recordStart();
    // After recordStart(), startTokens and currentTokens must be in sync
    assert.equal(t.startTokens, t.currentTokens);
  });

  it('recordUnitEnd() does not throw', () => {
    const t = makeTracker();
    t.recordStart();
    assert.doesNotThrow(() => t.recordUnitEnd('unit-1', 1_000));
  });

  it('recordUnitEnd() pushes a delta entry', () => {
    const t = makeTracker();
    t.recordStart();
    t.recordUnitEnd('unit-1', 1_000);
    assert.equal(t.unitDeltas.length, 1);
    assert.equal(t.unitDeltas[0].label, 'unit-1');
  });

  it('recordUnitEnd() returns an object with tokens property', () => {
    const t = makeTracker();
    t.recordStart();
    const result = t.recordUnitEnd('unit-1', 1_000);
    assert.ok('tokens' in result);
    assert.equal(typeof result.tokens, 'number');
  });

  it('recordUnitEnd() accepts extra fields', () => {
    const t = makeTracker();
    t.recordStart();
    assert.doesNotThrow(() => t.recordUnitEnd('unit-1', 500, { area: 'auth' }));
    assert.equal((t.unitDeltas[0] as Record<string, unknown>)['area'], 'auth');
  });
});
