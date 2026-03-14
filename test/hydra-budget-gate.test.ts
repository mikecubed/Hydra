/**
 * Unit tests for IBudgetGate interface and DefaultBudgetGate implementation.
 * Written TDD-style: tests were written before implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DefaultBudgetGate, type IBudgetGate } from '../lib/hydra-shared/budget-gate.ts';

describe('DefaultBudgetGate', () => {
  describe('constructor defaults', () => {
    it('uses 80% daily and 75% weekly by default', () => {
      const gate = new DefaultBudgetGate();
      const thresholds = gate.getThresholds();
      assert.equal(thresholds.dailyPct, 80);
      assert.equal(thresholds.weeklyPct, 75);
    });
  });

  describe('constructor with custom thresholds', () => {
    it('accepts custom dailyPct and weeklyPct', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 90, weeklyPct: 85 });
      const thresholds = gate.getThresholds();
      assert.equal(thresholds.dailyPct, 90);
      assert.equal(thresholds.weeklyPct, 85);
    });

    it('allows partial override of only dailyPct', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 95 });
      const thresholds = gate.getThresholds();
      assert.equal(thresholds.dailyPct, 95);
      assert.equal(thresholds.weeklyPct, 75);
    });

    it('allows partial override of only weeklyPct', () => {
      const gate = new DefaultBudgetGate({ weeklyPct: 60 });
      const thresholds = gate.getThresholds();
      assert.equal(thresholds.dailyPct, 80);
      assert.equal(thresholds.weeklyPct, 60);
    });
  });

  describe('isExceeded', () => {
    it('returns false when both are below thresholds', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(50, 50), false);
    });

    it('returns true when dailyPct exceeds threshold', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(81, 50), true);
    });

    it('returns true when weeklyPct exceeds threshold', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(50, 76), true);
    });

    it('returns true when both exceed thresholds', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(85, 80), true);
    });

    it('returns false when both equal the threshold (not strictly exceeded)', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(80, 75), false);
    });

    it('returns false when values are zero', () => {
      const gate = new DefaultBudgetGate();
      assert.equal(gate.isExceeded(0, 0), false);
    });

    it('returns true when dailyPct is exactly one above threshold', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });
      assert.equal(gate.isExceeded(80.1, 0), true);
    });
  });

  describe('satisfies IBudgetGate interface', () => {
    it('can be referenced as IBudgetGate', () => {
      const gate: IBudgetGate = new DefaultBudgetGate();
      assert.ok(typeof gate.isExceeded === 'function');
      assert.ok(typeof gate.getThresholds === 'function');
    });

    it('getThresholds returns a plain object with dailyPct and weeklyPct', () => {
      const gate: IBudgetGate = new DefaultBudgetGate({ dailyPct: 70, weeklyPct: 65 });
      const t = gate.getThresholds();
      assert.deepEqual(t, { dailyPct: 70, weeklyPct: 65 });
    });
  });

  describe('replicated hydra-agents.ts pattern', () => {
    it('mirrors the inline threshold check: (daily > dailyPct || weekly > weeklyPct)', () => {
      const gate = new DefaultBudgetGate({ dailyPct: 80, weeklyPct: 75 });

      // Values from budgetState
      const scenarios: Array<{ daily: number; weekly: number; expected: boolean }> = [
        { daily: 0, weekly: 0, expected: false },
        { daily: 79, weekly: 74, expected: false },
        { daily: 81, weekly: 74, expected: true },
        { daily: 79, weekly: 76, expected: true },
        { daily: 81, weekly: 76, expected: true },
      ];

      for (const { daily, weekly, expected } of scenarios) {
        assert.equal(
          gate.isExceeded(daily, weekly),
          expected,
          `daily=${String(daily)}, weekly=${String(weekly)} should be ${String(expected)}`,
        );
      }
    });
  });
});
