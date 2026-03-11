/**
 * Tests for the Copilot physical agent definition.
 *
 * Verifies plugin interface fields consumed by the data-driven executor,
 * metrics, usage, and recovery modules.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDef } from '../lib/types.ts';

describe('copilot agent definition', () => {
  let getAgent: (name: string) => AgentDef;
  let _setTestConfig: (cfg: Record<string, unknown>) => void;
  let invalidateConfigCache: () => void;

  before(async () => {
    const m = await import('../lib/hydra-agents.ts');
    const cfg = await import('../lib/hydra-config.ts');
    getAgent = m.getAgent as (name: string) => AgentDef;
    _setTestConfig = cfg._setTestConfig as (cfg: Record<string, unknown>) => void;
    invalidateConfigCache = cfg.invalidateConfigCache;
  });

  beforeEach(() => {
    // Default: copilot disabled (matches production default)
    _setTestConfig({ copilot: { enabled: false } });
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  it('registers copilot as a physical agent', () => {
    const agent = getAgent('copilot');
    assert.ok(agent, 'copilot must be registered');
    assert.equal(agent.type, 'physical');
    assert.equal(agent.cli, 'copilot');
  });

  it('is disabled by default (requires CLI installation)', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.enabled, false);
  });

  it('becomes enabled when copilot.enabled: true is set in config', () => {
    _setTestConfig({ copilot: { enabled: true } });
    const agent = getAgent('copilot');
    assert.equal(agent.enabled, true);
  });

  // ── Plugin interface tests ──────────────────────────────────────────────

  it('has complete features object', () => {
    const agent = getAgent('copilot');
    assert.equal(typeof agent.features, 'object');
    assert.equal(agent.features.executeMode, 'spawn');
    assert.equal(agent.features.jsonOutput, true);
    assert.equal(agent.features.stdinPrompt, false);
    assert.equal(agent.features.reasoningEffort, false);
  });

  it('parseOutput returns correct shape for plain text', () => {
    const agent = getAgent('copilot');
    const result = agent.parseOutput('some text output');
    assert.ok('output' in result);
    assert.ok('tokenUsage' in result);
    assert.ok('costUsd' in result);
    assert.equal(result.output, 'some text output');
    assert.equal(result.tokenUsage, null);
    assert.equal(result.costUsd, null);
  });

  it('parseOutput parses JSONL and extracts last assistant.message content', () => {
    const agent = getAgent('copilot');
    const events = [
      { type: 'assistant.turn_start', data: { turnId: '0' } },
      {
        type: 'assistant.message',
        data: {
          messageId: 'a',
          content: 'Hello! 👋 How can I help?',
          toolRequests: [],
          outputTokens: 10,
        },
      },
      { type: 'assistant.turn_end', data: { turnId: '0' } },
      {
        type: 'result',
        timestamp: '2026-03-10T00:00:00Z',
        usage: { premiumRequests: 1, totalApiDurationMs: 2000 },
      },
    ];
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    const result = agent.parseOutput(stdout, { jsonOutput: true });
    assert.equal(result.output, 'Hello! 👋 How can I help?');
    assert.deepEqual(result.tokenUsage, { premiumRequests: 1 });
    assert.equal(result.costUsd, null);
  });

  it('parseOutput uses last final assistant.message when multiple exist', () => {
    const agent = getAgent('copilot');
    const events = [
      {
        type: 'assistant.message',
        data: { messageId: 'a', content: 'First response', toolRequests: [], outputTokens: 5 },
      },
      {
        type: 'assistant.message',
        data: { messageId: 'b', content: 'Second response', toolRequests: [], outputTokens: 8 },
      },
      { type: 'result', usage: { premiumRequests: 2 } },
    ];
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    const result = agent.parseOutput(stdout, { jsonOutput: true });
    assert.equal(result.output, 'Second response');
    assert.deepEqual(result.tokenUsage, { premiumRequests: 2 });
  });

  it('parseOutput ignores assistant.message events with non-empty toolRequests', () => {
    const agent = getAgent('copilot');
    const events = [
      {
        type: 'assistant.message',
        data: {
          messageId: 'a',
          content: 'Tool call output',
          toolRequests: [{ tool: 'shell', args: {} }],
          outputTokens: 3,
        },
      },
      {
        type: 'assistant.message',
        data: { messageId: 'b', content: 'Final answer', toolRequests: [], outputTokens: 5 },
      },
      { type: 'result', usage: { premiumRequests: 1 } },
    ];
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    const result = agent.parseOutput(stdout, { jsonOutput: true });
    assert.equal(result.output, 'Final answer');
  });

  it('parseOutput falls back to raw stdout on bad JSON', () => {
    const agent = getAgent('copilot');
    const result = agent.parseOutput('not json', { jsonOutput: true });
    assert.equal(result.output, 'not json');
    assert.equal(result.tokenUsage, null);
    assert.equal(result.costUsd, null);
  });

  it('parseOutput falls back to raw stdout when no assistant.message found', () => {
    const agent = getAgent('copilot');
    const events = [{ type: 'result', usage: { premiumRequests: 0 } }];
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    const result = agent.parseOutput(stdout, { jsonOutput: true });
    // No assistant.message found → falls back to raw stdout
    assert.equal(result.output, stdout);
  });

  it('modelBelongsTo matches copilot- prefixed models', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.modelBelongsTo('copilot-claude-sonnet-4-6'), true);
    assert.equal(agent.modelBelongsTo('copilot-gpt-5-4'), true);
    assert.equal(agent.modelBelongsTo('copilot-gemini-3-pro-preview'), true);
    assert.equal(agent.modelBelongsTo('copilot-claude-opus-4-6'), true);
    assert.equal(agent.modelBelongsTo('claude-opus-4-6'), false);
    assert.equal(agent.modelBelongsTo('gpt-5.4'), false);
    assert.equal(agent.modelBelongsTo('gemini-3-pro-preview'), false);
  });

  it('quotaVerify returns null (GitHub-managed)', async () => {
    const agent = getAgent('copilot');
    const result = await agent.quotaVerify();
    assert.equal(result, null);
  });

  it('economyModel returns copilot-claude-sonnet-4-6', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.economyModel(), 'copilot-claude-sonnet-4-6');
  });

  it('readInstructions returns string containing the file path', () => {
    const agent = getAgent('copilot');
    const result = agent.readInstructions?.('COPILOT.md');
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('COPILOT.md'));
  });

  it('taskRules is a non-empty array', () => {
    const agent = getAgent('copilot');
    assert.ok(Array.isArray(agent.taskRules));
    assert.ok(agent.taskRules.length > 0);
  });

  it('errorPatterns has expected keys', () => {
    const agent = getAgent('copilot');
    assert.ok(agent.errorPatterns.authRequired instanceof RegExp);
    assert.ok(agent.errorPatterns.rateLimited instanceof RegExp);
    assert.ok(agent.errorPatterns.quotaExhausted instanceof RegExp);
    assert.ok(agent.errorPatterns.networkError instanceof RegExp);
  });

  it('councilRole is advisor', () => {
    const agent = getAgent('copilot');
    assert.equal(agent.councilRole, 'advisor');
  });

  // ── Invoke tests ──────────────────────────────────────────────────────────

  it('headless plan mode uses -p flag, --silent, --no-ask-user, and no allow flags', () => {
    const agent = getAgent('copilot');
    assert.ok(agent.invoke);
    const [cmd, args] = agent.invoke.headless!('test prompt', { permissionMode: 'plan' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('test prompt'), 'Missing prompt in args');
    assert.ok(args.includes('--silent'), 'Missing --silent flag');
    assert.ok(args.includes('--no-ask-user'), 'Missing --no-ask-user flag');
    assert.ok(!args.includes('--allow-all-tools'), 'Unexpected --allow-all-tools in plan mode');
    assert.ok(
      !args.some((a: string) => a === '--allow-tool'),
      'Unexpected --allow-tool in plan mode',
    );
  });

  it('headless passes --model when opts.model provided', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke!.headless!('test prompt', { model: 'claude-sonnet-4.6' });
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx !== -1, 'Missing --model flag');
    assert.equal(args[modelIdx + 1], 'claude-sonnet-4.6');
  });

  it('headless does NOT pass --model when opts.model is omitted', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke!.headless!('test prompt', {});
    assert.ok(!args.includes('--model'), 'Unexpected --model flag when no model specified');
  });

  it('headless always passes --output-format json by default (features.jsonOutput: true)', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke!.headless!('test prompt', {});
    assert.ok(args.includes('--output-format'), 'Missing --output-format');
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  });

  it('headless omits --output-format when opts.jsonOutput explicitly false', () => {
    const agent = getAgent('copilot');
    const [, args] = agent.invoke!.headless!('test prompt', { jsonOutput: false });
    assert.ok(
      !args.includes('--output-format'),
      'Unexpected --output-format when jsonOutput false',
    );
  });

  it('headless full-auto uses --allow-all-tools', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke!.headless!('test prompt', { permissionMode: 'full-auto' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('--allow-all-tools'), 'Missing --allow-all-tools in full-auto mode');
  });

  it('headless auto-edit uses specific allow-tool flags', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke!.headless!('test prompt', { permissionMode: 'auto-edit' });
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('--allow-tool'), 'Missing --allow-tool in auto-edit mode');
    assert.ok(
      !args.includes('--allow-all-tools'),
      'Unexpected --allow-all-tools in auto-edit mode',
    );
  });

  it('headless resolves Hydra internal model IDs to CLI model IDs', () => {
    const agent = getAgent('copilot');
    // copilot-claude-sonnet-4-6 → claude-sonnet-4.6 (via cliModelId in model profile)
    const [, args] = agent.invoke!.headless!('test prompt', {
      model: 'copilot-claude-sonnet-4-6',
    });
    const modelIdx = args.indexOf('--model');
    assert.ok(modelIdx !== -1, 'Missing --model flag');
    assert.equal(
      args[modelIdx + 1],
      'claude-sonnet-4.6',
      'Hydra internal model ID should be resolved to CLI model ID',
    );
  });

  it('nonInteractive uses -p flag (no allow flags)', () => {
    const agent = getAgent('copilot');
    const [cmd, args] = agent.invoke!.nonInteractive!('test prompt');
    assert.equal(cmd, 'copilot');
    assert.ok(args.includes('-p'), 'Missing -p flag');
    assert.ok(args.includes('test prompt'), 'Missing prompt in args');
    assert.ok(!args.includes('--allow-all-tools'), 'nonInteractive must not allow all tools');
  });

  it('has required taskAffinity keys', () => {
    const agent = getAgent('copilot');
    const requiredKeys: string[] = [
      'planning',
      'architecture',
      'review',
      'refactor',
      'implementation',
      'analysis',
      'testing',
      'research',
      'documentation',
      'security',
    ];
    for (const key of requiredKeys) {
      assert.ok(key in agent.taskAffinity, `Missing affinity key: ${key}`);
    }
  });
});

describe('resolveCliModelId for copilot models', () => {
  it('resolves copilot-claude-sonnet-4-6 to claude-sonnet-4.6', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('copilot-claude-sonnet-4-6'), 'claude-sonnet-4.6');
  });

  it('resolves copilot-claude-opus-4-6 to claude-opus-4.6', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('copilot-claude-opus-4-6'), 'claude-opus-4.6');
  });

  it('resolves copilot-gpt-5-4 to gpt-5.4', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('copilot-gpt-5-4'), 'gpt-5.4');
  });

  it('resolves copilot-gemini-3-pro-preview to gemini-3-pro-preview', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('copilot-gemini-3-pro-preview'), 'gemini-3-pro-preview');
  });

  it('returns input unchanged for IDs already in CLI format', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('claude-sonnet-4.6'), 'claude-sonnet-4.6');
    assert.equal(resolveCliModelId('gpt-5.4'), 'gpt-5.4');
  });

  it('returns input unchanged for unknown IDs (safe fallback)', async () => {
    const { resolveCliModelId } = await import('../lib/hydra-model-profiles.ts');
    assert.equal(resolveCliModelId('some-unknown-model'), 'some-unknown-model');
  });
});
