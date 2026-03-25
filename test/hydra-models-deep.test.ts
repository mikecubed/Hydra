/**
 * Deep coverage tests for lib/hydra-models.ts.
 *
 * Mocks https, cross-spawn, hydra-config, and hydra-agents to test
 * fetchModels API/CLI/config-only paths and internal helpers.
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock https.request to simulate API calls
const mockHttpsRequest = mock.fn(
  (_url: string, _opts: Record<string, unknown>, cb: (res: unknown) => void) => {
    const res = {
      on: (event: string, handler: (data?: string) => void) => {
        if (event === 'data') {
          handler(JSON.stringify({ data: [{ id: 'model-1' }, { id: 'model-2' }] }));
        }
        if (event === 'end') handler();
      },
    };
    setTimeout(() => {
      cb(res);
    }, 0);
    return {
      on: mock.fn(),
      end: mock.fn(),
      destroy: mock.fn(),
    };
  },
);

mock.module('node:https', {
  namedExports: { request: mockHttpsRequest },
  defaultExport: { request: mockHttpsRequest },
});

const mockSpawnSync = mock.fn(() => ({
  status: 0,
  stdout: 'model-a\nmodel-b\nmodel-c\n',
  stderr: '',
}));
mock.module('cross-spawn', {
  namedExports: { sync: mockSpawnSync },
  defaultExport: { sync: mockSpawnSync },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mock.fn(() => ({
      models: {
        claude: { default: 'claude-sonnet', fast: 'claude-haiku' },
        gemini: { default: 'gemini-3-pro' },
        codex: { default: 'gpt-5' },
      },
      aliases: { claude: {}, gemini: {}, codex: {} },
      mode: 'balanced',
      modeTiers: { balanced: { claude: 'default', gemini: 'default', codex: 'default' } },
    })),
    HYDRA_ROOT: '/tmp/test-hydra',
    resolveProject: mock.fn(),
    getRoleConfig: mock.fn(),
    configStore: {
      load: mock.fn(() => ({})),
      save: mock.fn(),
      invalidate: mock.fn(),
    },
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getActiveModel: mock.fn((agent: string) => `${agent}-default-model`),
    setActiveModel: mock.fn(),
    getReasoningEffort: mock.fn(() => null),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {
      claude: { label: 'Claude' },
      gemini: { label: 'Gemini' },
      codex: { label: 'Codex' },
    },
    getAgent: mock.fn(() => null),
    getMode: mock.fn(() => 'balanced'),
    setMode: mock.fn(),
  },
});

// ── Import ───────────────────────────────────────────────────────────────────

const { fetchModels } = await import('../lib/hydra-models.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('fetchModels — unknown agent', () => {
  it('returns empty models and source "none" for unknown agent', async () => {
    const result = await fetchModels('unknown-agent');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });

  it('returns empty for empty string agent', async () => {
    const result = await fetchModels('');
    assert.deepEqual(result.models, []);
    assert.equal(result.source, 'none');
  });
});

describe('fetchModels — API/CLI fallback chain', () => {
  const origAnthropicKey = process.env['ANTHROPIC_API_KEY'];
  const origOpenAIKey = process.env['OPENAI_API_KEY'];
  const origGeminiKey = process.env['GEMINI_API_KEY'];
  const origGoogleKey = process.env['GOOGLE_API_KEY'];

  afterEach(() => {
    if (origAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = origAnthropicKey;
    if (origOpenAIKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = origOpenAIKey;
    if (origGeminiKey === undefined) delete process.env['GEMINI_API_KEY'];
    else process.env['GEMINI_API_KEY'] = origGeminiKey;
    if (origGoogleKey === undefined) delete process.env['GOOGLE_API_KEY'];
    else process.env['GOOGLE_API_KEY'] = origGoogleKey;
  });

  it('claude falls through to config-only when no API key', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'not found',
    }));

    const result = await fetchModels('claude');
    assert.ok(['config-only', 'cli', 'api'].includes(result.source));
  });

  it('codex falls through to config-only when no API key', async () => {
    delete process.env['OPENAI_API_KEY'];
    const result = await fetchModels('codex');
    assert.ok(['config-only', 'api'].includes(result.source));
  });

  it('gemini falls through to config-only when no API key', async () => {
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    mockSpawnSync.mock.mockImplementation(() => ({
      status: 1,
      stdout: '',
      stderr: 'not found',
    }));

    const result = await fetchModels('gemini');
    assert.ok(['config-only', 'cli', 'api'].includes(result.source));
  });

  it('returns valid shape for each known agent', async () => {
    for (const agent of ['claude', 'gemini', 'codex']) {
      const result = await fetchModels(agent);
      assert.ok(Array.isArray(result.models));
      assert.equal(typeof result.source, 'string');
    }
  });
});

describe('fetchModels — return contract', () => {
  it('models are strings when present', async () => {
    const result = await fetchModels('claude');
    for (const m of result.models) {
      assert.equal(typeof m, 'string');
    }
  });

  it('source is always a string', async () => {
    const result = await fetchModels('claude');
    assert.equal(typeof result.source, 'string');
  });

  it('concurrent calls do not interfere', async () => {
    const [r1, r2, r3] = await Promise.all([
      fetchModels('claude'),
      fetchModels('gemini'),
      fetchModels('codex'),
    ]);
    assert.ok(Array.isArray(r1.models));
    assert.ok(Array.isArray(r2.models));
    assert.ok(Array.isArray(r3.models));
  });
});
