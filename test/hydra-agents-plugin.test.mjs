import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

// getAgent is the public registry accessor
import { getAgent, registerAgent, unregisterAgent, AGENT_TYPE } from '../lib/hydra-agents.mjs';
import { loadHydraConfig } from '../lib/hydra-config.mjs';

describe('Agent Plugin Interface', () => {
  // ── Shape tests — all 4 physical agents ──────────────────────────────────
  describe('plugin interface shape', () => {
    for (const name of ['claude', 'gemini', 'codex', 'local']) {
      it(`${name} has all required plugin fields`, () => {
        const agent = getAgent(name);
        assert.ok(agent, `getAgent('${name}') must return a definition`);

        // features
        assert.ok(agent.features, 'features must be present');
        assert.ok(['spawn', 'api'].includes(agent.features.executeMode), 'executeMode must be spawn or api');
        assert.equal(typeof agent.features.jsonOutput, 'boolean', 'jsonOutput must be boolean');
        assert.equal(typeof agent.features.stdinPrompt, 'boolean', 'stdinPrompt must be boolean');
        assert.equal(typeof agent.features.reasoningEffort, 'boolean', 'reasoningEffort must be boolean');

        // methods
        assert.equal(typeof agent.parseOutput, 'function', 'parseOutput must be a function');
        assert.equal(typeof agent.errorPatterns, 'object', 'errorPatterns must be an object');
        assert.equal(typeof agent.modelBelongsTo, 'function', 'modelBelongsTo must be a function');
        assert.equal(typeof agent.quotaVerify, 'function', 'quotaVerify must be a function');
        assert.equal(typeof agent.economyModel, 'function', 'economyModel must be a function');
        assert.equal(typeof agent.readInstructions, 'function', 'readInstructions must be a function');
        assert.ok(Array.isArray(agent.taskRules), 'taskRules must be an array');
      });
    }
  });

  // ── feature flags ─────────────────────────────────────────────────────────
  describe('feature flags', () => {
    it('claude: spawn, jsonOutput=true, stdinPrompt=true, reasoningEffort=false', () => {
      const a = getAgent('claude');
      assert.equal(a.features.executeMode, 'spawn');
      assert.equal(a.features.jsonOutput, true);
      assert.equal(a.features.stdinPrompt, true);
      assert.equal(a.features.reasoningEffort, false);
    });

    it('gemini: spawn, jsonOutput=true, stdinPrompt=false, reasoningEffort=false', () => {
      const a = getAgent('gemini');
      assert.equal(a.features.executeMode, 'spawn');
      assert.equal(a.features.jsonOutput, true);
      assert.equal(a.features.stdinPrompt, false);
      assert.equal(a.features.reasoningEffort, false);
    });

    it('codex: spawn, jsonOutput=true, stdinPrompt=true, reasoningEffort=true', () => {
      const a = getAgent('codex');
      assert.equal(a.features.executeMode, 'spawn');
      assert.equal(a.features.jsonOutput, true);
      assert.equal(a.features.stdinPrompt, true);
      assert.equal(a.features.reasoningEffort, true);
    });

    it('local: api, all feature flags false', () => {
      const a = getAgent('local');
      assert.equal(a.features.executeMode, 'api');
      assert.equal(a.features.jsonOutput, false);
      assert.equal(a.features.stdinPrompt, false);
      assert.equal(a.features.reasoningEffort, false);
    });
  });

  // ── registerAgent() defaults ──────────────────────────────────────────────
  describe('registerAgent() default-filling', () => {
    const TEST_AGENT = 'test-minimal-agent';

    before(() => {
      // Register a minimal agent — no plugin fields defined
      registerAgent(TEST_AGENT, {
        type: AGENT_TYPE.PHYSICAL,
        displayName: 'Test Agent',
        cli: 'test-cli',
        invoke: {
          nonInteractive: (p) => ['test-cli', [p]],
          interactive: (p) => ['test-cli', [p]],
          headless: (p) => ['test-cli', [p]],
        },
      });
    });

    after(() => {
      // Clean up the test agent to avoid polluting the shared registry for other tests.
      try { unregisterAgent(TEST_AGENT); } catch { /* already gone */ }
    });

    it('fills all plugin fields with defaults', () => {
      const a = getAgent(TEST_AGENT);
      assert.ok(a, 'agent must be registered');
      assert.equal(a.features.executeMode, 'spawn');
      assert.equal(a.features.jsonOutput, false);
      assert.equal(a.features.stdinPrompt, false);
      assert.equal(a.features.reasoningEffort, false);
      assert.equal(typeof a.parseOutput, 'function');
      assert.deepEqual(a.errorPatterns, {});
      assert.equal(typeof a.modelBelongsTo, 'function');
      assert.equal(a.modelBelongsTo('anything'), false);
      assert.equal(typeof a.quotaVerify, 'function');
      assert.equal(typeof a.economyModel, 'function');
      assert.equal(a.economyModel(), null);
      assert.equal(typeof a.readInstructions, 'function');
      assert.equal(a.readInstructions('CLAUDE.md'), 'Read CLAUDE.md first.');
      assert.deepEqual(a.taskRules, []);
    });

    it('parseOutput default returns passthrough', () => {
      const a = getAgent(TEST_AGENT);
      const result = a.parseOutput('hello world');
      assert.deepEqual(result, { output: 'hello world', tokenUsage: null, costUsd: null });
    });

    it('api-type custom agent gets executeMode=api default', () => {
      const apiAgent = 'test-api-agent';
      registerAgent(apiAgent, {
        type: AGENT_TYPE.PHYSICAL,
        displayName: 'Test API Agent',
        cli: null,
        customType: 'api',
        invoke: { nonInteractive: null, interactive: null, headless: null },
      });
      const a = getAgent(apiAgent);
      assert.equal(a.features.executeMode, 'api');
      unregisterAgent(apiAgent);
    });
  });

  // ── claude.parseOutput ────────────────────────────────────────────────────
  describe('claude.parseOutput', () => {
    const claude = () => getAgent('claude');

    it('extracts output + token usage from valid result JSON', () => {
      const stdout = JSON.stringify({
        type: 'result',
        result: 'Hello world',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
        },
        cost_usd: 0.001,
      });
      const result = claude().parseOutput(stdout);
      assert.equal(result.output, 'Hello world');
      assert.deepEqual(result.tokenUsage, {
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationTokens: 10,
        cacheReadTokens: 5,
        totalTokens: 150,
      });
      assert.equal(result.costUsd, 0.001);
    });

    it('falls back to raw stdout on non-result JSON', () => {
      const stdout = JSON.stringify({ type: 'thinking', content: 'hmm' });
      const result = claude().parseOutput(stdout);
      assert.equal(result.output, stdout);
      assert.equal(result.tokenUsage, null);
    });

    it('falls back to raw stdout on non-JSON', () => {
      const result = claude().parseOutput('plain text output');
      assert.equal(result.output, 'plain text output');
      assert.equal(result.tokenUsage, null);
      assert.equal(result.costUsd, null);
    });

    it('uses content field when result field absent', () => {
      const stdout = JSON.stringify({ type: 'result', content: 'from content field', usage: {} });
      const result = claude().parseOutput(stdout);
      assert.equal(result.output, 'from content field');
    });
  });

  // ── codex.parseOutput ─────────────────────────────────────────────────────
  describe('codex.parseOutput', () => {
    const codex = () => getAgent('codex');

    it('accumulates message content across JSONL lines', () => {
      const lines = [
        JSON.stringify({ type: 'message', content: 'Hello ' }),
        JSON.stringify({ type: 'message', content: 'world' }),
        JSON.stringify({ type: 'usage', usage: { input_tokens: 20, output_tokens: 10 } }),
      ];
      const result = codex().parseOutput(lines.join('\n'));
      assert.equal(result.output, 'Hello world');
      assert.equal(result.tokenUsage.inputTokens, 20);
      assert.equal(result.tokenUsage.outputTokens, 10);
      assert.equal(result.tokenUsage.totalTokens, 30);
    });

    it('skips non-JSON lines without throwing', () => {
      const stdout = 'Starting up...\n' + JSON.stringify({ type: 'message', content: 'done' }) + '\nnoise';
      const result = codex().parseOutput(stdout);
      assert.equal(result.output, 'done');
    });

    it('falls back to raw stdout when no message lines found', () => {
      const result = codex().parseOutput('pure text output');
      assert.equal(result.output, 'pure text output');
      assert.equal(result.tokenUsage, null);
    });

    it('accumulates tokens from multiple usage events', () => {
      const lines = [
        JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }),
        JSON.stringify({ usage: { input_tokens: 20, output_tokens: 8 } }),
      ];
      const result = codex().parseOutput(lines.join('\n'));
      assert.equal(result.tokenUsage.inputTokens, 30);
      assert.equal(result.tokenUsage.outputTokens, 13);
      assert.equal(result.tokenUsage.totalTokens, 43);
    });
  });

  // ── modelBelongsTo ────────────────────────────────────────────────────────
  describe('modelBelongsTo', () => {
    it('claude owns claude- prefixed models', () => {
      assert.equal(getAgent('claude').modelBelongsTo('claude-opus-4-6'), true);
      assert.equal(getAgent('claude').modelBelongsTo('gpt-5'), false);
    });

    it('gemini owns gemini- prefixed models', () => {
      assert.equal(getAgent('gemini').modelBelongsTo('gemini-3-pro-preview'), true);
      assert.equal(getAgent('gemini').modelBelongsTo('claude-opus-4-6'), false);
    });

    it('codex owns gpt-, o1, o3, o4, o5, codex prefixed models', () => {
      const codex = getAgent('codex');
      assert.equal(codex.modelBelongsTo('gpt-5.4'), true);
      assert.equal(codex.modelBelongsTo('o4-mini'), true);
      assert.equal(codex.modelBelongsTo('o3-large'), true);
      assert.equal(codex.modelBelongsTo('codex-mini'), true);
      assert.equal(codex.modelBelongsTo('claude-opus-4-6'), false);
    });

    it('local only matches its configured model, not arbitrary model IDs', () => {
      const local = getAgent('local');
      const cfg = loadHydraConfig();
      const configuredModel = cfg.local?.model;
      // Matches exactly the configured model (case-insensitive)
      if (configuredModel) {
        assert.equal(local.modelBelongsTo(configuredModel), true);
        assert.equal(local.modelBelongsTo(configuredModel.toUpperCase()), true);
      }
      // Does NOT claim unrelated model IDs
      assert.equal(local.modelBelongsTo('claude-opus-4-6'), false);
      assert.equal(local.modelBelongsTo('gpt-5.4'), false);
      assert.equal(local.modelBelongsTo('gemini-3-pro'), false);
    });
  });

  // ── economyModel ──────────────────────────────────────────────────────────
  describe('economyModel', () => {
    it('claude returns fixed economy model', () => {
      assert.equal(getAgent('claude').economyModel(), 'claude-sonnet-4-5-20250929');
    });

    it('gemini returns fixed economy model', () => {
      assert.equal(getAgent('gemini').economyModel(), 'gemini-3-flash-preview');
    });

    it('codex uses handoffModel from budgetCfg when provided', () => {
      assert.equal(getAgent('codex').economyModel({ handoffModel: 'o4-mini-custom' }), 'o4-mini-custom');
    });

    it('codex defaults to o4-mini when no budgetCfg', () => {
      assert.equal(getAgent('codex').economyModel(), 'o4-mini');
    });

    it('local returns null', () => {
      assert.equal(getAgent('local').economyModel(), null);
    });
  });

  // ── taskRules ─────────────────────────────────────────────────────────────
  describe('taskRules', () => {
    it('claude has a taskRules array with one entry', () => {
      const rules = getAgent('claude').taskRules;
      assert.ok(Array.isArray(rules));
      assert.ok(rules.length > 0);
      assert.ok(rules[0].includes('Codex'), 'claude rule should mention Codex');
    });

    it('codex has a taskRules array', () => {
      const rules = getAgent('codex').taskRules;
      assert.ok(Array.isArray(rules));
      assert.ok(rules.length > 0);
    });

    it('local has empty taskRules', () => {
      assert.deepEqual(getAgent('local').taskRules, []);
    });
  });
});
