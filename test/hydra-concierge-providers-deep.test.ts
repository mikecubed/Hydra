/**
 * Deep coverage tests for hydra-concierge-providers.ts — provider detection,
 * fallback chain building, streaming with fallback, and provider label formatting.
 *
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock State ────────────────────────────────────────────────────────────────

const envBackup: Record<string, string | undefined> = {};

function setEnvKey(k: string, v: string | undefined): void {
  if (v === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- env cleanup requires delete
    delete process.env[k];
  } else {
    process.env[k] = v;
  }
}

function setEnvKeys(keys: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(keys)) {
    envBackup[k] = process.env[k];
    setEnvKey(k, v);
  }
}

function restoreEnv(): void {
  for (const [k, v] of Object.entries(envBackup)) {
    setEnvKey(k, v);
  }
}

// ── Mock streamCompletion functions ───────────────────────────────────────────

const mockOpenAIStream = mock.fn(
  async (_messages: unknown[], _cfg: Record<string, unknown>, onChunk: (chunk: string) => void) => {
    onChunk('openai-chunk');
    return { fullResponse: 'openai-response', usage: { tokens: 100 } };
  },
);

const mockAnthropicStream = mock.fn(
  async (_messages: unknown[], _cfg: Record<string, unknown>, onChunk: (chunk: string) => void) => {
    onChunk('anthropic-chunk');
    return { fullResponse: 'anthropic-response', usage: { tokens: 200 } };
  },
);

const mockGoogleStream = mock.fn(
  async (_messages: unknown[], _cfg: Record<string, unknown>, onChunk: (chunk: string) => void) => {
    onChunk('google-chunk');
    return { fullResponse: 'google-response', usage: { tokens: 150 } };
  },
);

// ── Module Mocks ──────────────────────────────────────────────────────────────

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    configStore: {
      load: () => ({
        concierge: {
          fallbackChain: [
            { provider: 'openai', model: 'gpt-5' },
            { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
            { provider: 'google', model: 'gemini-3-flash-preview' },
          ],
        },
      }),
    },
    loadHydraConfig: () => ({}),
    resolveProject: () => ({
      projectRoot: '/tmp/test',
      projectName: 'test',
    }),
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getModelReasoningCaps: (model: string) => {
      if (model.includes('claude')) {
        return {
          type: 'thinking',
          budgets: { deep: 16000, standard: 8000, light: 4000 },
        };
      }
      return { type: 'none', budgets: {} };
    },
  },
});

mock.module('../lib/hydra-rate-limits.ts', {
  namedExports: {
    canMakeRequest: () => ({ allowed: true }),
    getHealthiestProvider: (chain: unknown[]) => chain,
  },
});

mock.module('../lib/hydra-openai.ts', {
  namedExports: { streamCompletion: mockOpenAIStream },
});

mock.module('../lib/hydra-anthropic.ts', {
  namedExports: { streamAnthropicCompletion: mockAnthropicStream },
});

mock.module('../lib/hydra-google.ts', {
  namedExports: { streamGoogleCompletion: mockGoogleStream },
});

// ── Import module under test ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import type needed for mock pattern
type ProvidersMod = typeof import('../lib/hydra-concierge-providers.ts');
let mod: ProvidersMod;

before(async () => {
  mod = await import('../lib/hydra-concierge-providers.ts');
});

afterEach(() => {
  restoreEnv();
  mockOpenAIStream.mock.resetCalls();
  mockAnthropicStream.mock.resetCalls();
  mockGoogleStream.mock.resetCalls();
});

// ── detectAvailableProviders ──────────────────────────────────────────────────

describe('detectAvailableProviders', () => {
  it('detects openai when OPENAI_API_KEY is set', () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk-test',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const result = mod.detectAvailableProviders();
    const providers = result.map((r) => r.provider);
    assert.ok(providers.includes('openai'));
  });

  it('detects anthropic when ANTHROPIC_API_KEY is set', () => {
    setEnvKeys({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: 'sk-ant-test',
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const result = mod.detectAvailableProviders();
    const providers = result.map((r) => r.provider);
    assert.ok(providers.includes('anthropic'));
    assert.ok(!providers.includes('openai'));
  });

  it('detects google when GEMINI_API_KEY is set', () => {
    setEnvKeys({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: 'goog-test',
      GOOGLE_API_KEY: undefined,
    });
    const result = mod.detectAvailableProviders();
    const providers = result.map((r) => r.provider);
    assert.ok(providers.includes('google'));
  });

  it('detects google when GOOGLE_API_KEY is set as fallback', () => {
    setEnvKeys({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: 'goog-fallback',
    });
    const result = mod.detectAvailableProviders();
    const providers = result.map((r) => r.provider);
    assert.ok(providers.includes('google'));
  });

  it('returns empty when no keys configured', () => {
    setEnvKeys({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const result = mod.detectAvailableProviders();
    assert.equal(result.length, 0);
  });

  it('returns all providers when all keys set', () => {
    setEnvKeys({ OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ant', GEMINI_API_KEY: 'gem' });
    const result = mod.detectAvailableProviders();
    assert.equal(result.length, 3);
  });

  it('skips providers with empty string keys', () => {
    setEnvKeys({
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: 'ant',
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const result = mod.detectAvailableProviders();
    const providers = result.map((r) => r.provider);
    assert.ok(!providers.includes('openai'));
    assert.ok(providers.includes('anthropic'));
  });
});

// ── buildFallbackChain ────────────────────────────────────────────────────────

describe('buildFallbackChain', () => {
  it('returns chain with availability flags', () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const chain = mod.buildFallbackChain();
    assert.ok(chain.length > 0);
    const openaiEntry = chain.find((e) => e.provider === 'openai');
    assert.ok(openaiEntry);
    assert.equal(openaiEntry.available, true);
    const anthropicEntry = chain.find((e) => e.provider === 'anthropic');
    assert.ok(anthropicEntry);
    assert.equal(anthropicEntry.available, false);
  });

  it('uses config fallback chain', () => {
    setEnvKeys({ OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ant', GEMINI_API_KEY: 'gem' });
    const chain = mod.buildFallbackChain();
    assert.equal(chain.length, 3);
    assert.equal(chain[0].provider, 'openai');
    assert.equal(chain[1].provider, 'anthropic');
    assert.equal(chain[2].provider, 'google');
  });

  it('accepts custom config store', () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const customStore = {
      load: () => ({
        concierge: {
          fallbackChain: [{ provider: 'openai', model: 'custom-model' }],
        },
      }),
    };
    const chain = mod.buildFallbackChain(
      customStore as Parameters<typeof mod.buildFallbackChain>[0],
    );
    assert.equal(chain.length, 1);
    assert.equal(chain[0].model, 'custom-model');
  });

  it('uses defaults when config has no fallbackChain', () => {
    setEnvKeys({ OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ant', GEMINI_API_KEY: 'gem' });
    const emptyStore = {
      load: () => ({ concierge: {} }),
    };
    const chain = mod.buildFallbackChain(
      emptyStore as Parameters<typeof mod.buildFallbackChain>[0],
    );
    assert.ok(chain.length >= 3);
  });
});

// ── providerLabel ─────────────────────────────────────────────────────────────

describe('providerLabel', () => {
  it('formats primary provider label without arrow', () => {
    const result = mod.providerLabel('openai', 'gpt-5', false);
    assert.equal(result, 'openai:gpt-5');
  });

  it('formats fallback provider label with arrow', () => {
    const result = mod.providerLabel('anthropic', 'claude-sonnet', true);
    assert.ok(result.includes('anthropic:claude-sonnet'));
    assert.ok(result.includes('\u2193')); // down arrow
  });
});

// ── streamWithFallback ────────────────────────────────────────────────────────

describe('streamWithFallback', () => {
  it('streams through first available provider', async () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const chunks: string[] = [];
    const result = await mod.streamWithFallback(
      [{ role: 'user', content: 'hello' }],
      { temperature: 0.7 },
      (chunk) => chunks.push(chunk),
    );
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-5');
    assert.equal(result.isFallback, false);
    assert.equal(result.fullResponse, 'openai-response');
    assert.ok(chunks.includes('openai-chunk'));
  });

  it('falls back to next provider on failure', async () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: 'ant',
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    mockOpenAIStream.mock.mockImplementation(async () => {
      throw new Error('OpenAI rate limited');
    });
    const chunks: string[] = [];
    const result = await mod.streamWithFallback([{ role: 'user', content: 'hello' }], {}, (chunk) =>
      chunks.push(chunk),
    );
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.isFallback, true);
    // Restore
    mockOpenAIStream.mock.mockImplementation(
      async (_m: unknown[], _c: unknown, onChunk: (c: string) => void) => {
        onChunk('openai-chunk');
        return { fullResponse: 'openai-response', usage: { tokens: 100 } };
      },
    );
  });

  it('throws when no API keys configured', async () => {
    setEnvKeys({
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    await assert.rejects(() => mod.streamWithFallback([], {}, () => {}), /No API keys configured/);
  });

  it('throws combined error when all providers fail', async () => {
    setEnvKeys({ OPENAI_API_KEY: 'sk', ANTHROPIC_API_KEY: 'ant', GEMINI_API_KEY: 'gem' });
    mockOpenAIStream.mock.mockImplementation(async () => {
      throw new Error('openai fail');
    });
    mockAnthropicStream.mock.mockImplementation(async () => {
      throw new Error('anthropic fail');
    });
    mockGoogleStream.mock.mockImplementation(async () => {
      throw new Error('google fail');
    });

    await assert.rejects(
      () => mod.streamWithFallback([], {}, () => {}),
      /All concierge providers failed/,
    );

    // Restore all mocks
    mockOpenAIStream.mock.mockImplementation(
      async (_m: unknown[], _c: unknown, onChunk: (c: string) => void) => {
        onChunk('openai-chunk');
        return { fullResponse: 'openai-response', usage: { tokens: 100 } };
      },
    );
    mockAnthropicStream.mock.mockImplementation(
      async (_m: unknown[], _c: unknown, onChunk: (c: string) => void) => {
        onChunk('anthropic-chunk');
        return { fullResponse: 'anthropic-response', usage: { tokens: 200 } };
      },
    );
    mockGoogleStream.mock.mockImplementation(
      async (_m: unknown[], _c: unknown, onChunk: (c: string) => void) => {
        onChunk('google-chunk');
        return { fullResponse: 'google-response', usage: { tokens: 150 } };
      },
    );
  });

  it('passes model from chain entry, not cfg', async () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    await mod.streamWithFallback(
      [{ role: 'user', content: 'test' }],
      { model: 'should-be-overridden' },
      () => {},
    );
    const call = mockOpenAIStream.mock.calls[0];
    const passedCfg = call.arguments[1];
    assert.equal(passedCfg['model'], 'gpt-5');
  });

  it('returns usage from provider', async () => {
    setEnvKeys({
      OPENAI_API_KEY: 'sk',
      ANTHROPIC_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      GOOGLE_API_KEY: undefined,
    });
    const result = await mod.streamWithFallback([], {}, () => {});
    assert.deepEqual(result.usage, { tokens: 100 });
  });
});
