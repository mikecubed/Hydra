/**
 * Flow tests for hydra-prompt-choice.ts — interactive prompt functions.
 *
 * Uses mock.module to mock picocolors and hydra-ui so we can exercise
 * the rendering + input handling paths. Multi-select mode (no animation)
 * is tested with TTY=true; single-select exercises non-TTY + auto-accept
 * paths to avoid real timers from animateBoxDrawIn.
 */
import { describe, it, mock, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock hydra-ui ────────────────────────────────────────────────────────────

const mockBox = mock.fn((_title: string, _lines: string[], _opts?: unknown) => '[ box ]');
const mockStripAnsi = mock.fn((s: string) => s);

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    box: mockBox,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    WARNING: (s: string) => s,
    ERROR: (s: string) => s,
    SUCCESS: (s: string) => s,
    stripAnsi: mockStripAnsi,
    sectionHeader: (s: string) => s,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (s: string) => s,
    createSpinner: () => ({ start: mock.fn(), succeed: mock.fn(), fail: mock.fn() }),
    divider: () => '---',
    HIGHLIGHT: (s: string) => s,
    formatElapsed: (n: number) => `${String(n)}ms`,
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    blue: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    cyan: (s: string) => s,
  },
});

const { promptChoice, confirmActionPlan, setAutoAccept, resetAutoAccept, isChoiceActive } =
  await import('../lib/hydra-prompt-choice.ts');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRl() {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    question: mock.fn((_prompt: string, cb: (answer: string) => void) => {
      cb('freeform answer');
    }),
    setPrompt: mock.fn(),
    prompt: mock.fn(),
    on: mock.fn((event: string, fn: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(fn);
    }),
    removeAllListeners: mock.fn((event: string) => {
      listeners[event] = [];
    }),
    listeners: mock.fn((event: string) => listeners[event] ?? []),
    _emit(event: string, ...args: unknown[]) {
      for (const fn of listeners[event] ?? []) fn(...args);
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('promptChoice — non-TTY paths', () => {
  const origIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    resetAutoAccept();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, writable: true });
    resetAutoAccept();
  });

  it('returns default value in non-TTY mode', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl, {
      title: 'Test',
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      defaultValue: 'a',
    });
    assert.equal(result.value, 'a');
    assert.equal(result.timedOut, false);
    assert.equal(result.autoAcceptAll, false);
  });

  it('uses first choice value as default when no defaultValue given', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl, {
      title: 'Test',
      choices: [
        { label: 'First', value: 'first' },
        { label: 'Second', value: 'second' },
      ],
    });
    assert.equal(result.value, 'first');
  });

  it('returns default when choices are empty', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    const rl = makeRl();
    const result = await promptChoice(rl, {
      title: 'Test',
      choices: [],
      defaultValue: 'fallback',
    });
    assert.equal(result.value, 'fallback');
    assert.equal(result.timedOut, false);
  });

  it('non-TTY single-select returns default', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [{ label: 'X', value: 'x' }],
      defaultValue: 'x',
    });
    assert.equal(result.value, 'x');
  });

  it('handles undefined opts gracefully', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl);
    assert.equal(result.timedOut, false);
  });

  it('handles message property in opts', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl, {
      message: 'Custom message',
      choices: [{ label: 'A', value: 'a' }],
    });
    assert.equal(result.value, 'a');
  });
});

describe('promptChoice — auto-accept paths', () => {
  const origIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, writable: true });
    resetAutoAccept();
  });

  it('returns default value when auto-accept is on (TTY)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    setAutoAccept(true);
    const rl = makeRl();
    const result = await promptChoice(rl, {
      title: 'Test',
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      defaultValue: 'a',
    });
    assert.equal(result.value, 'a');
    assert.equal(result.autoAcceptAll, true);
  });

  it('auto-accept returns default in multi-select mode too', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    setAutoAccept(true);
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    assert.deepEqual(result.values, ['a', 'b']);
    assert.equal(result.autoAcceptAll, true);
  });

  it('auto-accept with preSelected returns only preSelected values', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    setAutoAccept(true);
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      multiSelect: true,
      preSelected: ['a', 'c'],
    });
    assert.deepEqual(result.values, ['a', 'c']);
  });
});

describe('promptChoice — multi-select TTY mode (no animation)', () => {
  const origIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    resetAutoAccept();
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, writable: true });
    resetAutoAccept();
  });

  it('empty enter confirms current selection (empty = no values)', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      title: 'MultiPick',
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', ''); // confirm empty selection
    const result = await promise;
    assert.deepEqual(result.values, []);
  });

  it('pre-selected values are included on empty enter', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      multiSelect: true,
      preSelected: ['a', 'c'],
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', ''); // confirm pre-selected
    const result = await promise;
    assert.deepEqual(result.values, ['a', 'c']);
  });

  it('toggling and confirm works', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', '1,3'); // toggle items 1 and 3
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, ['a', 'c']);
  });

  it('"a" toggles all on, then confirm', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', 'a'); // select all
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, ['a', 'b']);
  });

  it('"a" toggles all off when all already selected', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
      preSelected: ['a', 'b'],
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', 'a'); // toggle all OFF (all were selected)
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, []);
  });

  it('"?" refreshes display then confirm', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
      preSelected: ['a'],
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', '?'); // refresh
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, ['a']);
  });

  it('invalid input shows error and continues', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', 'xyz'); // invalid
    rl._emit('line', '1'); // toggle 1
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, ['a']);
  });

  it('range input works in multi-select', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
        { label: 'D', value: 'd' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', '2-4'); // range
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, ['b', 'c', 'd']);
  });

  it('toggling same item twice unselects it', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', '1'); // select
    rl._emit('line', '1'); // unselect
    rl._emit('line', ''); // confirm empty
    const result = await promise;
    assert.deepEqual(result.values, []);
  });

  it('empty choices returns empty values immediately', async () => {
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [],
      multiSelect: true,
    });
    assert.deepEqual(result.values, []);
  });

  it('non-TTY multi-select returns all when no pre-selected', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ],
      multiSelect: true,
    });
    assert.deepEqual(result.values, ['a', 'b']);
  });

  it('non-TTY multi-select returns pre-selected', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const rl = makeRl();
    const result = await promptChoice(rl, {
      choices: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
        { label: 'C', value: 'c' },
      ],
      multiSelect: true,
      preSelected: ['b'],
    });
    assert.deepEqual(result.values, ['b']);
  });

  it('multi-select with context renders context', async () => {
    const rl = makeRl();
    const promise = promptChoice(rl, {
      title: 'Pick',
      context: { scope: 'global', target: 'all' },
      choices: [{ label: 'A', value: 'a' }],
      multiSelect: true,
    });
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    rl._emit('line', ''); // confirm
    const result = await promise;
    assert.deepEqual(result.values, []);
    // box mock was called for renderMultiSelectUI
    assert.ok(mockBox.mock.callCount() > 0);
  });
});

describe('confirmActionPlan', () => {
  const origIsTTY = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, writable: true });
    resetAutoAccept();
  });

  it('returns true for empty actions', async () => {
    const rl = makeRl();
    const result = await confirmActionPlan(rl, { actions: [] });
    assert.equal(result, true);
  });

  it('non-TTY auto-confirms (returns true via promptChoice default)', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const rl = makeRl();
    const result = await confirmActionPlan(rl, {
      title: 'Plan',
      actions: [{ label: 'Do thing', severity: 'medium' }],
    });
    assert.equal(result, true);
  });

  it('renders plan with all severity levels and descriptions', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const rl = makeRl();
    await confirmActionPlan(rl, {
      title: 'Plan',
      context: { scope: 'global' },
      summary: 'Test plan',
      actions: [
        { label: 'First', severity: 'critical', agent: 'claude', description: 'Do first thing' },
        { label: 'Second', severity: 'high' },
        { label: 'Third', severity: 'medium' },
        { label: 'Fourth', severity: 'low' },
        { label: 'Fifth' }, // no severity => default icon
      ],
    });
    assert.ok(true); // No throw means render succeeded
  });

  it('auto-accept mode confirms without interaction', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true });
    setAutoAccept(true);
    const rl = makeRl();
    const result = await confirmActionPlan(rl, {
      actions: [{ label: 'Action' }],
    });
    assert.equal(result, true);
  });

  it('returns true when no opts provided', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true });
    const rl = makeRl();
    const result = await confirmActionPlan(rl);
    assert.equal(result, true); // empty actions = true
  });
});

describe('isChoiceActive', () => {
  it('returns false when no choice is active', () => {
    assert.equal(isChoiceActive(), false);
  });
});
