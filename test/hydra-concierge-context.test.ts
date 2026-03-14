/**
 * Tests for the codebase context section of the concierge system prompt.
 *
 * Verifies that buildConciergeSystemPrompt routes the codebase context
 * through buildAgentContext (from hydra-context.ts), ensuring the system
 * prompt reflects live HYDRA.md / CLAUDE.md project context.
 *
 * Requires --experimental-test-module-mocks (included in `npm test`).
 * Run via: npm test (not `node --test` directly).
 */

import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Sentinel value for mock verification ──────────────────────────────────────

const AGENT_CONTEXT_SENTINEL = '___HYDRA_AGENT_CONTEXT_FROM_BUILD_AGENT_CONTEXT___';

// ── Controllable mock state ────────────────────────────────────────────────────
// Using a mutable flag lets individual tests simulate buildAgentContext failures
// without needing a second mock.module call.

let shouldBuildAgentContextThrow = false;

// ── Module mocks — must be registered before dynamic imports ─────────────────
// These replace transitive dependencies of hydra-concierge.ts so the test
// does not require API keys, filesystem access, or a running daemon.

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: () => {
      if (shouldBuildAgentContextThrow) throw new Error('simulated buildAgentContext failure');
      return AGENT_CONTEXT_SENTINEL;
    },
    getProjectContext: () => AGENT_CONTEXT_SENTINEL,
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    getConciergeIdentity: () => 'Test Concierge identity.',
    getAgentFraming: () => '',
    getProcessLabel: (k: string) => k,
    isPersonaEnabled: () => false,
  },
});

mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    getSessionContext: () => ({ priorSessions: [] }),
    detectSituationalQuery: () => ({ isSituational: false, topic: null }),
    annotateDispatch: () => '',
    annotateHandoff: () => '',
    annotateCompletion: () => '',
    pushActivity: () => {},
    getRecentActivity: () => [],
    clearActivityLog: () => {},
    formatDigestForPrompt: () => '',
    saveSessionSummary: () => {},
  },
});

// ── Lazily loaded module under test ───────────────────────────────────────────

let buildConciergeSystemPrompt: (context?: Record<string, unknown>) => string;
let resetConversation: () => void;
let _setTestConfig: (cfg: Record<string, unknown>) => void;
let invalidateConfigCache: () => void;

before(async () => {
  const cfgMod = await import('../lib/hydra-config.ts');
  _setTestConfig = cfgMod._setTestConfig as (cfg: Record<string, unknown>) => void;
  invalidateConfigCache = cfgMod.invalidateConfigCache;

  // Minimal config — no API keys needed for system prompt tests
  _setTestConfig({
    concierge: { enabled: true, maxHistoryMessages: 40 },
    context: { hierarchical: { enabled: false } },
  });

  const mod = await import('../lib/hydra-concierge.ts');
  buildConciergeSystemPrompt = mod.buildConciergeSystemPrompt as (
    context?: Record<string, unknown>,
  ) => string;
  resetConversation = mod.resetConversation;
});

after(() => {
  invalidateConfigCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildConciergeSystemPrompt — codebase context via buildAgentContext', () => {
  it('includes buildAgentContext output when codebaseBaseline is absent', () => {
    resetConversation();
    const prompt = buildConciergeSystemPrompt({});
    assert.ok(
      prompt.includes(AGENT_CONTEXT_SENTINEL),
      `System prompt must contain buildAgentContext output when no baseline is present.\nGot (first 500 chars):\n${prompt.slice(0, 500)}`,
    );
  });

  it('includes buildAgentContext output when codebaseBaseline is empty string', () => {
    resetConversation();
    const prompt = buildConciergeSystemPrompt({ codebaseBaseline: '' });
    assert.ok(
      prompt.includes(AGENT_CONTEXT_SENTINEL),
      'buildAgentContext output must appear when codebaseBaseline is empty string',
    );
  });

  it('skips buildAgentContext when codebaseBaseline is provided (dedup guard)', () => {
    resetConversation();
    const BASELINE_SENTINEL = '___BASELINE_SENTINEL___';
    const prompt = buildConciergeSystemPrompt({ codebaseBaseline: BASELINE_SENTINEL });
    assert.ok(
      prompt.includes(BASELINE_SENTINEL),
      'Existing codebaseBaseline content must appear in prompt',
    );
    assert.ok(
      !prompt.includes(AGENT_CONTEXT_SENTINEL),
      'buildAgentContext must NOT be called when codebaseBaseline is present (avoids CLAUDE.md duplication)',
    );
  });

  it('still includes standard concierge sections alongside codebase context', () => {
    resetConversation();
    const prompt = buildConciergeSystemPrompt({ mode: 'auto', openTasks: 3 });
    assert.ok(prompt.includes(AGENT_CONTEXT_SENTINEL), 'must have buildAgentContext output');
    assert.ok(prompt.includes('[DISPATCH]'), 'must have dispatch instructions');
    assert.ok(prompt.includes('Operator mode: auto'), 'must have mode in state section');
    assert.ok(prompt.includes('Open tasks: 3'), 'must have task count in state section');
  });

  it('returns a valid prompt when buildAgentContext throws (graceful fallback)', () => {
    resetConversation();
    shouldBuildAgentContextThrow = true;
    try {
      const prompt = buildConciergeSystemPrompt({});
      assert.ok(typeof prompt === 'string' && prompt.length > 0, 'must return a non-empty string');
      assert.ok(prompt.includes('[DISPATCH]'), 'standard sections must still be present');
      assert.ok(
        !prompt.includes(AGENT_CONTEXT_SENTINEL),
        'sentinel must not appear when buildAgentContext threw',
      );
    } finally {
      shouldBuildAgentContextThrow = false;
    }
  });
});
