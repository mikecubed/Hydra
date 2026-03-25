/* eslint-disable @typescript-eslint/no-dynamic-delete -- test env cleanup */
/**
 * Deep coverage tests for lib/hydra-models.ts
 *
 * Mocks HTTP, CLI spawning, and config to exercise fetchModels, parseModelLines,
 * and display functions.
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock state ──────────────────────────────────────────────────────────────

const mockHttpsRequest = mock.fn(
  (
    _url: string,
    _opts: Record<string, unknown>,
    cb: (res: { on: (e: string, handler: (data?: string) => void) => void }) => void,
  ) => {
    const req = {
      on: mock.fn((_e: string, _handler: unknown) => req),
      end: mock.fn(),
      destroy: mock.fn(),
    };
    // Simulate async response
    setTimeout(() => {
      const chunks: string[] = [];
      const res = {
        on: (event: string, handler: (data?: string) => void) => {
          if (event === 'data') chunks.push('{"data":[]}');
          if (event === 'data') handler('{"data":[]}');
          if (event === 'end')
            setTimeout(() => {
              handler();
            }, 0);
          return res;
        },
      };
      cb(res);
    }, 0);
    return req;
  },
);

const mockSpawnSync = mock.fn(() => ({
  status: 0,
  stdout: 'model-a\nmodel-b\n',
  stderr: '',
}));

const mockLoadConfig = mock.fn(() => ({
  models: {
    claude: { default: 'claude-opus-4', fast: 'claude-haiku' },
    gemini: { default: 'gemini-3-pro' },
    codex: { default: 'gpt-5' },
  },
  aliases: {
    claude: { opus: 'claude-opus-4' },
    gemini: {},
    codex: {},
  },
  mode: 'balanced',
  modeTiers: { balanced: { claude: 'default', gemini: 'default', codex: 'default' } },
  routing: { mode: 'balanced' },
}));

const mockGetActiveModel = mock.fn((_agent: string) => 'test-model');
const mockGetReasoningEffort = mock.fn((_agent: string) => null as string | null);

// ── Module mocks ────────────────────────────────────────────────────────────

mock.module('node:https', {
  namedExports: {
    request: (...args: unknown[]) =>
      mockHttpsRequest(...(args as Parameters<typeof mockHttpsRequest>)),
  },
  defaultExport: {
    request: (...args: unknown[]) =>
      mockHttpsRequest(...(args as Parameters<typeof mockHttpsRequest>)),
  },
});

mock.module('cross-spawn', {
  defaultExport: {
    sync: (...args: unknown[]) => mockSpawnSync(...(args as Parameters<typeof mockSpawnSync>)),
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: () => mockLoadConfig(),
    resolveProject: () => ({ projectRoot: '/tmp/test', projectName: 'test' }),
    _setTestConfig: () => {},
    invalidateConfigCache: () => {},
    HYDRA_ROOT: '/tmp/hydra',
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getActiveModel: (agent: string) => mockGetActiveModel(agent),
    getReasoningEffort: (agent: string) => mockGetReasoningEffort(agent),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {
      claude: { label: 'Claude' },
      gemini: { label: 'Gemini' },
      codex: { label: 'Codex' },
    },
    getAgent: () => null,
    getMode: () => 'balanced',
    initAgentRegistry: () => {},
    _resetRegistry: () => {},
    formatEffortDisplay: () => '',
    registerAgent: () => {},
    unregisterAgent: () => {},
    getModelSummary: () => ({}),
    AGENT_TYPE: {},
  },
});

// ── Import under test (AFTER mocks) ────────────────────────────────────────

const { fetchModels } = await import('../lib/hydra-models.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('hydra-models-deep', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockHttpsRequest.mock.resetCalls();
    mockSpawnSync.mock.resetCalls();
    mockLoadConfig.mock.resetCalls();
    mockGetActiveModel.mock.resetCalls();
    mockGetReasoningEffort.mock.resetCalls();
    // Save env vars
    originalEnv['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
    originalEnv['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'];
    originalEnv['GEMINI_API_KEY'] = process.env['GEMINI_API_KEY'];
    originalEnv['GOOGLE_API_KEY'] = process.env['GOOGLE_API_KEY'];
    // Clear all API keys
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(originalEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe('fetchModels', () => {
    it('returns empty for unknown agent', async () => {
      const result = await fetchModels('unknown');
      assert.deepEqual(result, { models: [], source: 'none' });
    });

    it('falls back to config-only when no API key and CLI fails', async () => {
      mockSpawnSync.mock.mockImplementation(() => ({
        status: 1,
        stdout: null,
        stderr: 'not found',
      }));

      const result = await fetchModels('claude');
      assert.equal(result.source, 'config-only');
      assert.deepEqual(result.models, []);
    });

    it('returns CLI models when CLI succeeds', async () => {
      mockSpawnSync.mock.mockImplementation(() => ({
        status: 0,
        stdout: 'claude-opus-4\nclaude-sonnet-4\nclaude-haiku\n',
        stderr: '',
      }));

      const result = await fetchModels('claude');
      assert.equal(result.source, 'cli');
      assert.ok(result.models.length > 0);
    });

    it('filters out noisy CLI output lines', async () => {
      mockSpawnSync.mock.mockImplementation(() => ({
        status: 0,
        stdout: [
          'Loaded config',
          'Hook registered',
          '# Comment line',
          '- bullet line',
          '* star line',
          'model with spaces not valid',
          'claude-opus-4',
          'claude-sonnet-4',
          '',
        ].join('\n'),
        stderr: '',
      }));

      const result = await fetchModels('claude');
      assert.equal(result.source, 'cli');
      assert.ok(result.models.includes('claude-opus-4'));
      assert.ok(result.models.includes('claude-sonnet-4'));
      assert.ok(!result.models.some((m) => m.includes('Loaded')));
    });

    it('codex CLI always returns null (skipped)', async () => {
      const result = await fetchModels('codex');
      assert.equal(result.source, 'config-only');
    });

    it('gemini CLI returns models', async () => {
      mockSpawnSync.mock.mockImplementation(() => ({
        status: 0,
        stdout: 'gemini-3-pro\ngemini-3-flash\n',
        stderr: '',
      }));

      const result = await fetchModels('gemini');
      assert.equal(result.source, 'cli');
      assert.ok(result.models.length > 0);
    });

    it('handles CLI that returns empty stdout', async () => {
      mockSpawnSync.mock.mockImplementation(() => ({
        status: 0,
        stdout: '',
        stderr: '',
      }));

      const result = await fetchModels('claude');
      assert.equal(result.source, 'config-only');
    });

    it('handles CLI exception', async () => {
      mockSpawnSync.mock.mockImplementation(() => {
        throw new Error('CLI not found');
      });

      const result = await fetchModels('claude');
      assert.equal(result.source, 'config-only');
    });
  });

  describe('fetchModels with API keys', () => {
    it('claude API returns models with ANTHROPIC_API_KEY', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      // Setup mock to simulate successful HTTP response
      mockHttpsRequest.mock.mockImplementation(
        (
          _url: string,
          _opts: Record<string, unknown>,
          cb: (res: { on: (e: string, handler: (data?: string) => void) => void }) => void,
        ) => {
          const req = {
            on: mock.fn((_e: string, _handler: unknown) => req),
            end: mock.fn(),
            destroy: mock.fn(),
          };
          setTimeout(() => {
            cb({
              on: (event: string, handler: (data?: string) => void) => {
                if (event === 'data')
                  handler(
                    JSON.stringify({
                      data: [{ id: 'claude-opus-4' }, { id: 'claude-sonnet-4' }],
                    }),
                  );
                if (event === 'end')
                  setTimeout(() => {
                    handler();
                  }, 0);
                return { on: () => ({}) };
              },
            } as never);
          }, 0);
          return req;
        },
      );

      const result = await fetchModels('claude');
      assert.equal(result.source, 'api');
      assert.ok(result.models.includes('claude-opus-4'));
    });

    it('codex API returns models with OPENAI_API_KEY', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';

      mockHttpsRequest.mock.mockImplementation(
        (
          _url: string,
          _opts: Record<string, unknown>,
          cb: (res: { on: (e: string, handler: (data?: string) => void) => void }) => void,
        ) => {
          const req = {
            on: mock.fn((_e: string, _handler: unknown) => req),
            end: mock.fn(),
            destroy: mock.fn(),
          };
          setTimeout(() => {
            cb({
              on: (event: string, handler: (data?: string) => void) => {
                if (event === 'data')
                  handler(JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-4.1' }] }));
                if (event === 'end')
                  setTimeout(() => {
                    handler();
                  }, 0);
                return { on: () => ({}) };
              },
            } as never);
          }, 0);
          return req;
        },
      );

      const result = await fetchModels('codex');
      assert.equal(result.source, 'api');
      assert.ok(result.models.includes('gpt-5'));
    });

    it('gemini API returns models with GEMINI_API_KEY', async () => {
      process.env['GEMINI_API_KEY'] = 'test-key';

      mockHttpsRequest.mock.mockImplementation(
        (
          _url: string,
          _opts: Record<string, unknown>,
          cb: (res: { on: (e: string, handler: (data?: string) => void) => void }) => void,
        ) => {
          const req = {
            on: mock.fn((_e: string, _handler: unknown) => req),
            end: mock.fn(),
            destroy: mock.fn(),
          };
          setTimeout(() => {
            cb({
              on: (event: string, handler: (data?: string) => void) => {
                if (event === 'data')
                  handler(
                    JSON.stringify({
                      models: [{ name: 'models/gemini-3-pro' }, { name: 'models/gemini-3-flash' }],
                    }),
                  );
                if (event === 'end')
                  setTimeout(() => {
                    handler();
                  }, 0);
                return { on: () => ({}) };
              },
            } as never);
          }, 0);
          return req;
        },
      );

      const result = await fetchModels('gemini');
      assert.equal(result.source, 'api');
      assert.ok(result.models.includes('gemini-3-pro'));
    });

    it('falls back to CLI when API fails', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      mockHttpsRequest.mock.mockImplementation(
        (_url: string, _opts: Record<string, unknown>, _cb: unknown) => {
          const req = {
            on: (e: string, handler: (err: Error) => void) => {
              if (e === 'error')
                setTimeout(() => {
                  handler(new Error('API down'));
                }, 0);
              return req;
            },
            end: mock.fn(),
            destroy: mock.fn(),
          };
          return req;
        },
      );

      mockSpawnSync.mock.mockImplementation(() => ({
        status: 0,
        stdout: 'claude-opus-4\n',
        stderr: '',
      }));

      const result = await fetchModels('claude');
      // Should fall back to CLI
      assert.ok(result.source === 'cli' || result.source === 'config-only');
    });

    it('gemini falls back to GOOGLE_API_KEY', async () => {
      process.env['GOOGLE_API_KEY'] = 'test-google-key';

      mockHttpsRequest.mock.mockImplementation(
        (
          _url: string,
          _opts: Record<string, unknown>,
          cb: (res: { on: (e: string, handler: (data?: string) => void) => void }) => void,
        ) => {
          const req = {
            on: mock.fn((_e: string, _handler: unknown) => req),
            end: mock.fn(),
            destroy: mock.fn(),
          };
          setTimeout(() => {
            cb({
              on: (event: string, handler: (data?: string) => void) => {
                if (event === 'data')
                  handler(JSON.stringify({ models: [{ name: 'models/gemini-3-pro' }] }));
                if (event === 'end')
                  setTimeout(() => {
                    handler();
                  }, 0);
                return { on: () => ({}) };
              },
            } as never);
          }, 0);
          return req;
        },
      );

      const result = await fetchModels('gemini');
      assert.equal(result.source, 'api');
    });
  });
});
