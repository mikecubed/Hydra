/**
 * Deep coverage tests for hydra-council.ts — exported pure functions:
 * extractDecisionOptions, extractAssumptions, extractAssumptionAttacks,
 * extractFinalDecision, deriveCouncilRecommendation, synthesizeCouncilTranscript,
 * buildStepPrompt, resolveActiveAgents, computeAdversarialResumePoint.
 *
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Module Mocks ──────────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: {} });

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: () => '[test-context]',
    getProjectContext: () => '',
    extractPathsFromPrompt: () => [],
    findScopedContextFiles: () => [],
    compileHierarchicalContext: () => '',
  },
});

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: (name: string) => ({
      label: name.charAt(0).toUpperCase() + name.slice(1),
      enabled: true,
      cli: name,
      rolePrompt: `You are ${name}.`,
      taskRules: [],
      taskAffinity: {},
    }),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getMode: () => 'balanced',
    setMode: () => 'balanced',
  },
});

mock.module('../lib/hydra-setup.ts', {
  namedExports: {
    commandExists: () => true,
    registerCustomAgentMcp: () => {},
    KNOWN_CLI_MCP_PATHS: [],
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
      configPath: '/tmp/test-project/hydra.config.json',
    }),
    loadHydraConfig: () => ({
      local: { enabled: false },
      routing: { councilMode: 'sequential' },
      roles: {},
    }),
    getRoleConfig: () => {},
    invalidateConfigCache: () => {},
    configStore: { load: () => ({}) },
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00.000Z',
    runId: (prefix: string) => `${prefix}_test`,
    parseArgs: () => ({ options: {}, positionals: [] }),
    getPrompt: () => '',
    boolFlag: (_v: unknown, d: boolean) => d,
    short: (text: unknown, max: number) => {
      const s = typeof text === 'string' ? text : '';
      return s.length > max ? `${s.slice(0, max)}...` : s;
    },
    parseJsonLoose: (text: string): unknown => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    },
    ensureDir: () => {},
    request: mock.fn(async () => ({ ok: true })),
    sanitizeOwner: (s: string) => s,
    normalizeTask: (item: unknown, fallbackOwner = 'unassigned') => {
      if (item == null || typeof item !== 'object') return null;
      const t = item as Record<string, unknown>;
      return {
        owner: (t['owner'] as string) ?? fallbackOwner,
        title: (t['title'] as string) ?? '',
        done: (t['done'] as string) ?? (t['definition_of_done'] as string) ?? '',
        rationale: (t['rationale'] as string) ?? '',
      };
    },
    dedupeTasks: (tasks: unknown[]) => tasks,
    classifyPrompt: () => ({ tier: 'simple' }),
    generateSpec: async () => null,
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgentWithRecovery: mock.fn(async () => ({
      ok: true,
      output: '{}',
      stdout: '{}',
      stderr: '',
      error: '',
      exitCode: 0,
      recovered: false,
    })),
    DefaultAgentExecutor: class {
      executeAgent = mock.fn(async () => ({ ok: true, output: '{}' }));
    },
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

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: () => ({ level: 'ok', percent: 10 }),
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: (agent: string) => `[${agent}]`,
    getProcessLabel: (k: string) => k,
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (t: string) => `=== ${t} ===`,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (a: string) => a,
    createSpinner: () => ({
      start: () => {},
      succeed: () => {},
      fail: () => {},
      update: () => {},
    }),
    SUCCESS: (t: string) => t,
    ERROR: (t: string) => t,
    WARNING: (t: string) => t,
    DIM: (t: string) => t,
    ACCENT: (t: string) => t,
    divider: () => '---',
    formatElapsed: () => '0s',
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    dim: (s: string) => s,
    green: (s: string) => s,
    red: (s: string) => s,
    yellow: (s: string) => s,
    cyan: (s: string) => s,
    bold: (s: string) => s,
  },
});

// ── Import module under test ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import type needed for mock pattern
type CouncilMod = typeof import('../lib/hydra-council.ts');
let mod: CouncilMod;

before(async () => {
  mod = await import('../lib/hydra-council.ts');
});

// ── extractDecisionOptions ────────────────────────────────────────────────────

describe('extractDecisionOptions', () => {
  it('returns empty array for null/undefined', () => {
    assert.deepEqual(mod.extractDecisionOptions(null), []);
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined
    assert.deepEqual(mod.extractDecisionOptions(undefined), []);
  });

  it('returns empty array for non-object', () => {
    assert.deepEqual(mod.extractDecisionOptions('hello'), []);
    assert.deepEqual(mod.extractDecisionOptions(42), []);
  });

  it('extracts from decision_options key', () => {
    const parsed = {
      decision_options: [
        { option: 'A', summary: 'Option A', preferred: true },
        { option: 'B', summary: 'Option B', preferred: false },
      ],
    };
    const result = mod.extractDecisionOptions(parsed);
    assert.equal(result.length, 2);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'A');
    assert.equal(first['preferred'], true);
  });

  it('extracts from options key', () => {
    const parsed = {
      options: [{ name: 'Opt1', description: 'First option' }],
    };
    const result = mod.extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('extracts from candidate_options key', () => {
    const parsed = {
      candidate_options: [{ title: 'Candidate', summary: 'Test' }],
    };
    const result = mod.extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('deduplicates identical options', () => {
    const parsed = {
      decision_options: [
        { option: 'A', summary: 'Same' },
        { option: 'A', summary: 'Same' },
      ],
    };
    const result = mod.extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('skips null/empty entries', () => {
    const parsed = {
      decision_options: [null, { option: '', summary: '' }, { option: 'Valid', summary: 'Yes' }],
    };
    const result = mod.extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('assigns default option name when missing', () => {
    const parsed = {
      decision_options: [{ summary: 'No name option' }],
    };
    const result = mod.extractDecisionOptions(parsed);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'option_1');
  });
});

// ── extractAssumptions ────────────────────────────────────────────────────────

describe('extractAssumptions', () => {
  it('returns empty array for null', () => {
    assert.deepEqual(mod.extractAssumptions(null), []);
  });

  it('extracts from assumptions key', () => {
    const parsed = {
      assumptions: [
        { assumption: 'API is stable', status: 'open', evidence: 'docs', impact: 'high' },
      ],
    };
    const result = mod.extractAssumptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'API is stable');
    assert.equal(first['status'], 'open');
  });

  it('extracts from open_assumptions key', () => {
    const parsed = {
      open_assumptions: [{ assumption: 'Test', status: 'validated' }],
    };
    const result = mod.extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });

  it('handles string assumptions', () => {
    const parsed = {
      assumptions: ['Simple string assumption'],
    };
    const result = mod.extractAssumptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'Simple string assumption');
    assert.equal(first['status'], 'open');
  });

  it('normalizes invalid status to open', () => {
    const parsed = {
      assumptions: [{ assumption: 'Test', status: 'invalid-status' }],
    };
    const result = mod.extractAssumptions(parsed);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['status'], 'open');
  });

  it('deduplicates assumptions', () => {
    const parsed = {
      assumptions: [
        { assumption: 'Same', status: 'open' },
        { assumption: 'Same', status: 'validated' },
      ],
    };
    const result = mod.extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });

  it('skips null and empty items', () => {
    const parsed = {
      assumptions: [null, { assumption: '' }, { assumption: 'Valid' }],
    };
    const result = mod.extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });
});

// ── extractAssumptionAttacks ──────────────────────────────────────────────────

describe('extractAssumptionAttacks', () => {
  it('returns empty for null', () => {
    assert.deepEqual(mod.extractAssumptionAttacks(null), []);
  });

  it('extracts from assumption_attacks key', () => {
    const parsed = {
      assumption_attacks: [
        { target_agent: 'claude', attack_vector: 'race condition', impact: 'high' },
      ],
    };
    const result = mod.extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
  });

  it('extracts from counterarguments key', () => {
    const parsed = {
      counterarguments: [{ challenge: 'flawed logic', assumption: 'test' }],
    };
    const result = mod.extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
  });

  it('handles string attacks', () => {
    const parsed = {
      assumption_attacks: ['Simple attack string'],
    };
    const result = mod.extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'Simple attack string');
  });
});

// ── extractFinalDecision ──────────────────────────────────────────────────────

describe('extractFinalDecision', () => {
  it('returns null for null/undefined', () => {
    assert.equal(mod.extractFinalDecision(null), null);
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined
    assert.equal(mod.extractFinalDecision(undefined), null);
  });

  it('returns null when no decision fields present', () => {
    assert.equal(mod.extractFinalDecision({}), null);
  });

  it('extracts decision from nested decision object', () => {
    const parsed = {
      decision: {
        summary: 'Use approach A',
        why: 'Most reversible',
        owner: 'claude',
        confidence: 'high',
        next_action: 'handoff',
        reversible_first_step: 'Create feature flag',
        tradeoffs: { correctness: 'High', complexity: 'Low' },
      },
    };
    const result = mod.extractFinalDecision(parsed);
    assert.ok(result !== null);
    assert.equal(result.summary, 'Use approach A');
    assert.equal(result.confidence, 'high');
    assert.equal(result.nextAction, 'handoff');
    assert.equal(result.reversibleFirstStep, 'Create feature flag');
  });

  it('uses fallback agent/phase when provided', () => {
    const parsed = {
      decision: { summary: 'Test', why: 'Because' },
    };
    const result = mod.extractFinalDecision(parsed, { agent: 'gemini', phase: 'critique' });
    assert.ok(result !== null);
    assert.equal(result.sourceAgent, 'gemini');
    assert.equal(result.sourcePhase, 'critique');
  });

  it('extracts from top-level consensus/view', () => {
    const parsed = {
      consensus: 'We agree on A',
    };
    const result = mod.extractFinalDecision(parsed);
    assert.ok(result !== null);
    assert.equal(result.summary, 'We agree on A');
  });

  it('normalizes confidence to lowercase', () => {
    const parsed = {
      decision: { summary: 'X', confidence: 'HIGH' },
    };
    const result = mod.extractFinalDecision(parsed);
    assert.ok(result !== null);
    assert.equal(result.confidence, 'high');
  });

  it('normalizes next_action values', () => {
    const parsed = {
      decision: { summary: 'X', next_action: 'delegate' },
    };
    const result = mod.extractFinalDecision(parsed);
    assert.ok(result !== null);
    assert.equal(result.nextAction, 'handoff');
  });
});

// ── deriveCouncilRecommendation ───────────────────────────────────────────────

describe('deriveCouncilRecommendation', () => {
  it('defaults to handoff when no signals', () => {
    const result = mod.deriveCouncilRecommendation({});
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
  });

  it('recommends council on low confidence + open assumptions', () => {
    const result = mod.deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      assumptions: [{ status: 'open' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('recommends council on many risks', () => {
    const result = mod.deriveCouncilRecommendation({
      risks: ['r1', 'r2', 'r3', 'r4'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('recommends council on disagreements', () => {
    const result = mod.deriveCouncilRecommendation({
      disagreements: ['they disagree'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('respects explicit council next_action', () => {
    const result = mod.deriveCouncilRecommendation({
      finalDecision: { nextAction: 'council' },
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('respects explicit human_decision next_action', () => {
    const result = mod.deriveCouncilRecommendation({
      finalDecision: { nextAction: 'human_decision' },
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('respects handoff when synthesis looks strong', () => {
    const result = mod.deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'high' },
    });
    assert.equal(result.recommendedMode, 'handoff');
  });

  it('overrides handoff to council when synthesis weak', () => {
    const result = mod.deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'low' },
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('includes rationale string', () => {
    const result = mod.deriveCouncilRecommendation({});
    assert.ok(result.rationale.includes('decision_owner='));
    assert.ok(result.rationale.includes('risk_items='));
  });

  it('triggers council on positive council votes with risks', () => {
    const result = mod.deriveCouncilRecommendation({
      councilVotes: [{ vote: true }],
      risks: ['something'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('triggers council on cross-agent questions > 1', () => {
    const result = mod.deriveCouncilRecommendation({
      questions: [{ to: 'gemini' }, { to: 'codex' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });
});

// ── synthesizeCouncilTranscript ───────────────────────────────────────────────

describe('synthesizeCouncilTranscript', () => {
  it('returns default tasks when transcript is empty', () => {
    const result = mod.synthesizeCouncilTranscript('test prompt', []);
    assert.equal(result.prompt, 'test prompt');
    assert.ok(result.tasks.length > 0);
    assert.equal(result.recommendedMode, 'handoff');
  });

  it('synthesizes parsed transcript entries', () => {
    const transcript = [
      {
        round: 1,
        agent: 'claude',
        phase: 'propose',
        parsed: {
          view: 'We should do X',
          recommended_tasks: [
            { owner: 'claude', title: 'Plan X', rationale: 'Needed', definition_of_done: 'Done' },
          ],
          risks: ['Risk A'],
          assumptions: [{ assumption: 'API stable', status: 'open' }],
        },
      },
      {
        round: 1,
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          critique: 'Missing edge cases',
          risks: ['Risk B'],
          questions: [{ to: 'human', question: 'What about X?' }],
        },
      },
      {
        round: 1,
        agent: 'codex',
        phase: 'implement',
        parsed: {
          consensus: 'Agreed on approach',
          task_allocations: [{ owner: 'codex', title: 'Implement Y', rationale: 'Ready' }],
          decision: {
            summary: 'Go with approach A',
            why: 'Most reversible',
            owner: 'claude',
            confidence: 'high',
            next_action: 'handoff',
          },
        },
      },
    ];
    const result = mod.synthesizeCouncilTranscript('test prompt', transcript);
    assert.ok(result.consensus.length > 0);
    assert.ok(result.tasks.length > 0);
    assert.ok(result.risks.length > 0);
    assert.ok(result.questions.length > 0);
    assert.ok(result.finalDecision !== null);
  });

  it('skips entries without parsed data', () => {
    const transcript = [
      { round: 1, agent: 'claude', phase: 'propose', parsed: null, rawText: 'raw output' },
    ];
    const result = mod.synthesizeCouncilTranscript('test', transcript);
    // Should still produce default tasks
    assert.ok(result.tasks.length > 0);
  });
});

// ── buildStepPrompt ───────────────────────────────────────────────────────────

describe('buildStepPrompt', () => {
  it('builds propose phase prompt', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Analyze and propose.' };
    const result = mod.buildStepPrompt(step, 'test objective', [], 1, 2);
    assert.ok(result.includes('Claude'));
    assert.ok(result.includes('propose'));
    assert.ok(result.includes('test objective'));
    assert.ok(result.includes('round 1/2'));
  });

  it('builds critique phase prompt', () => {
    const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review critically.' };
    const result = mod.buildStepPrompt(step, 'objective', [], 1, 2);
    assert.ok(result.includes('critique'));
    assert.ok(result.includes('attack the strongest assumption'));
  });

  it('builds refine phase prompt', () => {
    const step = { agent: 'claude', phase: 'refine', promptLabel: 'Refine.' };
    const result = mod.buildStepPrompt(step, 'objective', [], 1, 2);
    assert.ok(result.includes('refine'));
    assert.ok(result.includes('resolve critique'));
  });

  it('builds implement phase prompt', () => {
    const step = { agent: 'codex', phase: 'implement', promptLabel: 'Implement.' };
    const result = mod.buildStepPrompt(step, 'objective', [], 1, 2);
    assert.ok(result.includes('implement'));
    assert.ok(result.includes('final synthesizer'));
  });

  it('includes spec content when provided', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Propose.' };
    const result = mod.buildStepPrompt(step, 'objective', [], 1, 1, 'SPEC: must do X');
    assert.ok(result.includes('SPEC: must do X'));
    assert.ok(result.includes('Anchoring Specification'));
  });

  it('includes transcript context summary', () => {
    const transcript = [
      { round: 1, agent: 'claude', phase: 'propose', parsed: { view: 'My analysis' } },
    ];
    const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Critique.' };
    const result = mod.buildStepPrompt(step, 'objective', transcript, 1, 2);
    assert.ok(result.includes('CLAUDE'));
  });
});

// ── resolveActiveAgents ───────────────────────────────────────────────────────

describe('resolveActiveAgents', () => {
  it('returns defaults when no filter', () => {
    const result = mod.resolveActiveAgents(null);
    assert.deepEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('returns defaults when empty filter', () => {
    const result = mod.resolveActiveAgents([]);
    assert.deepEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('filters to specified agents', () => {
    const result = mod.resolveActiveAgents(['claude', 'codex']);
    assert.deepEqual(result, ['claude', 'codex']);
  });

  it('preserves default ordering', () => {
    const result = mod.resolveActiveAgents(['codex', 'claude']);
    assert.deepEqual(result, ['claude', 'codex']);
  });

  it('uses custom defaults', () => {
    const result = mod.resolveActiveAgents(null, ['a', 'b']);
    assert.deepEqual(result, ['a', 'b']);
  });
});

// ── computeAdversarialResumePoint ─────────────────────────────────────────────

describe('computeAdversarialResumePoint', () => {
  it('starts at round 1 phase 0 for empty transcript', () => {
    const result = mod.computeAdversarialResumePoint([]);
    assert.deepEqual(result, { startRound: 1, startPhaseIdx: 0 });
  });

  it('returns Infinity when implement already done', () => {
    const transcript = [{ phase: 'implement', round: 2 }];
    const result = mod.computeAdversarialResumePoint(transcript);
    assert.equal(result.startRound, Infinity);
  });

  it('advances to attack after diverge', () => {
    const transcript = [{ phase: 'diverge', round: 1 }];
    const result = mod.computeAdversarialResumePoint(transcript);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 1); // attack
  });

  it('advances to synthesize after attack', () => {
    const transcript = [{ phase: 'attack', round: 1 }];
    const result = mod.computeAdversarialResumePoint(transcript);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 2); // synthesize
  });

  it('advances to next round after synthesize', () => {
    const transcript = [{ phase: 'synthesize', round: 1 }];
    const result = mod.computeAdversarialResumePoint(transcript);
    assert.equal(result.startRound, 2);
    assert.equal(result.startPhaseIdx, 0); // diverge of next round
  });

  it('handles unknown phase by advancing round', () => {
    const transcript = [{ phase: 'unknown', round: 3 }];
    const result = mod.computeAdversarialResumePoint(transcript);
    assert.equal(result.startRound, 4);
    assert.equal(result.startPhaseIdx, 0);
  });
});

// ── COUNCIL_DECISION_CRITERIA ─────────────────────────────────────────────────

describe('COUNCIL_DECISION_CRITERIA', () => {
  it('has four criteria', () => {
    assert.equal(mod.COUNCIL_DECISION_CRITERIA.length, 4);
  });

  it('includes correctness, complexity, reversibility, user_impact', () => {
    const keys = mod.COUNCIL_DECISION_CRITERIA.map((c) => c.key);
    assert.ok(keys.includes('correctness'));
    assert.ok(keys.includes('complexity'));
    assert.ok(keys.includes('reversibility'));
    assert.ok(keys.includes('user_impact'));
  });
});
