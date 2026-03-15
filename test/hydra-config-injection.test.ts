/**
 * Injection tests for IConfigStore consumer adoption.
 *
 * Each consumer that now accepts an optional IConfigStore parameter is tested
 * with a mock store to verify DI works without touching the filesystem.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IConfigStore, HydraConfig, DeepPartial } from '../lib/types.ts';

// ── Shared mock factory ──────────────────────────────────────────────────────

function createMockStore(overrides: Partial<HydraConfig> = {}): IConfigStore {
  const base = {
    mode: 'performance',
    models: {},
    usage: {},
    roles: {},
    agents: { customAgents: [] },
    routing: { mode: 'balanced' },
    local: { enabled: false },
    copilot: {},
    context: {},
    ...overrides,
  } as unknown as HydraConfig;

  let saved: HydraConfig | null = null;

  return {
    load() {
      return saved ?? base;
    },
    save(config: DeepPartial<HydraConfig>) {
      saved = { ...base, ...config } as HydraConfig;
      return saved;
    },
    invalidate() {
      saved = null;
    },
  };
}

// ── hydra-concierge-providers: buildFallbackChain ────────────────────────────

describe('buildFallbackChain with injected IConfigStore', () => {
  // Wipe API keys so detectAvailableProviders returns empty
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
      savedEnv[k] = process.env[k];
      process.env[k] = '';
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }
  });

  it('uses default chain when config has no concierge section', async () => {
    const { buildFallbackChain } = await import('../lib/hydra-concierge-providers.ts');
    const store = createMockStore();
    const chain = buildFallbackChain(store);
    assert.ok(chain.length >= 3, 'default chain should have at least 3 entries');
    assert.equal(chain[0].provider, 'openai');
  });

  it('uses custom chain from config', async () => {
    const { buildFallbackChain } = await import('../lib/hydra-concierge-providers.ts');
    const store = createMockStore({
      concierge: {
        fallbackChain: [{ provider: 'google', model: 'gemini-test' }],
      },
    } as Partial<HydraConfig>);
    const chain = buildFallbackChain(store);
    assert.equal(chain.length, 1);
    assert.equal(chain[0].provider, 'google');
    assert.equal(chain[0].model, 'gemini-test');
    assert.equal(chain[0].available, false); // no API key set
  });
});

// ── hydra-telemetry: isTracingEnabled ────────────────────────────────────────

describe('isTracingEnabled with injected IConfigStore', () => {
  it('returns false when telemetry.enabled is false', async () => {
    const { isTracingEnabled } = await import('../lib/hydra-telemetry.ts');
    const store = createMockStore({
      telemetry: { enabled: false },
    } as unknown as Partial<HydraConfig>);
    const enabled = await isTracingEnabled(store);
    assert.equal(enabled, false);
  });

  it('returns false when OTel is not installed even if config allows it', async () => {
    const { isTracingEnabled } = await import('../lib/hydra-telemetry.ts');
    const store = createMockStore({
      telemetry: { enabled: true },
    } as unknown as Partial<HydraConfig>);
    // In a normal test environment, OTel is not installed
    const enabled = await isTracingEnabled(store);
    assert.equal(enabled, false);
  });
});

// ── hydra-intent-gate: gateIntent ────────────────────────────────────────────

describe('gateIntent with injected IConfigStore', () => {
  it('accepts store via opts and uses custom rewriteFn', async () => {
    const { gateIntent } = await import('../lib/hydra-intent-gate.ts');
    const store = createMockStore({
      local: { enabled: false, model: 'test-model', baseUrl: 'http://test:1234/v1' },
    } as unknown as Partial<HydraConfig>);

    // gateIntent with high confidence threshold to trigger rewrite path,
    // but use a custom rewriteFn so we don't actually call LLM
    const result = await gateIntent('implement authentication', {
      store,
      confidenceThreshold: 1.0,
      rewriteFn: (text: string) => Promise.resolve(`rewritten: ${text}`),
    });
    assert.equal(result.rewritten, true);
    assert.ok(result.text.startsWith('rewritten:'));
  });

  it('threads store to defaultRewriteFn (falls back gracefully without local LLM)', async () => {
    const { gateIntent } = await import('../lib/hydra-intent-gate.ts');
    const store = createMockStore({
      local: { enabled: false, model: 'mock-model', baseUrl: 'http://localhost:99999/v1' },
    } as unknown as Partial<HydraConfig>);

    // No rewriteFn — will try defaultRewriteFn which dynamic-imports hydra-local.
    // Without a running local LLM, the rewrite silently fails and falls back.
    const result = await gateIntent('x', {
      store,
      confidenceThreshold: 1.0, // force rewrite attempt
    });
    // The rewrite should fail gracefully — falls back to normalized text
    assert.equal(result.normalized, true);
  });

  it('normalizes without rewrite when confidence is high', async () => {
    const { gateIntent } = await import('../lib/hydra-intent-gate.ts');
    const store = createMockStore();
    const result = await gateIntent('write unit tests for the auth module', {
      store,
      confidenceThreshold: 0.0, // very low — should not trigger rewrite
    });
    assert.equal(result.normalized, true);
    assert.equal(result.rewritten, false);
  });
});

// ── hydra-model-recovery: IConfigStore injection ─────────────────────────────

describe('hydra-model-recovery with injected IConfigStore', () => {
  it('isModelRecoveryEnabled reads from injected store', async () => {
    const { isModelRecoveryEnabled } = await import('../lib/hydra-model-recovery.ts');

    const enabledStore = createMockStore({
      modelRecovery: { enabled: true },
    } as unknown as Partial<HydraConfig>);
    assert.equal(isModelRecoveryEnabled(enabledStore), true);

    const disabledStore = createMockStore({
      modelRecovery: { enabled: false },
    } as unknown as Partial<HydraConfig>);
    assert.equal(isModelRecoveryEnabled(disabledStore), false);
  });

  it('recordModelFailure reads circuit breaker config from injected store', async () => {
    const { recordModelFailure, isCircuitOpen } = await import('../lib/hydra-model-recovery.ts');

    const store = createMockStore({
      modelRecovery: {
        circuitBreaker: { enabled: true, failureThreshold: 2, windowMs: 60_000 },
      },
    } as unknown as Partial<HydraConfig>);

    // Record failures through the injected store
    recordModelFailure('test-model-abc', store);
    assert.equal(
      isCircuitOpen('test-model-abc', store),
      false,
      'should not be open after 1 failure',
    );

    recordModelFailure('test-model-abc', store);
    assert.equal(isCircuitOpen('test-model-abc', store), true, 'should be open after 2 failures');
  });

  it('recordModelFailure is a no-op when circuit breaker is disabled', async () => {
    const { recordModelFailure, isCircuitOpen } = await import('../lib/hydra-model-recovery.ts');

    const store = createMockStore({
      modelRecovery: {
        circuitBreaker: { enabled: false },
      },
    } as unknown as Partial<HydraConfig>);

    recordModelFailure('disabled-model', store);
    recordModelFailure('disabled-model', store);
    recordModelFailure('disabled-model', store);
    assert.equal(isCircuitOpen('disabled-model', store), false);
  });

  it('getFallbackCandidates reads models/aliases from injected store', async () => {
    const { getFallbackCandidates } = await import('../lib/hydra-model-recovery.ts');

    const store = createMockStore({
      models: {
        codex: { default: 'gpt-5', fast: 'gpt-4.1', cheap: 'gpt-4.1-mini', active: 'default' },
      },
      aliases: {
        codex: { myalias: 'gpt-5.1' },
      },
    } as unknown as Partial<HydraConfig>);

    const candidates = getFallbackCandidates('codex', 'gpt-5', store);
    // Should include alternatives from the models config, excluding the failed model
    assert.ok(Array.isArray(candidates));
    // The failed model (gpt-5) should not be in the candidate list
    for (const c of candidates) {
      assert.notEqual(c.id.toLowerCase(), 'gpt-5');
    }
  });

  it('recoverFromModelError returns recovered:false when disabled', async () => {
    const { recoverFromModelError } = await import('../lib/hydra-model-recovery.ts');

    const store = createMockStore({
      modelRecovery: { enabled: false },
    } as unknown as Partial<HydraConfig>);

    const result = await recoverFromModelError('codex', 'gpt-5', {}, store);
    assert.equal(result.recovered, false);
    assert.equal(result.newModel, null);
  });
});
