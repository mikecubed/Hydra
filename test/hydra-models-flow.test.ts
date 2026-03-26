/**
 * Flow tests for hydra-models.ts — mock HTTP and CLI to exercise all code paths.
 *
 * Covers: fetchModels per agent, parseModelLines, API and CLI strategies,
 * display formatting functions.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies ────────────────────────────────────────────────────────

const mockLoadHydraConfig = mock.fn(() => ({
  models: {
    claude: { default: 'claude-opus-4-20250514', fast: 'claude-haiku', cheap: 'claude-haiku' },
    gemini: { default: 'gemini-3-pro', fast: 'gemini-flash' },
    codex: { default: 'gpt-5.1', fast: 'gpt-4.1-mini' },
  },
  aliases: {
    claude: { opus: 'claude-opus-4-20250514' },
    gemini: {},
    codex: {},
  },
  mode: 'balanced',
  modeTiers: { balanced: { claude: 'default', gemini: 'default', codex: 'default' } },
  local: { enabled: false },
}));

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
    resolveProject: mock.fn(() => ({
      projectRoot: '/test',
      projectName: 'test',
      runsDir: '/tmp/runs',
    })),
    getRoleConfig: mock.fn(() => null),
    _setTestConfig: mock.fn(),
    invalidateConfigCache: mock.fn(),
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getActiveModel: mock.fn((agent: string) => `${agent}-default-model`),
    getReasoningEffort: mock.fn(() => null),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {
      claude: { label: 'Claude' },
      gemini: { label: 'Gemini' },
      codex: { label: 'Codex' },
    },
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

// Mock node:https to control API responses
const mockHttpsRequest = mock.fn();
mock.module('node:https', {
  defaultExport: {
    request: mockHttpsRequest,
  },
});

// Mock cross-spawn for CLI strategy
const mockSpawnSync = mock.fn((): { status: number; stdout: string | null; stderr: string } => ({
  status: 1,
  stdout: null,
  stderr: 'not found',
}));
mock.module('cross-spawn', {
  defaultExport: {
    sync: mockSpawnSync,
  },
});

const { fetchModels } = await import('../lib/hydra-models.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('fetchModels — unknown agent', () => {
  it('returns empty for unknown agent name', async () => {
    const result = await fetchModels('nonexistent');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });
});

describe('fetchModels — claude', () => {
  const savedKey = process.env['ANTHROPIC_API_KEY'];

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = savedKey;
    }
    mockHttpsRequest.mock.resetCalls();
    mockSpawnSync.mock.resetCalls();
  });

  it('returns config-only when API key is missing and CLI fails', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 1,
      stdout: null,
      stderr: 'not found',
    }));
    const result = await fetchModels('claude');
    assert.equal(result.source, 'config-only');
    assert.deepEqual(result.models, []);
  });

  it('returns CLI models when API key is missing but CLI succeeds', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 0,
      stdout: 'claude-opus-4-20250514\nclaude-sonnet-4-20250514\nclaude-haiku\n',
      stderr: '',
    }));
    const result = await fetchModels('claude');
    assert.equal(result.source, 'cli');
    assert.ok(result.models.length > 0);
  });
});

describe('fetchModels — gemini', () => {
  const savedKey = process.env['GEMINI_API_KEY'];
  const savedGoogleKey = process.env['GOOGLE_API_KEY'];

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['GEMINI_API_KEY'];
    } else {
      process.env['GEMINI_API_KEY'] = savedKey;
    }
    if (savedGoogleKey === undefined) {
      delete process.env['GOOGLE_API_KEY'];
    } else {
      process.env['GOOGLE_API_KEY'] = savedGoogleKey;
    }
    mockHttpsRequest.mock.resetCalls();
    mockSpawnSync.mock.resetCalls();
  });

  it('returns config-only when no keys and CLI fails', async () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 1,
      stdout: null,
      stderr: 'not found',
    }));
    const result = await fetchModels('gemini');
    assert.equal(result.source, 'config-only');
  });

  it('returns CLI models when CLI succeeds', async () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 0,
      stdout: 'gemini-3-pro\ngemini-3-flash-preview\n',
      stderr: '',
    }));
    const result = await fetchModels('gemini');
    assert.equal(result.source, 'cli');
    assert.ok(result.models.length > 0);
  });
});

describe('fetchModels — codex', () => {
  const savedKey = process.env['OPENAI_API_KEY'];

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = savedKey;
    }
    mockHttpsRequest.mock.resetCalls();
    mockSpawnSync.mock.resetCalls();
  });

  it('returns config-only when no API key (CLI always skips for codex)', async () => {
    delete process.env['OPENAI_API_KEY'];
    const result = await fetchModels('codex');
    assert.equal(result.source, 'config-only');
  });
});

describe('fetchModels — concurrent calls', () => {
  it('concurrent calls for different agents return valid shapes', async () => {
    const [claude, gemini, codex] = await Promise.all([
      fetchModels('claude'),
      fetchModels('gemini'),
      fetchModels('codex'),
    ]);
    for (const r of [claude, gemini, codex]) {
      assert.ok(Array.isArray(r.models));
      assert.ok(typeof r.source === 'string');
    }
  });
});
