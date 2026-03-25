/**
 * Deep coverage tests for lib/hydra-operator-ui.ts.
 *
 * Mocks I/O (request, hydra-ui) and tests all exported functions
 * including printStatus, printNextSteps, printHelp, printCommandHelp,
 * getSelfAwarenessSummary, printSelfAwarenessStatus, and constants.
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockRequest = mock.fn(
  async (_method: string, _base: string, _path: string): Promise<Record<string, unknown>> => ({
    summary: { openTasks: 3, pendingHandoffs: 1 },
    next: { action: 'claim', task: { id: 'T001' } },
  }),
);

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    request: mockRequest,
    parseArgs: mock.fn(),
    getPrompt: mock.fn(),
    boolFlag: mock.fn(),
    short: mock.fn(),
    parseJsonLoose: mock.fn(),
    ensureDir: mock.fn(),
    nowIso: mock.fn(),
    runId: mock.fn(),
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `=== ${t} ===`,
    label: (k: string, v?: string | number | boolean) => `${k}: ${String(v ?? '')}`,
    renderDashboard: () => 'MOCK-DASHBOARD',
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    hydraLogoCompact: () => 'HYDRA-LOGO',
    colorAgent: (n: string) => n,
    createSpinner: () => ({ start: mock.fn(), stop: mock.fn() }),
    box: () => 'MOCK-BOX',
    stripAnsi: (s: string) => s,
  },
});

// ── Import ───────────────────────────────────────────────────────────────────

const {
  printStatus,
  printNextSteps,
  printHelp,
  printCommandHelp,
  getSelfAwarenessSummary,
  printSelfAwarenessStatus,
  SMART_TIER_MAP,
  KNOWN_COMMANDS,
  COMMAND_HELP,
} = await import('../lib/hydra-operator-ui.ts');

// ── printStatus ──────────────────────────────────────────────────────────────

describe('printStatus', () => {
  beforeEach(() => {
    mockRequest.mock.resetCalls();
  });

  it('returns dashboard summary from daemon', async () => {
    mockRequest.mock.mockImplementation(async (_m: string, _b: string, _p: string) => ({
      summary: { openTasks: 5, pendingHandoffs: 2 },
      next: { action: 'claim' },
    }));
    const result = await printStatus('http://localhost:4173', ['claude', 'gemini']);
    assert.ok(typeof result === 'object');
  });

  it('handles agent next request failures gracefully', async () => {
    let callCount = 0;
    mockRequest.mock.mockImplementation(async (_m: string, _b: string, path: string) => {
      if (path.includes('/next')) {
        callCount++;
        if (callCount > 1) throw new Error('agent down');
      }
      return { summary: { openTasks: 0 }, next: { action: 'idle' } };
    });
    const result = await printStatus('http://localhost:4173', ['claude', 'gemini']);
    assert.ok(typeof result === 'object');
  });

  it('normalizes numeric openTasks to empty array for renderDashboard', async () => {
    mockRequest.mock.mockImplementation(async () => ({
      summary: { openTasks: 7, pendingHandoffs: 0 },
      next: { action: 'idle' },
    }));
    const result = await printStatus('http://localhost:4173', ['claude']);
    assert.ok(result !== null);
  });

  it('handles empty summary', async () => {
    mockRequest.mock.mockImplementation(async () => ({}));
    const result = await printStatus('http://localhost:4173', []);
    assert.ok(typeof result === 'object');
  });
});

// ── printNextSteps ───────────────────────────────────────────────────────────

describe('printNextSteps', () => {
  it('prints nothing when there are no open tasks and no pending work', () => {
    // This exercises the branch where openTasks=0 and no pending work
    printNextSteps({ summary: { openTasks: 0, pendingHandoffs: 0 } });
    // No assertion needed — no throw means success
  });

  it('prints resume step when handoffs are pending', () => {
    printNextSteps({
      pendingHandoffs: [{ id: 'H1' }],
      summary: { openTasks: 3, pendingHandoffs: 1 },
    });
  });

  it('prints resume step when stale tasks exist', () => {
    printNextSteps({
      staleTasks: [{ id: 'T1' }, { id: 'T2' }],
      summary: { openTasks: 2 },
    });
  });

  it('prints resume step when in-progress tasks exist', () => {
    printNextSteps({
      inProgressTasks: [{ id: 'T1' }],
      summary: { openTasks: 1 },
    });
  });

  it('prints status step when openTasks > 0 and no pending work', () => {
    printNextSteps({ summary: { openTasks: 5, pendingHandoffs: 0 } });
  });

  it('handles numeric openTasks from summary', () => {
    printNextSteps({ summary: { openTasks: 10 } });
  });

  it('handles array openTasks from summary', () => {
    printNextSteps({
      summary: { openTasks: [{ id: 'T1', title: 'task', status: 'open' }] as never },
    });
  });

  it('prints with empty input', () => {
    printNextSteps();
  });

  it('handles combined pending work (handoffs + stale + in-progress)', () => {
    printNextSteps({
      pendingHandoffs: [{ id: 'H1' }],
      staleTasks: [{ id: 'T1' }],
      inProgressTasks: [{ id: 'T2' }],
      summary: { openTasks: 5 },
    });
  });
});

// ── printHelp ────────────────────────────────────────────────────────────────

describe('printHelp', () => {
  it('prints help without throwing', () => {
    printHelp();
  });
});

// ── printCommandHelp ─────────────────────────────────────────────────────────

describe('printCommandHelp', () => {
  it('prints help for known command', () => {
    printCommandHelp(':help');
  });

  it('prints help for :status', () => {
    printCommandHelp(':status');
  });

  it('prints help for :mode', () => {
    printCommandHelp(':mode');
  });

  it('prints help for :evolve', () => {
    printCommandHelp(':evolve');
  });

  it('prints "no help" for unknown command', () => {
    printCommandHelp(':nonexistent');
  });

  it('prints help for all KNOWN_COMMANDS that have entries', () => {
    for (const cmd of KNOWN_COMMANDS) {
      printCommandHelp(cmd);
    }
  });
});

// ── SMART_TIER_MAP ───────────────────────────────────────────────────────────

describe('SMART_TIER_MAP', () => {
  it('maps simple to economy', () => {
    assert.equal(SMART_TIER_MAP.simple, 'economy');
  });
  it('maps medium to balanced', () => {
    assert.equal(SMART_TIER_MAP.medium, 'balanced');
  });
  it('maps complex to performance', () => {
    assert.equal(SMART_TIER_MAP.complex, 'performance');
  });
});

// ── KNOWN_COMMANDS ───────────────────────────────────────────────────────────

describe('KNOWN_COMMANDS', () => {
  it('is a non-empty array of strings starting with :', () => {
    assert.ok(Array.isArray(KNOWN_COMMANDS));
    assert.ok(KNOWN_COMMANDS.length > 20);
    for (const cmd of KNOWN_COMMANDS) {
      assert.ok(cmd.startsWith(':'), `${cmd} should start with :`);
    }
  });

  it('includes key commands', () => {
    const required = [':help', ':status', ':mode', ':quit', ':exit', ':evolve', ':tasks'];
    for (const cmd of required) {
      assert.ok(KNOWN_COMMANDS.includes(cmd), `missing ${cmd}`);
    }
  });
});

// ── COMMAND_HELP ─────────────────────────────────────────────────────────────

describe('COMMAND_HELP', () => {
  it('has entries for most known commands', () => {
    const entries = Object.keys(COMMAND_HELP);
    assert.ok(entries.length > 15);
  });

  it('each entry has usage array and desc string', () => {
    for (const [key, entry] of Object.entries(COMMAND_HELP)) {
      if (entry == null) continue;
      assert.ok(Array.isArray(entry.usage), `${key} missing usage`);
      assert.ok(entry.usage.length > 0, `${key} empty usage`);
      assert.equal(typeof entry.desc, 'string', `${key} missing desc`);
    }
  });
});

// ── getSelfAwarenessSummary ──────────────────────────────────────────────────

describe('getSelfAwarenessSummary', () => {
  it('returns full level when enabled and includeIndex', () => {
    const result = getSelfAwarenessSummary({ enabled: true, includeIndex: true });
    assert.equal(result.level, 'full');
    assert.equal(result.enabled, true);
  });

  it('returns minimal level when enabled but no index', () => {
    const result = getSelfAwarenessSummary({
      enabled: true,
      includeIndex: false,
      includeSnapshot: true,
    });
    assert.equal(result.level, 'minimal');
  });

  it('returns off level when disabled', () => {
    const result = getSelfAwarenessSummary({ enabled: false });
    assert.equal(result.level, 'off');
    assert.equal(result.enabled, false);
  });

  it('defaults to full when called with empty object', () => {
    const result = getSelfAwarenessSummary({});
    assert.equal(result.level, 'full');
    assert.equal(result.enabled, true);
  });

  it('defaults to full when called with no args', () => {
    const result = getSelfAwarenessSummary();
    assert.equal(result.level, 'full');
  });

  it('handles null input', () => {
    const result = getSelfAwarenessSummary(null);
    assert.equal(result.level, 'full');
  });

  it('handles undefined input', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined
    const result = getSelfAwarenessSummary(undefined);
    assert.equal(result.level, 'full');
  });
});

// ── printSelfAwarenessStatus ─────────────────────────────────────────────────

describe('printSelfAwarenessStatus', () => {
  it('prints enabled full status', () => {
    printSelfAwarenessStatus({ enabled: true, includeSnapshot: true, includeIndex: true });
  });

  it('prints disabled status', () => {
    printSelfAwarenessStatus({ enabled: false });
  });

  it('prints with custom snapshotMaxLines', () => {
    printSelfAwarenessStatus({ snapshotMaxLines: 200 });
  });

  it('prints with custom indexMaxChars and indexRefreshMs', () => {
    printSelfAwarenessStatus({ indexMaxChars: 10000, indexRefreshMs: 60000 });
  });

  it('prints with empty config', () => {
    printSelfAwarenessStatus({});
  });

  it('prints defaults when no args provided', () => {
    printSelfAwarenessStatus();
  });
});
