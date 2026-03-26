/**
 * Deep coverage tests for hydra-council.ts
 *
 * Focuses on the exported pure functions and transcript synthesis logic
 * that represent the bulk of uncovered lines. Uses module-level mocking
 * to isolate from agent execution, config, and file I/O.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-council-deep.coverage.test.ts
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: { loadEnvFile: () => {} } });

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
    }),
    loadHydraConfig: () => ({
      routing: { mode: 'balanced', councilMode: 'sequential' },
      local: { enabled: false },
      metrics: {},
    }),
    getRoleConfig: () => ({ agent: 'claude', model: null }),
    invalidateConfigCache: () => {},
    _setTestConfig: () => {},
    _setTestConfigPath: () => {},
    configStore: { get: () => ({}), set: () => {} },
    HYDRA_ROOT: '/tmp/test-project',
    HYDRA_RUNTIME_ROOT: '/tmp/test-project',
    AFFINITY_PRESETS: {},
  },
});

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: () => 'MOCK_CONTEXT',
    getProjectContext: () => 'MOCK_CONTEXT',
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => ({
      name,
      label: name.toUpperCase(),
      rolePrompt: `${name} role prompt`,
      enabled: true,
      cli: name,
      invoke: { nonInteractive: () => ['cmd'] },
      modelBelongsTo: () => true,
    }),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getMode: () => 'balanced',
    setMode: () => 'economy',
    AGENT_TYPE: { PHYSICAL: 'physical', VIRTUAL: 'virtual' },
    registerAgent: () => ({}),
    unregisterAgent: () => false,
    setAgentEnabled: () => false,
    resolvePhysicalAgent: () => null,
    listAgents: () => [],
    AGENTS: {},
    AGENT_DISPLAY_ORDER: ['gemini', 'codex', 'claude'],
    KNOWN_OWNERS: new Set(['claude', 'gemini', 'codex', 'human', 'unassigned']),
    getPhysicalAgentNames: () => ['claude', 'gemini', 'codex'],
    getAllAgentNames: () => ['claude', 'gemini', 'codex'],
    initAgentRegistry: () => {},
    isRegistryInitialized: () => true,
    _resetRegistry: () => {},
    bestAgentFor: () => 'claude',
    classifyTask: () => 'general',
    getVerifier: () => 'gemini',
    recordTaskOutcome: () => {},
    invalidateAffinityCache: () => {},
    getActiveModel: () => null,
    setActiveModel: () => null,
    resetAgentModel: () => null,
    getModelFlags: () => [],
    getModelSummary: () => ({}),
    resolveModelId: () => null,
    getReasoningEffort: () => null,
    setReasoningEffort: () => null,
    getModelReasoningCaps: () => ({ supports: false }),
    getEffortOptionsForModel: () => [],
    formatEffortDisplay: () => '',
    MODEL_REASONING_CAPS: new Map(),
    REASONING_EFFORTS: ['low', 'medium', 'high', 'xhigh'],
    TASK_TYPES: [],
  },
});

mock.module('../lib/hydra-setup.ts', {
  namedExports: {
    commandExists: () => true,
    registerCustomAgentMcp: () => {},
    KNOWN_CLI_MCP_PATHS: [],
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ level: 'ok', percent: 10, todayTokens: 100 }),
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00.000Z',
    runId: (prefix: string) => `${prefix}_test123`,
    parseArgs: () => ({ options: {}, positionals: [] }),
    getPrompt: () => '',
    boolFlag: (_v: unknown, d: boolean) => d,
    short: (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : ''),
    parseJsonLoose: (s: string) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    },
    request: mock.fn(async () => ({ ok: true })),
    ensureDir: () => {},
    sanitizeOwner: (o: string) => o?.toLowerCase() ?? 'unassigned',
    normalizeTask: (item: unknown, fallback: string) => {
      if (item == null || typeof item !== 'object') return null;
      const i = item as Record<string, unknown>;
      return {
        owner: (i['owner'] as string) ?? fallback,
        title: (i['title'] as string) ?? '',
        rationale: (i['rationale'] as string) ?? '',
        done: (i['definition_of_done'] as string) ?? '',
      };
    },
    dedupeTasks: (tasks: unknown[]) => tasks,
    classifyPrompt: () => ({ tier: 'simple' }),
    generateSpec: async () => null,
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (s: string) => `== ${s} ==`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (a: string) => a,
    createSpinner: () => ({
      start: () => {},
      stop: () => {},
      succeed: () => {},
      fail: () => {},
      update: () => {},
    }),
    divider: () => '---',
    SUCCESS: (s: unknown) => String(s),
    ERROR: (s: unknown) => String(s),
    WARNING: (s: unknown) => String(s),
    DIM: (s: unknown) => String(s),
    ACCENT: (s: unknown) => String(s),
    formatElapsed: () => '0s',
    formatAgentStatus: () => '',
    stripAnsi: (s: string) => s,
    shortModelName: (s: string) => s,
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgentWithRecovery: mock.fn(async () => ({
      ok: true,
      output: '{"view":"mock response","consensus":"mock consensus"}',
      stdout: '{"view":"mock response","consensus":"mock consensus"}',
      stderr: '',
      error: '',
      exitCode: 0,
      command: 'mock',
      args: [],
      promptSnippet: '',
      recovered: false,
      originalModel: undefined,
      newModel: undefined,
    })),
    executeAgent: mock.fn(async () => ({
      ok: true,
      output: '{}',
      stdout: '{}',
      stderr: '',
      error: '',
      exitCode: 0,
    })),
    DefaultAgentExecutor: class {
      async executeAgent() {
        return { ok: true, output: '{}', stdout: '{}', stderr: '', error: '' };
      }
    },
    diagnoseAgentError: () => null,
    expandInvokeArgs: () => [],
    parseCliResponse: () => ({}),
    assertSafeSpawnCmd: () => true,
    extractCodexText: () => '',
    extractCodexUsage: () => null,
    extractCodexErrors: () => [],
  },
});

mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    detectRateLimitError: () => ({ isRateLimit: false }),
    calculateBackoff: () => 1000,
  },
});

mock.module('../lib/hydra-doctor.ts', {
  namedExports: {
    diagnose: async () => {},
    isDoctorEnabled: () => false,
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: (a: string) => `You are ${a}`,
    getConciergeIdentity: () => '',
    getProcessLabel: (k: string) => k,
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    magenta: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    gray: (s: string) => s,
    underline: (s: string) => s,
    italic: (s: string) => s,
    reset: (s: string) => s,
    bgRed: (s: string) => s,
    bgGreen: (s: string) => s,
    bgYellow: (s: string) => s,
  },
});

// ── Import target module after mocks ─────────────────────────────────────────

const {
  extractDecisionOptions,
  extractAssumptions,
  extractAssumptionAttacks,
  extractFinalDecision,
  deriveCouncilRecommendation,
  synthesizeCouncilTranscript,
  buildStepPrompt,
  resolveActiveAgents,
  computeAdversarialResumePoint,
  COUNCIL_DECISION_CRITERIA,
} = await import('../lib/hydra-council.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('hydra-council deep coverage', () => {
  describe('COUNCIL_DECISION_CRITERIA', () => {
    it('should have four criteria', () => {
      assert.equal(COUNCIL_DECISION_CRITERIA.length, 4);
      const keys = COUNCIL_DECISION_CRITERIA.map((c) => c.key);
      assert.deepStrictEqual(keys, ['correctness', 'complexity', 'reversibility', 'user_impact']);
    });
  });

  describe('extractDecisionOptions', () => {
    it('returns empty array for null/undefined', () => {
      assert.deepStrictEqual(extractDecisionOptions(null), []);
      assert.deepStrictEqual(extractDecisionOptions(), []);
    });

    it('returns empty array for non-object', () => {
      assert.deepStrictEqual(extractDecisionOptions('hello'), []);
      assert.deepStrictEqual(extractDecisionOptions(42), []);
    });

    it('returns empty for object with no option arrays', () => {
      assert.deepStrictEqual(extractDecisionOptions({ foo: 'bar' }), []);
    });

    it('extracts decision_options', () => {
      const input = {
        decision_options: [
          { option: 'A', summary: 'Option A', preferred: true, tradeoffs: { correctness: 'High' } },
          { option: 'B', summary: 'Option B', preferred: false },
        ],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 2);
      assert.equal((result[0] as Record<string, unknown>)['option'], 'A');
    });

    it('extracts from options key', () => {
      const input = {
        options: [{ option: 'X', summary: 'Option X' }],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 1);
    });

    it('extracts from candidate_options key', () => {
      const input = {
        candidate_options: [{ name: 'Y', description: 'Desc Y' }],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 1);
    });

    it('deduplicates by option|summary', () => {
      const input = {
        decision_options: [
          { option: 'A', summary: 'same' },
          { option: 'A', summary: 'same', preferred: true },
        ],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 1);
    });

    it('skips null items in array', () => {
      const input = {
        decision_options: [null, undefined, { option: 'A', summary: 'good' }],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 1);
    });

    it('generates default option name when missing', () => {
      const input = {
        decision_options: [{ summary: 'No name option' }],
      };
      const result = extractDecisionOptions(input);
      assert.equal((result[0] as Record<string, unknown>)['option'], 'option_1');
    });

    it('returns empty for items with empty option and summary', () => {
      const input = {
        decision_options: [{ option: '', summary: '' }],
      };
      const result = extractDecisionOptions(input);
      assert.equal(result.length, 0);
    });
  });

  describe('extractAssumptions', () => {
    it('returns empty for null/undefined/non-object', () => {
      assert.deepStrictEqual(extractAssumptions(null), []);
      assert.deepStrictEqual(extractAssumptions(), []);
      assert.deepStrictEqual(extractAssumptions(42), []);
    });

    it('extracts from assumptions key', () => {
      const input = {
        assumptions: [
          {
            assumption: 'User auth works',
            status: 'open',
            evidence: '',
            impact: '',
            owner: 'claude',
          },
        ],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 1);
      assert.equal((result[0] as Record<string, unknown>)['assumption'], 'User auth works');
    });

    it('extracts from open_assumptions key', () => {
      const input = {
        open_assumptions: [{ assumption: 'API stable', status: 'validated' }],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 1);
    });

    it('extracts from key_assumptions key', () => {
      const input = {
        key_assumptions: [{ assumption: 'Network reliable' }],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 1);
    });

    it('handles string assumptions', () => {
      const input = {
        assumptions: ['The cache is warm', 'DB is indexed'],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 2);
      assert.equal((result[0] as Record<string, unknown>)['status'], 'open');
    });

    it('deduplicates by assumption text', () => {
      const input = {
        assumptions: [
          { assumption: 'Same thing', status: 'open' },
          { assumption: 'Same thing', status: 'validated' },
        ],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 1);
    });

    it('skips empty assumptions', () => {
      const input = {
        assumptions: [{ assumption: '', status: 'open' }, null, { assumption: 'Valid' }],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 1);
    });

    it('normalizes status values', () => {
      const input = {
        assumptions: [
          { assumption: 'A', status: 'validated' },
          { assumption: 'B', status: 'rejected' },
          { assumption: 'C', status: 'bogus' },
        ],
      };
      const result = extractAssumptions(input);
      assert.equal((result[0] as Record<string, unknown>)['status'], 'validated');
      assert.equal((result[1] as Record<string, unknown>)['status'], 'rejected');
      assert.equal((result[2] as Record<string, unknown>)['status'], 'open');
    });

    it('uses name/summary/question as fallback keys', () => {
      const input = {
        assumptions: [{ name: 'Named assumption' }, { summary: 'Summary assumption' }],
      };
      const result = extractAssumptions(input);
      assert.equal(result.length, 2);
    });
  });

  describe('extractAssumptionAttacks', () => {
    it('returns empty for null/undefined', () => {
      assert.deepStrictEqual(extractAssumptionAttacks(null), []);
      assert.deepStrictEqual(extractAssumptionAttacks(), []);
    });

    it('extracts from assumption_attacks key', () => {
      const input = {
        assumption_attacks: [
          {
            target_agent: 'gemini',
            attack_vector: 'Could fail under load',
            impact: 'high',
            by: 'claude',
          },
        ],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
    });

    it('extracts from assumption_challenges key', () => {
      const input = {
        assumption_challenges: [{ challenge: 'Edge case missed', assumption: 'Network stable' }],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
    });

    it('extracts from counterarguments key', () => {
      const input = {
        counterarguments: [{ critique: 'Too risky', assumption: 'Budget ok' }],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
    });

    it('handles string attacks', () => {
      const input = {
        assumption_attacks: ['This could break'],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
      assert.equal((result[0] as Record<string, unknown>)['challenge'], 'This could break');
    });

    it('deduplicates by assumption|challenge', () => {
      const input = {
        assumption_attacks: [
          { assumption: 'same', challenge: 'same' },
          { assumption: 'same', challenge: 'same', impact: 'high' },
        ],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
    });

    it('skips null/undefined items', () => {
      const input = {
        assumption_attacks: [null, undefined, { challenge: 'Valid' }],
      };
      const result = extractAssumptionAttacks(input);
      assert.equal(result.length, 1);
    });
  });

  describe('extractFinalDecision', () => {
    it('returns null for null/undefined/non-object', () => {
      assert.equal(extractFinalDecision(null), null);
      assert.equal(extractFinalDecision(), null);
      assert.equal(extractFinalDecision(42), null);
    });

    it('returns null when all fields empty', () => {
      assert.equal(extractFinalDecision({}), null);
    });

    it('extracts from decision sub-object', () => {
      const input = {
        decision: {
          summary: 'Use approach A',
          why: 'Most reversible',
          owner: 'claude',
          confidence: 'high',
          next_action: 'handoff',
          reversible_first_step: 'Create branch',
          tradeoffs: { correctness: 'High', complexity: 'Low' },
        },
      };
      const result = extractFinalDecision(input);
      assert.ok(result);
      assert.equal(result.summary, 'Use approach A');
      assert.equal(result.why, 'Most reversible');
      assert.equal(result.confidence, 'high');
      assert.equal(result.nextAction, 'handoff');
      assert.equal(result.reversibleFirstStep, 'Create branch');
      assert.ok(result.tradeoffs);
    });

    it('uses fallback agent/phase when provided', () => {
      const input = {
        decision: { summary: 'Something' },
      };
      const result = extractFinalDecision(input, { agent: 'gemini', phase: 'critique' });
      assert.ok(result);
      assert.equal(result.sourceAgent, 'gemini');
      assert.equal(result.sourcePhase, 'critique');
      assert.equal(result.owner, 'gemini');
    });

    it('falls back to top-level keys for decision fields', () => {
      const input = {
        consensus: 'We agree on X',
        decision_rationale: 'Because reasons',
        confidence: 'medium',
      };
      const result = extractFinalDecision(input);
      assert.ok(result);
      assert.equal(result.summary, 'We agree on X');
      assert.equal(result.why, 'Because reasons');
      assert.equal(result.confidence, 'medium');
    });

    it('normalizes confidence values', () => {
      const input1 = { decision: { summary: 'x', confidence: 'HIGH' } };
      assert.equal(extractFinalDecision(input1)?.confidence, 'high');

      const input2 = { decision: { summary: 'x', confidence: 'MEDIUM' } };
      assert.equal(extractFinalDecision(input2)?.confidence, 'medium');

      const input3 = { decision: { summary: 'x', confidence: 'bogus' } };
      assert.equal(extractFinalDecision(input3)?.confidence, '');
    });

    it('normalizes next_action values', () => {
      const input1 = { decision: { summary: 'x', next_action: 'handoff' } };
      assert.equal(extractFinalDecision(input1)?.nextAction, 'handoff');

      const input2 = { decision: { summary: 'x', next_action: 'delegate' } };
      assert.equal(extractFinalDecision(input2)?.nextAction, 'handoff');

      const input3 = { decision: { summary: 'x', next_action: 'deeper_council' } };
      assert.equal(extractFinalDecision(input3)?.nextAction, 'council');

      const input4 = { decision: { summary: 'x', next_action: 'human_decision' } };
      assert.equal(extractFinalDecision(input4)?.nextAction, 'human_decision');

      const input5 = { decision: { summary: 'x', next_action: 'ship' } };
      assert.equal(extractFinalDecision(input5)?.nextAction, 'handoff');

      const input6 = { decision: { summary: 'x', next_action: 'ask_human' } };
      assert.equal(extractFinalDecision(input6)?.nextAction, 'human_decision');
    });

    it('handles camelCase tradeoff keys', () => {
      const input = {
        decision: {
          summary: 'x',
          tradeoffs: { user_impact: 'Low risk' },
        },
      };
      const result = extractFinalDecision(input);
      assert.ok(result?.tradeoffs);
    });

    it('returns null tradeoffs for non-object', () => {
      const input = {
        decision: { summary: 'x', tradeoffs: 'not an object' },
      };
      const result = extractFinalDecision(input);
      assert.equal(result?.tradeoffs, null);
    });

    it('returns null tradeoffs for array', () => {
      const input = {
        decision: { summary: 'x', tradeoffs: ['a', 'b'] },
      };
      const result = extractFinalDecision(input);
      assert.equal(result?.tradeoffs, null);
    });
  });

  describe('deriveCouncilRecommendation', () => {
    it('returns handoff for empty inputs', () => {
      const result = deriveCouncilRecommendation({});
      assert.equal(result.recommendedMode, 'handoff');
      assert.equal(result.nextAction, 'handoff');
      assert.ok(result.rationale.length > 0);
    });

    it('returns council when finalDecision next_action is council', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { nextAction: 'council' },
      });
      assert.equal(result.recommendedMode, 'council');
      assert.equal(result.nextAction, 'council');
    });

    it('returns council when finalDecision next_action is human_decision', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { nextAction: 'human_decision' },
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('returns handoff for high confidence handoff', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { nextAction: 'handoff', confidence: 'high' },
      });
      assert.equal(result.recommendedMode, 'handoff');
    });

    it('returns council for handoff with low confidence', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { nextAction: 'handoff', confidence: 'low' },
        disagreements: ['one', 'two'],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates to council on many risks', () => {
      const result = deriveCouncilRecommendation({
        risks: ['r1', 'r2', 'r3', 'r4'],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates to council on disagreements', () => {
      const result = deriveCouncilRecommendation({
        disagreements: ['d1'],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates to council on low confidence with open assumptions', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { confidence: 'low' },
        assumptions: [{ status: 'open' }],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates on low confidence with human questions', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { confidence: 'low' },
        questions: [{ to: 'human' }],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates on low confidence with risks', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { confidence: 'low' },
        risks: ['risk1'],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates on positive council signals with open assumptions', () => {
      const result = deriveCouncilRecommendation({
        councilVotes: [{ vote: true }],
        assumptions: [{ status: 'open' }],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('escalates on cross-agent questions > 1', () => {
      const result = deriveCouncilRecommendation({
        questions: [{ to: 'gemini' }, { to: 'codex' }],
      });
      assert.equal(result.recommendedMode, 'council');
    });

    it('does not escalate for validated assumptions only', () => {
      const result = deriveCouncilRecommendation({
        assumptions: [{ status: 'validated' }, { status: 'validated' }],
      });
      assert.equal(result.recommendedMode, 'handoff');
    });

    it('rationale includes all key metrics', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { owner: 'claude', confidence: 'high', nextAction: 'handoff' },
      });
      assert.ok(result.rationale.includes('decision_owner=claude'));
      assert.ok(result.rationale.includes('decision_confidence=high'));
      assert.ok(result.rationale.includes('decision_next_action=handoff'));
    });

    it('handoff with many risks escalates to council', () => {
      const result = deriveCouncilRecommendation({
        finalDecision: { nextAction: 'handoff', confidence: 'medium' },
        risks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
      });
      assert.equal(result.recommendedMode, 'council');
    });
  });

  describe('synthesizeCouncilTranscript', () => {
    it('returns default tasks when transcript has no parsed entries', () => {
      const result = synthesizeCouncilTranscript('Fix the bug', []);
      assert.ok(result.tasks.length > 0);
      assert.equal(result.prompt, 'Fix the bug');
      assert.equal(result.recommendedMode, 'handoff');
    });

    it('synthesizes a full transcript with parsed outputs', () => {
      const transcript = [
        {
          round: 1,
          agent: 'claude',
          phase: 'propose',
          ok: true,
          rawText: '{}',
          parsed: {
            view: 'Propose approach A',
            recommended_tasks: [
              { owner: 'claude', title: 'Task 1', rationale: 'R1', definition_of_done: 'DoD1' },
            ],
            questions: [{ to: 'human', question: 'Is this ok?' }],
            risks: ['Risk 1'],
            assumptions: [{ assumption: 'Cache is warm', status: 'open', owner: 'claude' }],
            decision_options: [{ option: 'A', summary: 'Approach A', preferred: true }],
          },
        },
        {
          round: 1,
          agent: 'gemini',
          phase: 'critique',
          ok: true,
          rawText: '{}',
          parsed: {
            critique: 'Missing edge case',
            should_open_council: true,
            council_reason: 'Needs more discussion',
            risks: ['Risk 2'],
            assumptions: [{ assumption: 'DB indexed', status: 'open', owner: 'gemini' }],
            assumption_attacks: [
              {
                target_agent: 'claude',
                assumption: 'Cache is warm',
                attack_vector: 'Cold start scenario',
              },
            ],
            disagreements: ['Approach A may not scale'],
          },
        },
        {
          round: 1,
          agent: 'claude',
          phase: 'refine',
          ok: true,
          rawText: '{}',
          parsed: {
            view: 'Refined plan',
            decision: {
              summary: 'Use approach A with safeguards',
              why: 'Most reversible',
              owner: 'claude',
              confidence: 'high',
              next_action: 'handoff',
              reversible_first_step: 'Create feature branch',
              tradeoffs: { correctness: 'High', complexity: 'Medium' },
            },
            recommended_tasks: [
              {
                owner: 'codex',
                title: 'Implement safeguards',
                rationale: 'Defense',
                definition_of_done: 'Tests pass',
              },
            ],
          },
        },
        {
          round: 1,
          agent: 'codex',
          phase: 'implement',
          ok: true,
          rawText: '{}',
          parsed: {
            consensus: 'Implementation plan ready',
            task_allocations: [
              {
                owner: 'codex',
                title: 'Write tests',
                rationale: 'Coverage',
                definition_of_done: '80%',
              },
            ],
            decision: {
              summary: 'Proceed with A + safeguards',
              confidence: 'high',
              next_action: 'handoff',
            },
          },
        },
      ];

      const result = synthesizeCouncilTranscript('Fix the bug', transcript);
      assert.ok(result.tasks.length > 0);
      assert.ok(result.risks.length >= 2);
      assert.ok(result.questions.length >= 1);
      assert.ok(result.assumptions.length >= 1);
      assert.ok(result.assumptionAttacks.length >= 1);
      assert.ok(result.disagreements.length >= 1);
      assert.ok(result.councilVotes.length >= 1);
      assert.ok(result.decisionOptions.length >= 1);
      assert.ok(result.finalDecision);
      assert.equal(result.consensus, 'Proceed with A + safeguards');
    });

    it('falls back to claude refine view for consensus', () => {
      const transcript = [
        {
          round: 1,
          agent: 'claude',
          phase: 'refine',
          ok: true,
          rawText: '{}',
          parsed: { view: 'Refined view here' },
        },
      ];
      const result = synthesizeCouncilTranscript('Test', transcript);
      assert.equal(result.consensus, 'Refined view here');
    });

    it('falls back to last claude view for consensus', () => {
      const transcript = [
        {
          round: 1,
          agent: 'claude',
          phase: 'propose',
          ok: true,
          rawText: '{}',
          parsed: { view: 'Claude propose view' },
        },
      ];
      const result = synthesizeCouncilTranscript('Test', transcript);
      assert.equal(result.consensus, 'Claude propose view');
    });

    it('handles entries with null parsed output', () => {
      const transcript = [
        { round: 1, agent: 'claude', phase: 'propose', ok: false, rawText: 'error', parsed: null },
      ];
      const result = synthesizeCouncilTranscript('Test', transcript);
      assert.ok(result.tasks.length > 0); // default tasks
    });
  });

  describe('buildStepPrompt', () => {
    it('builds a propose prompt', () => {
      const step = { agent: 'claude', phase: 'propose', promptLabel: 'Analyze and propose.' };
      const result = buildStepPrompt(step, 'Fix the bug', [], 1, 2);
      assert.ok(result.includes('Council round 1/2'));
      assert.ok(result.includes('propose'));
      assert.ok(result.includes('Fix the bug'));
      assert.ok(result.includes('MOCK_CONTEXT'));
    });

    it('builds a critique prompt', () => {
      const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review critically.' };
      const result = buildStepPrompt(step, 'Fix the bug', [], 1, 2);
      assert.ok(result.includes('critique'));
      assert.ok(result.includes('attack the strongest assumption'));
    });

    it('builds a refine prompt', () => {
      const step = { agent: 'claude', phase: 'refine', promptLabel: 'Incorporate critique.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1);
      assert.ok(result.includes('refine'));
      assert.ok(result.includes('resolve critique'));
    });

    it('builds an implement prompt', () => {
      const step = { agent: 'codex', phase: 'implement', promptLabel: 'Produce implementation.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1);
      assert.ok(result.includes('implement'));
      assert.ok(result.includes('final synthesizer'));
    });

    it('includes spec content when provided', () => {
      const step = { agent: 'claude', phase: 'propose', promptLabel: 'Analyze.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1, 'SPEC: Do X, Y, Z');
      assert.ok(result.includes('Anchoring Specification'));
      assert.ok(result.includes('SPEC: Do X, Y, Z'));
    });

    it('includes transcript context summary', () => {
      const transcript = [
        { round: 1, agent: 'claude', phase: 'propose', parsed: { view: 'My view' }, rawText: '' },
      ];
      const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review.' };
      const result = buildStepPrompt(step, 'Fix', transcript, 1, 2);
      assert.ok(result.includes('CLAUDE'));
    });

    it('shows (none) when transcript is empty', () => {
      const step = { agent: 'claude', phase: 'propose', promptLabel: 'Propose.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1);
      assert.ok(result.includes('(none)'));
    });

    it('includes decision criteria instruction', () => {
      const step = { agent: 'claude', phase: 'propose', promptLabel: 'Propose.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1);
      assert.ok(result.includes('Decision criteria'));
      assert.ok(result.includes('Correctness'));
    });

    it('uses default schema for unknown phase', () => {
      const step = { agent: 'claude', phase: 'unknown_phase', promptLabel: 'Unknown.' };
      const result = buildStepPrompt(step, 'Fix', [], 1, 1);
      assert.ok(result.includes('{}'));
    });
  });

  describe('resolveActiveAgents', () => {
    it('returns defaults when no filter', () => {
      assert.deepStrictEqual(resolveActiveAgents(null), ['claude', 'gemini', 'codex']);
    });

    it('returns defaults for empty filter', () => {
      assert.deepStrictEqual(resolveActiveAgents([]), ['claude', 'gemini', 'codex']);
    });

    it('filters to specified agents preserving order', () => {
      assert.deepStrictEqual(resolveActiveAgents(['codex', 'claude']), ['claude', 'codex']);
    });

    it('filters out unknown agents', () => {
      assert.deepStrictEqual(resolveActiveAgents(['unknown', 'claude']), ['claude']);
    });

    it('allows custom defaults', () => {
      assert.deepStrictEqual(resolveActiveAgents(null, ['a', 'b']), ['a', 'b']);
    });
  });

  describe('computeAdversarialResumePoint', () => {
    it('returns round 1, phase 0 for empty transcript', () => {
      const result = computeAdversarialResumePoint([]);
      assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 0 });
    });

    it('returns Infinity for implement phase', () => {
      const transcript = [{ phase: 'implement', round: 2 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, Infinity);
    });

    it('advances phase after diverge', () => {
      const transcript = [{ phase: 'diverge', round: 1 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 1);
      assert.equal(result.startPhaseIdx, 1); // attack
    });

    it('advances phase after attack', () => {
      const transcript = [{ phase: 'attack', round: 1 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 1);
      assert.equal(result.startPhaseIdx, 2); // synthesize
    });

    it('advances round after synthesize (last phase)', () => {
      const transcript = [{ phase: 'synthesize', round: 1 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 2);
      assert.equal(result.startPhaseIdx, 0);
    });

    it('handles unknown phase as end of round', () => {
      const transcript = [{ phase: 'bogus', round: 3 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 4);
      assert.equal(result.startPhaseIdx, 0);
    });

    it('handles round 0 gracefully', () => {
      const transcript = [{ phase: 'diverge', round: 0 }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 1);
      assert.equal(result.startPhaseIdx, 1);
    });

    it('handles NaN round gracefully', () => {
      const transcript = [{ phase: 'diverge', round: Number.NaN }];
      const result = computeAdversarialResumePoint(transcript);
      assert.equal(result.startRound, 1);
    });
  });
});
