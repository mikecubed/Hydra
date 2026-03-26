/**
 * Deep coverage tests for lib/hydra-action-pipeline.ts.
 *
 * Mocks hydra-ui and hydra-prompt-choice to test the full pipeline flow:
 * scan, enrich, select, confirm, execute, report.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `=== ${t} ===`,
    DIM: (s: string) => s,
    ERROR: (s: string) => s,
    SUCCESS: (s: string) => s,
    WARNING: (s: string) => s,
    createSpinner: () => ({
      start: mock.fn(),
      stop: mock.fn(),
      succeed: mock.fn(),
      fail: mock.fn(),
    }),
    formatElapsed: (ms: number) => `${String(ms)}ms`,
    label: (k: string, v: string) => `${k}: ${v}`,
  },
});

const mockPromptChoice = mock.fn(async () => ({ values: ['item-1', 'item-2'] }));
const mockConfirmActionPlan = mock.fn(async () => true);
mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
    confirmActionPlan: mockConfirmActionPlan,
    isAutoAccepting: mock.fn(() => false),
    setAutoAccept: mock.fn(),
    resetAutoAccept: mock.fn(),
  },
});

// ── Import ───────────────────────────────────────────────────────────────────

const { runActionPipeline } = await import('../lib/hydra-action-pipeline.ts');
import type { ActionItem, PipelineResult } from '../lib/hydra-action-pipeline.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(id: string, overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    id,
    title: `Item ${id}`,
    description: `Description for ${id}`,
    category: 'fix',
    severity: 'medium',
    source: 'test',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runActionPipeline', () => {
  it('returns empty array when no scanners provided', async () => {
    const results = await runActionPipeline(null, { scanners: [] });
    assert.deepEqual(results, []);
  });

  it('returns empty array when scanners find nothing', async () => {
    const results = await runActionPipeline(null, {
      scanners: [async () => []],
    });
    assert.deepEqual(results, []);
  });

  it('runs full pipeline: scan → select → confirm → execute → report', async () => {
    const item1 = makeItem('item-1');
    const item2 = makeItem('item-2');
    const executeFn = mock.fn(
      async (item: ActionItem): Promise<PipelineResult> => ({
        item,
        ok: true,
        output: `done ${item.id}`,
        durationMs: 50,
      }),
    );

    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1', 'item-2'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      title: 'Test Pipeline',
      scanners: [async () => [item1, item2]],
      executeFn,
    });

    assert.equal(results.length, 2);
    assert.ok(results[0].ok);
    assert.ok(results[1].ok);
    assert.equal(executeFn.mock.callCount(), 2);
  });

  it('returns empty when nothing selected', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({ values: [] }));

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
    });
    assert.deepEqual(results, []);
  });

  it('returns empty when confirm is declined', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => false);

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
    });
    assert.deepEqual(results, []);
  });

  it('handles execute failure gracefully', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      executeFn: async (item) => ({
        item,
        ok: false,
        error: 'something went wrong',
        durationMs: 10,
      }),
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'something went wrong');
  });

  it('handles executeFn that throws', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      executeFn: async () => {
        throw new Error('executor crashed');
      },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error?.includes('executor crashed'));
  });

  it('handles missing executeFn', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      // no executeFn provided
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.ok(results[0].error?.includes('executeFn is required'));
  });

  it('deduplicates items with same id', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['dup-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const executeFn = mock.fn(
      async (item: ActionItem): Promise<PipelineResult> => ({
        item,
        ok: true,
        durationMs: 5,
      }),
    );

    const results = await runActionPipeline(null, {
      scanners: [
        async () => [makeItem('dup-1', { title: 'First' })],
        async () => [makeItem('dup-1', { title: 'Duplicate' })],
      ],
      executeFn,
    });

    // Only one item should be executed (deduped)
    assert.equal(results.length, 1);
  });

  it('uses enrich function when provided', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const enrichFn = mock.fn(async (items: ActionItem[]) =>
      items.map((i) => ({ ...i, severity: 'critical' as const })),
    );

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      enrich: enrichFn,
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
    });

    assert.equal(enrichFn.mock.callCount(), 1);
    assert.equal(results.length, 1);
  });

  it('handles enrich failure gracefully (falls back to unenriched items)', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      enrich: async () => {
        throw new Error('enrich failed');
      },
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
    });

    assert.equal(results.length, 1);
    assert.ok(results[0].ok);
  });

  it('applies preSelectFilter to compute pre-selected items', async () => {
    const criticalItem = makeItem('crit-1', { severity: 'critical' });
    const lowItem = makeItem('low-1', { severity: 'low' });

    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['crit-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => [criticalItem, lowItem]],
      preSelectFilter: (item) => item.severity === 'critical',
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
    });

    assert.equal(results.length, 1);
  });

  it('calls onComplete callback with results', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const onComplete = mock.fn();

    await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
      onComplete,
    });

    assert.equal(onComplete.mock.callCount(), 1);
    const callArgs = onComplete.mock.calls[0].arguments[0] as PipelineResult[];
    assert.equal(callArgs.length, 1);
    assert.ok(callArgs[0].ok);
  });

  it('handles onComplete that throws', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    // Should not throw even if onComplete throws
    const results = await runActionPipeline(null, {
      scanners: [async () => [makeItem('item-1')]],
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
      onComplete: () => {
        throw new Error('callback error');
      },
    });

    assert.equal(results.length, 1);
  });

  it('handles rejected scanner promises gracefully', async () => {
    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['item-1'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [
        async () => [makeItem('item-1')],
        async () => {
          throw new Error('scanner failed');
        },
      ],
      executeFn: async (item) => ({ item, ok: true, durationMs: 0 }),
    });

    // Should still process the items from the successful scanner
    assert.equal(results.length, 1);
  });

  it('uses default title when not provided', async () => {
    const results = await runActionPipeline(null, { scanners: [] });
    assert.deepEqual(results, []);
  });

  it('mixed success/failure results produce correct report', async () => {
    const items = [makeItem('ok-1'), makeItem('fail-1'), makeItem('ok-2')];

    mockPromptChoice.mock.mockImplementation(async () => ({
      values: ['ok-1', 'fail-1', 'ok-2'],
    }));
    mockConfirmActionPlan.mock.mockImplementation(async () => true);

    const results = await runActionPipeline(null, {
      scanners: [async () => items],
      executeFn: async (item) => ({
        item,
        ok: item.id !== 'fail-1',
        error: item.id === 'fail-1' ? 'failed' : undefined,
        durationMs: 10,
      }),
    });

    assert.equal(results.length, 3);
    assert.equal(results.filter((r) => r.ok).length, 2);
    assert.equal(results.filter((r) => !r.ok).length, 1);
  });
});
