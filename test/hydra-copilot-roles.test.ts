/**
 * Validates that the Hydra app runs correctly when GitHub Copilot is used as
 * the backing agent for each of the three main roles, using the three available
 * Copilot models:
 *
 *   architect   → copilot-claude-opus-4-6   (most capable; complex structural work)
 *   analyst     → copilot-claude-sonnet-4-6 (balanced; analysis and research)
 *   implementer → copilot-gpt-5-4           (code-focused; implementation tasks)
 *
 * These tests exercise real code paths — no mocking of the module system.
 * They use _setTestConfig to inject test config without touching disk.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentDef, RoleConfig } from '../lib/types.ts';

// ── Shared fixture ─────────────────────────────────────────────────────────

const COPILOT_ROLES_CONFIG = {
  copilot: { enabled: true },
  roles: {
    architect: { agent: 'copilot', model: 'copilot-claude-opus-4-6', reasoningEffort: null },
    analyst: { agent: 'copilot', model: 'copilot-claude-sonnet-4-6', reasoningEffort: null },
    implementer: { agent: 'copilot', model: 'copilot-gpt-5-4', reasoningEffort: null },
  },
};

describe('Copilot roles configuration', () => {
  let getAgent: (name: string) => AgentDef;
  let getRoleConfig: (role: string) => RoleConfig | undefined;
  let getRoleAgent: (role: string, installed: Record<string, boolean | undefined>) => string;
  let resolveCliModelId: (id: string) => string;
  let _setTestConfig: (cfg: Record<string, unknown>) => void;
  let invalidateConfigCache: () => void;

  before(async () => {
    const agents = await import('../lib/hydra-agents.ts');
    const config = await import('../lib/hydra-config.ts');
    const dispatch = await import('../lib/hydra-dispatch.ts');
    const profiles = await import('../lib/hydra-model-profiles.ts');

    getAgent = agents.getAgent as (name: string) => AgentDef;
    getRoleConfig = config.getRoleConfig as (role: string) => RoleConfig | undefined;
    _setTestConfig = config._setTestConfig as (cfg: Record<string, unknown>) => void;
    invalidateConfigCache = config.invalidateConfigCache;
    getRoleAgent = dispatch.getRoleAgent as (
      role: string,
      installed: Record<string, boolean | undefined>,
    ) => string;
    resolveCliModelId = profiles.resolveCliModelId as (id: string) => string;
  });

  beforeEach(() => {
    _setTestConfig(COPILOT_ROLES_CONFIG);
  });

  afterEach(() => {
    invalidateConfigCache();
  });

  /** Extracts and asserts invoke.headless from an agent definition. */
  function assertHeadless(agent: AgentDef) {
    assert.ok(agent.invoke != null, 'agent.invoke must be defined');
    const { headless } = agent.invoke;
    assert.ok(headless != null, 'agent.invoke.headless must be defined');
    return headless;
  }

  // ── Agent enablement ────────────────────────────────────────────────────

  describe('copilot agent enablement', () => {
    it('copilot agent is enabled when copilot.enabled: true', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.enabled, true, 'copilot must be enabled when config sets enabled: true');
    });

    it('copilot agent is of type physical with cli: copilot', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.type, 'physical');
      assert.equal(agent.cli, 'copilot');
    });

    it('copilot agent recognises all three configured models', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.modelBelongsTo('copilot-claude-opus-4-6'), true);
      assert.equal(agent.modelBelongsTo('copilot-claude-sonnet-4-6'), true);
      assert.equal(agent.modelBelongsTo('copilot-gpt-5-4'), true);
    });

    it('copilot agent does not claim non-copilot models', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.modelBelongsTo('claude-opus-4-6'), false);
      assert.equal(agent.modelBelongsTo('gpt-5.4'), false);
      assert.equal(agent.modelBelongsTo('gemini-3.1-pro-preview'), false);
    });
  });

  // ── Role resolution ─────────────────────────────────────────────────────

  describe('role → copilot model resolution', () => {
    it('architect role resolves to copilot agent with copilot-claude-opus-4-6', () => {
      const role = getRoleConfig('architect');
      assert.ok(role, 'architect role must be defined');
      assert.equal(role.agent, 'copilot');
      assert.equal(role.model, 'copilot-claude-opus-4-6');
    });

    it('analyst role resolves to copilot agent with copilot-claude-sonnet-4-6', () => {
      const role = getRoleConfig('analyst');
      assert.ok(role, 'analyst role must be defined');
      assert.equal(role.agent, 'copilot');
      assert.equal(role.model, 'copilot-claude-sonnet-4-6');
    });

    it('implementer role resolves to copilot agent with copilot-gpt-5-4', () => {
      const role = getRoleConfig('implementer');
      assert.ok(role, 'implementer role must be defined');
      assert.equal(role.agent, 'copilot');
      assert.equal(role.model, 'copilot-gpt-5-4');
    });
  });

  // ── Model ID resolution (Hydra internal → Copilot CLI arg) ──────────────

  describe('model ID resolution to CLI args', () => {
    it('copilot-claude-opus-4-6 resolves to claude-opus-4.6 for --model flag', () => {
      assert.equal(resolveCliModelId('copilot-claude-opus-4-6'), 'claude-opus-4.6');
    });

    it('copilot-claude-sonnet-4-6 resolves to claude-sonnet-4.6 for --model flag', () => {
      assert.equal(resolveCliModelId('copilot-claude-sonnet-4-6'), 'claude-sonnet-4.6');
    });

    it('copilot-gpt-5-4 resolves to gpt-5.4 for --model flag', () => {
      assert.equal(resolveCliModelId('copilot-gpt-5-4'), 'gpt-5.4');
    });
  });

  // ── CLI arg generation for each role ───────────────────────────────────

  describe('headless CLI args — architect role (claude-opus-4.6)', () => {
    it('headless plan mode includes -p, --silent, --no-ask-user', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [cmd, args] = headless('architect task', {
        model: 'copilot-claude-opus-4-6',
      });
      assert.equal(cmd, 'copilot');
      assert.ok(args.includes('-p'), 'Missing -p flag');
      assert.ok(args.includes('architect task'), 'Missing prompt');
      assert.ok(args.includes('--silent'), 'Missing --silent');
      assert.ok(args.includes('--no-ask-user'), 'Missing --no-ask-user');
    });

    it('headless resolves copilot-claude-opus-4-6 → --model claude-opus-4.6', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('architect task', {
        model: 'copilot-claude-opus-4-6',
      });
      const idx = args.indexOf('--model');
      assert.ok(idx !== -1, 'Missing --model flag');
      assert.equal(args[idx + 1], 'claude-opus-4.6');
    });

    it('headless includes --output-format json for architect role', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('architect task', {
        model: 'copilot-claude-opus-4-6',
      });
      const idx = args.indexOf('--output-format');
      assert.ok(idx !== -1, 'Missing --output-format');
      assert.equal(args[idx + 1], 'json');
    });
  });

  describe('headless CLI args — analyst role (claude-sonnet-4.6)', () => {
    it('headless resolves copilot-claude-sonnet-4-6 → --model claude-sonnet-4.6', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('analyst task', {
        model: 'copilot-claude-sonnet-4-6',
      });
      const idx = args.indexOf('--model');
      assert.ok(idx !== -1, 'Missing --model flag');
      assert.equal(args[idx + 1], 'claude-sonnet-4.6');
    });

    it('headless full-auto mode adds --allow-all-tools for analyst', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('analyst task', {
        model: 'copilot-claude-sonnet-4-6',
        permissionMode: 'full-auto',
      });
      assert.ok(args.includes('--allow-all-tools'), 'Missing --allow-all-tools in full-auto');
    });
  });

  describe('headless CLI args — implementer role (gpt-5.4)', () => {
    it('headless resolves copilot-gpt-5-4 → --model gpt-5.4', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('implementer task', {
        model: 'copilot-gpt-5-4',
      });
      const idx = args.indexOf('--model');
      assert.ok(idx !== -1, 'Missing --model flag');
      assert.equal(args[idx + 1], 'gpt-5.4');
    });

    it('headless auto-edit mode uses specific --allow-tool flags for implementer', () => {
      const agent = getAgent('copilot');
      const headless = assertHeadless(agent);
      const [, args] = headless('implementer task', {
        model: 'copilot-gpt-5-4',
        permissionMode: 'auto-edit',
      });
      assert.ok(args.includes('--allow-tool'), 'Missing --allow-tool in auto-edit mode');
      assert.ok(
        !args.includes('--allow-all-tools'),
        'Unexpected --allow-all-tools in auto-edit mode',
      );
    });
  });

  // ── Dispatch / routing ──────────────────────────────────────────────────

  describe('getRoleAgent routing with copilot installed', () => {
    const withCopilot: Record<string, boolean | undefined> = { copilot: true };

    it('routes architect role to copilot when copilot is installed and enabled', () => {
      assert.equal(getRoleAgent('architect', withCopilot), 'copilot');
    });

    it('routes analyst role to copilot when copilot is installed and enabled', () => {
      assert.equal(getRoleAgent('analyst', withCopilot), 'copilot');
    });

    it('routes implementer role to copilot when copilot is installed and enabled', () => {
      assert.equal(getRoleAgent('implementer', withCopilot), 'copilot');
    });
  });

  describe('getRoleAgent fallback when copilot CLI not installed', () => {
    it('falls back when copilot not in installedCLIs', () => {
      // No agents available at all → should throw (can't route)
      assert.throws(
        () => getRoleAgent('architect', {}),
        /no agents available/i,
        'Should throw when no agents are installed',
      );
    });

    it('falls back to another installed agent when copilot not installed', () => {
      // claude is in the fallback preference order and is always registered
      const installed: Record<string, boolean | undefined> = { claude: true };
      // With copilot as the role agent but not installed, should fall back to claude
      const agent = getRoleAgent('architect', installed);
      assert.equal(typeof agent, 'string', 'Should return a fallback agent name');
      assert.ok(agent.length > 0, 'Fallback agent name must not be empty');
    });
  });

  // ── Output parsing ──────────────────────────────────────────────────────

  describe('parseOutput — Copilot JSONL event stream', () => {
    it('parses architect response from JSONL correctly', () => {
      const agent = getAgent('copilot');
      const events = [
        { type: 'assistant.turn_start', data: { turnId: '0' } },
        {
          type: 'assistant.message',
          data: {
            messageId: 'arch-1',
            content: 'Here is the architectural analysis.',
            toolRequests: [],
            outputTokens: 42,
          },
        },
        {
          type: 'result',
          timestamp: '2026-03-12T00:00:00Z',
          usage: { premiumRequests: 1, totalApiDurationMs: 3000 },
        },
      ];
      const result = agent.parseOutput(events.map((e) => JSON.stringify(e)).join('\n'), {
        jsonOutput: true,
      });
      assert.equal(result.output, 'Here is the architectural analysis.');
      assert.deepEqual(result.tokenUsage, { premiumRequests: 1 });
      assert.equal(result.costUsd, null);
    });

    it('parses analyst response — selects last assistant.message', () => {
      const agent = getAgent('copilot');
      const events = [
        {
          type: 'assistant.message',
          data: {
            messageId: 'a1',
            content: 'Initial analysis',
            toolRequests: [],
            outputTokens: 10,
          },
        },
        {
          type: 'assistant.message',
          data: { messageId: 'a2', content: 'Final analysis', toolRequests: [], outputTokens: 15 },
        },
        { type: 'result', usage: { premiumRequests: 2 } },
      ];
      const result = agent.parseOutput(events.map((e) => JSON.stringify(e)).join('\n'), {
        jsonOutput: true,
      });
      assert.equal(result.output, 'Final analysis');
      assert.deepEqual(result.tokenUsage, { premiumRequests: 2 });
    });

    it('parses implementer response — skips tool-use turns', () => {
      const agent = getAgent('copilot');
      const events = [
        {
          type: 'assistant.message',
          data: {
            messageId: 'i1',
            content: 'Running tests...',
            toolRequests: [{ tool: 'shell', args: { command: 'npm test' } }],
            outputTokens: 5,
          },
        },
        {
          type: 'assistant.message',
          data: {
            messageId: 'i2',
            content: 'Implementation complete. All tests pass.',
            toolRequests: [],
            outputTokens: 20,
          },
        },
        { type: 'result', usage: { premiumRequests: 1 } },
      ];
      const result = agent.parseOutput(events.map((e) => JSON.stringify(e)).join('\n'), {
        jsonOutput: true,
      });
      assert.equal(result.output, 'Implementation complete. All tests pass.');
    });

    it('falls back gracefully on malformed JSONL from any role', () => {
      const agent = getAgent('copilot');
      const result = agent.parseOutput('not valid json at all', { jsonOutput: true });
      assert.equal(result.output, 'not valid json at all');
      assert.equal(result.tokenUsage, null);
      assert.equal(result.costUsd, null);
    });
  });

  // ── Economy model ───────────────────────────────────────────────────────

  describe('economy model selection', () => {
    it('economy model is always copilot-claude-sonnet-4-6 regardless of role', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.economyModel(), 'copilot-claude-sonnet-4-6');
    });
  });

  // ── Council role ────────────────────────────────────────────────────────

  describe('copilot council role', () => {
    it('copilot has council role of advisor', () => {
      const agent = getAgent('copilot');
      assert.equal(agent.councilRole, 'advisor');
    });
  });
});
