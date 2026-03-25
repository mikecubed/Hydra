/**
 * Deep coverage tests for hydra-prompt-choice.ts
 *
 * Mocks readline and process.stdout to test interactive prompt logic
 * without a real TTY.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-prompt-choice-deep.test.ts
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test file uses dynamic mocks */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Suppress console.log to prevent IPC serialization errors ────────────────
const originalLog = console.log;
let suppressLog = false;
console.log = (...args: unknown[]) => {
  if (!suppressLog) originalLog(...args);
};

// ── Mock UI dependencies ────────────────────────────────────────────────────

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    box: (_title: string, _lines: string[]) => '[ box ]',
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    WARNING: (s: string) => s,
    ERROR: (s: string) => s,
    SUCCESS: (s: string) => s,
    stripAnsi: (s: string) => s,
    sectionHeader: (t: string) => `--- ${t} ---`,
    label: (k: string, v?: string | number | boolean) => `${k}: ${String(v ?? '')}`,
    colorAgent: (n: string) => n,
    HIGHLIGHT: (s: string) => s,
    isTruecolor: false,
    AGENT_COLORS: {},
    AGENT_ICONS: {},
    hydraSplash: () => '',
    hydraLogoCompact: () => '',
    getAgentColor: () => (s: string) => s,
    getAgentIcon: () => '',
    createSpinner: () => ({
      start: mock.fn(),
      succeed: mock.fn(),
      fail: mock.fn(),
      stop: mock.fn(),
    }),
  },
});

mock.module('picocolors', {
  defaultExport: {
    bold: (s: string) => s,
    white: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    gray: (s: string) => s,
    cyan: (s: string) => s,
    magenta: (s: string) => s,
    dim: (s: string) => s,
  },
});

// ── Import target ───────────────────────────────────────────────────────────

const {
  promptChoice,
  confirmActionPlan,
  isAutoAccepting,
  setAutoAccept,
  resetAutoAccept,
  isChoiceActive,
  parseMultiSelectInput,
} = await import('../lib/hydra-prompt-choice.ts');

// ── Mock readline helper ────────────────────────────────────────────────────

function makeRl(lineInputs: string[] = []) {
  const lineListeners: ((...args: any[]) => void)[] = [];
  let inputIdx = 0;

  function feedNext() {
    if (inputIdx < lineInputs.length && lineListeners.length > 0) {
      const input = lineInputs[inputIdx++];
      setTimeout(() => {
        for (const listener of [...lineListeners]) {
          (listener as (s: string) => void)(input);
        }
      }, 10);
    }
  }

  const rl = {
    listeners: (event: string) => (event === 'line' ? [...lineListeners] : []),
    removeAllListeners: mock.fn((event?: string) => {
      if (!event || event === 'line') lineListeners.length = 0;
      return rl;
    }),
    on: mock.fn((event: string, cb: (...args: any[]) => void) => {
      if (event === 'line') {
        lineListeners.push(cb);
        // Feed first queued input shortly after listener is registered
        feedNext();
      }
      return rl;
    }),
    setPrompt: mock.fn(),
    prompt: mock.fn(() => {
      // Each prompt call can feed the next input (for retry/re-prompt scenarios)
      feedNext();
    }),
    question: mock.fn((_prompt: string, cb: (...args: any[]) => void) => {
      cb('freeform answer');
    }),
    pause: mock.fn(),
    resume: mock.fn(),
  };
  return rl;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-prompt-choice-deep', () => {
  beforeEach(() => {
    suppressLog = true;
    resetAutoAccept();
  });

  afterEach(() => {
    suppressLog = false;
  });

  // ── Auto-Accept State ─────────────────────────────────────────────────

  describe('auto-accept state', () => {
    it('starts with auto-accept off', () => {
      assert.equal(isAutoAccepting(), false);
    });

    it('setAutoAccept(true) enables it', () => {
      setAutoAccept(true);
      assert.equal(isAutoAccepting(), true);
      resetAutoAccept();
    });

    it('resetAutoAccept turns it off', () => {
      setAutoAccept(true);
      resetAutoAccept();
      assert.equal(isAutoAccepting(), false);
    });
  });

  // ── isChoiceActive ────────────────────────────────────────────────────

  describe('isChoiceActive', () => {
    it('returns false when no choice is pending', () => {
      assert.equal(isChoiceActive(), false);
    });
  });

  // ── parseMultiSelectInput ─────────────────────────────────────────────

  describe('parseMultiSelectInput', () => {
    it('returns "all" for "a"', () => {
      assert.equal(parseMultiSelectInput('a', 5), 'all');
    });

    it('returns "all" for "all"', () => {
      assert.equal(parseMultiSelectInput('ALL', 5), 'all');
    });

    it('returns null for empty input', () => {
      assert.equal(parseMultiSelectInput('', 5), null);
    });

    it('parses single number', () => {
      assert.deepEqual(parseMultiSelectInput('3', 5), [2]);
    });

    it('parses comma-separated numbers', () => {
      assert.deepEqual(parseMultiSelectInput('1,3,5', 5), [0, 2, 4]);
    });

    it('parses range', () => {
      assert.deepEqual(parseMultiSelectInput('2-4', 5), [1, 2, 3]);
    });

    it('returns null for out-of-range number', () => {
      assert.equal(parseMultiSelectInput('6', 5), null);
    });

    it('returns null for zero', () => {
      assert.equal(parseMultiSelectInput('0', 5), null);
    });

    it('returns null for invalid range (start > end)', () => {
      assert.equal(parseMultiSelectInput('4-2', 5), null);
    });

    it('returns null for non-numeric input', () => {
      assert.equal(parseMultiSelectInput('abc', 5), null);
    });

    it('deduplicates overlapping selections', () => {
      const result = parseMultiSelectInput('1,1,2', 3);
      assert.deepEqual(result, [0, 1]);
    });

    it('handles space-separated numbers', () => {
      assert.deepEqual(parseMultiSelectInput('1 3', 5), [0, 2]);
    });

    it('returns null for range exceeding max', () => {
      assert.equal(parseMultiSelectInput('1-10', 5), null);
    });
  });

  // ── promptChoice — non-TTY / auto-accept path ────────────────────────

  describe('promptChoice non-TTY', () => {
    it('returns defaultValue when not TTY', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
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
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('returns default when auto-accept is on', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
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
      } finally {
        resetAutoAccept();
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('returns default for empty choices', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl();
        const result = await promptChoice(rl, {
          title: 'Test',
          choices: [],
          defaultValue: 'fallback',
        });
        assert.equal(result.value, 'fallback');
        assert.equal(result.timedOut, false);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });

  // ── promptChoice — TTY interactive path ───────────────────────────────

  describe('promptChoice TTY', () => {
    it('resolves when user picks a valid choice number', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['1']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [
            { label: 'Alpha', value: 'alpha' },
            { label: 'Beta', value: 'beta' },
          ],
          defaultValue: 'alpha',
        });
        assert.equal(result.value, 'alpha');
        assert.equal(result.timedOut, false);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('resolves second choice', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['2']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [
            { label: 'Alpha', value: 'alpha' },
            { label: 'Beta', value: 'beta' },
          ],
          defaultValue: 'alpha',
        });
        assert.equal(result.value, 'beta');
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('handles __auto_accept__ choice', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['2']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'Accept all', value: '__auto_accept__' },
          ],
          defaultValue: 'a',
        });
        assert.equal(result.value, 'a');
        assert.equal(result.autoAcceptAll, true);
        // Clean up
        resetAutoAccept();
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('handles freeform choice', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['1']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [{ label: 'Custom', value: 'custom', freeform: true }],
          defaultValue: 'custom',
        });
        // Should have collected freeform via rl.question
        assert.equal(result.value, 'freeform answer');
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('handles freeform direct text (> 2 chars) when freeform choice exists', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['hello world']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [
            { label: 'Option A', value: 'a' },
            { label: 'Custom', value: 'custom', freeform: true },
          ],
          defaultValue: 'a',
        });
        assert.equal(result.value, 'hello world');
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('times out and returns default', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl([]); // No input — will timeout
        const result = await promptChoice(rl, {
          title: 'Pick',
          choices: [{ label: 'A', value: 'a' }],
          defaultValue: 'a',
          timeoutMs: 50,
        });
        assert.equal(result.value, 'a');
        assert.equal(result.timedOut, true);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('renders with context', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['1']);
        const result = await promptChoice(rl, {
          title: 'Pick',
          context: { key: 'value', empty: '', nul: null },
          choices: [{ label: 'A', value: 'a' }],
          defaultValue: 'a',
        });
        assert.equal(result.value, 'a');
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });

  // ── promptChoice — multi-select mode ──────────────────────────────────

  describe('promptChoice multi-select', () => {
    it('returns all values in non-TTY mode', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        const rl = makeRl();
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          multiSelect: true,
        });
        assert.deepEqual(result.values, ['a', 'b']);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('returns preSelected values in non-TTY mode', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        const rl = makeRl();
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          multiSelect: true,
          preSelected: ['b'],
        });
        assert.deepEqual(result.values, ['b']);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('returns empty values for empty choices', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl();
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [],
          multiSelect: true,
        });
        assert.deepEqual(result.values, []);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('confirms selection on empty line in TTY mode', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl(['']); // Empty line = confirm
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          multiSelect: true,
          preSelected: ['a'],
        });
        assert.deepEqual(result.values, ['a']);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('times out in multi-select mode', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        const rl = makeRl([]); // No input
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          multiSelect: true,
          timeoutMs: 50,
        });
        // Should timeout and return all values (no selection)
        assert.equal(result.timedOut, true);
        assert.ok(Array.isArray(result.values));
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('returns all in auto-accept multi-select', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
        setAutoAccept(true);
        const rl = makeRl();
        const result = await promptChoice(rl, {
          title: 'Multi',
          choices: [
            { label: 'A', value: 'a' },
            { label: 'B', value: 'b' },
          ],
          multiSelect: true,
        });
        assert.deepEqual(result.values, ['a', 'b']);
        assert.equal(result.autoAcceptAll, true);
      } finally {
        resetAutoAccept();
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });

  // ── confirmActionPlan ─────────────────────────────────────────────────

  describe('confirmActionPlan', () => {
    it('returns true for empty actions', async () => {
      const rl = makeRl();
      const result = await confirmActionPlan(rl, { actions: [] });
      assert.equal(result, true);
    });

    it('returns true when user confirms (non-TTY auto)', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        const rl = makeRl();
        const result = await confirmActionPlan(rl, {
          title: 'Plan',
          summary: 'Test summary',
          context: { scope: 'test' },
          actions: [
            { label: 'Action 1', description: 'Desc', agent: 'claude', severity: 'high' },
            { label: 'Action 2', severity: 'medium' },
            { label: 'Action 3', severity: 'low' },
            { label: 'Action 4', severity: 'critical' },
            { label: 'Action 5' },
          ],
        });
        // Non-TTY returns default (true for Proceed)
        assert.equal(result, true);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('renders single action without plural', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        const rl = makeRl();
        const result = await confirmActionPlan(rl, {
          actions: [{ label: 'Single action' }],
        });
        assert.equal(result, true);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });

    it('passes no context gracefully', async () => {
      const origIsTTY = process.stdout.isTTY;
      try {
        Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
        const rl = makeRl();
        const result = await confirmActionPlan(rl, {
          actions: [{ label: 'Action' }],
        });
        assert.equal(result, true);
      } finally {
        Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      }
    });
  });
});
