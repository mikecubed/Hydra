/**
 * Deep coverage tests for lib/hydra-council.ts
 *
 * Targets the many extraction, normalization, synthesis, and prompt-building
 * functions to push coverage well beyond the existing test files.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock all I/O dependencies ────────────────────────────────────────────────

const noopFn = mock.fn(() => {});
const returnFalse = mock.fn(() => false);

// hydra-env
mock.module('../lib/hydra-env.ts', {
  namedExports: { envFileExists: mock.fn(() => true) },
});

// hydra-config
mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mock.fn(() => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test-project',
      runsDir: '/tmp/test-project/.hydra/runs',
      configPath: '/tmp/test-project/hydra.config.json',
      routing: { mode: 'balanced' },
    })),
    loadHydraConfig: mock.fn(() => ({
      routing: { mode: 'balanced' },
    })),
    HYDRA_ROOT: '/tmp/hydra-root',
  },
});

// hydra-context
mock.module('../lib/hydra-context.ts', {
  namedExports: { buildAgentContext: mock.fn(() => 'agent context block') },
});

// hydra-agents
mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mock.fn((name: string) => ({
      name,
      label: name.toUpperCase(),
      rolePrompt: `You are ${name}`,
      strengths: [],
      tags: [],
    })),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    getMode: mock.fn(() => 'balanced'),
    setMode: noopFn,
  },
});

// hydra-setup
mock.module('../lib/hydra-setup.ts', {
  namedExports: { commandExists: returnFalse },
});

// hydra-usage
mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mock.fn(() => ({ level: 'ok', percent: 10 })),
  },
});

// hydra-utils
mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    parseArgs: mock.fn(() => ({ options: {}, positionals: [] })),
    getPrompt: mock.fn(() => ''),
    boolFlag: mock.fn((_v: unknown, def: boolean) => def),
    short: mock.fn((s: string, n: number) => (s || '').slice(0, n)),
    request: mock.fn(async () => ({})),
    nowIso: mock.fn(() => '2026-01-01T00:00:00Z'),
    runId: mock.fn(() => 'test-run-id'),
    parseJsonLoose: mock.fn((s: string): unknown => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    }),
    ensureDir: noopFn,
    sanitizeOwner: mock.fn((s: string) => s),
    normalizeTask: mock.fn((item: unknown) => item),
    dedupeTasks: mock.fn((arr: unknown[]) => arr),
    classifyPrompt: mock.fn(() => ({
      tier: 'standard',
      confidence: 0.8,
      routeStrategy: 'single',
    })),
    generateSpec: mock.fn(async () => null),
  },
});

// hydra-ui
mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: mock.fn((s: string) => `== ${s} ==`),
    label: mock.fn((l: string, v: string) => `${l}: ${v}`),
    colorAgent: mock.fn((a: string) => a),
    createSpinner: mock.fn(() => ({
      start: mock.fn(function (this: unknown) {
        return this;
      }),
      stop: noopFn,
      succeed: noopFn,
      fail: noopFn,
      update: noopFn,
    })),
    divider: mock.fn(() => '---'),
    SUCCESS: mock.fn((s: string) => s),
    ERROR: mock.fn((s: string) => s),
    WARNING: mock.fn((s: string) => s),
    DIM: mock.fn((s: string) => s),
    ACCENT: mock.fn((s: string) => s),
    formatElapsed: mock.fn(() => '1s'),
  },
});

// hydra-shared/agent-executor
mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgentWithRecovery: mock.fn(async () => ({
      ok: true,
      output: '{}',
      stdout: '{}',
      stderr: '',
      error: '',
      exitCode: 0,
      command: 'test',
      args: [],
      promptSnippet: '',
      recovered: false,
    })),
  },
});

// hydra-model-recovery
mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    detectRateLimitError: mock.fn(() => ({ isRateLimit: false })),
    calculateBackoff: mock.fn(() => 1000),
  },
});

// hydra-doctor
mock.module('../lib/hydra-doctor.ts', {
  namedExports: {
    diagnose: noopFn,
    isDoctorEnabled: returnFalse,
  },
});

// hydra-persona
mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: mock.fn(() => false),
    getAgentFraming: mock.fn((a: string) => `You are ${a}`),
  },
});

// ── Import module under test ─────────────────────────────────────────────────

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

// ── extractDecisionOptions deep tests ────────────────────────────────────────

describe('extractDecisionOptions deep', () => {
  it('handles array input gracefully', () => {
    assert.deepStrictEqual(extractDecisionOptions([1, 2, 3]), []);
  });

  it('handles option items with only title', () => {
    const result = extractDecisionOptions({
      options: [{ title: 'Foo' }],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'Foo');
  });

  it('handles option items with null sub-items', () => {
    const result = extractDecisionOptions({
      options: [null, undefined, { option: 'Real' }],
    });
    assert.equal(result.length, 1);
  });

  it('generates fallback option names when option field is empty', () => {
    const result = extractDecisionOptions({
      decision_options: [{ summary: 'Some description' }],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'option_1');
  });

  it('skips items where both option and summary are empty', () => {
    const result = extractDecisionOptions({
      options: [{}],
    });
    assert.equal(result.length, 0);
  });

  it('merges duplicate options with later values', () => {
    const result = extractDecisionOptions({
      decision_options: [
        { option: 'X', summary: 'desc', preferred: false },
        { option: 'X', summary: 'desc', preferred: true },
      ],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['preferred'], true);
  });

  it('extracts tradeoffs from items', () => {
    const result = extractDecisionOptions({
      decision_options: [
        {
          option: 'A',
          summary: 'X',
          tradeoffs: { correctness: 'High', complexity: 'Low' },
        },
      ],
    });
    const first = result[0] as Record<string, unknown>;
    const tradeoffs = first['tradeoffs'] as Record<string, string>;
    assert.equal(tradeoffs['correctness'], 'High');
  });

  it('handles criteria key for tradeoffs', () => {
    const result = extractDecisionOptions({
      options: [
        {
          option: 'B',
          summary: 'Y',
          criteria: { user_impact: 'Minimal' },
        },
      ],
    });
    const first = result[0] as Record<string, unknown>;
    const tradeoffs = first['tradeoffs'] as Record<string, string>;
    assert.equal(tradeoffs['user_impact'], 'Minimal');
  });
});

// ── extractAssumptions deep ──────────────────────────────────────────────────

describe('extractAssumptions deep', () => {
  it('returns empty for null', () => {
    assert.deepStrictEqual(extractAssumptions(null), []);
  });

  it('returns empty for non-object', () => {
    assert.deepStrictEqual(extractAssumptions(42), []);
  });

  it('extracts from assumptions key', () => {
    const result = extractAssumptions({
      assumptions: [
        {
          assumption: 'DB will scale',
          status: 'open',
          evidence: 'benchmarks',
          impact: 'high',
          owner: 'claude',
        },
      ],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'DB will scale');
    assert.equal(first['status'], 'open');
  });

  it('extracts from open_assumptions and key_assumptions', () => {
    const result = extractAssumptions({
      open_assumptions: [{ assumption: 'A1', status: 'open' }],
      key_assumptions: [{ assumption: 'A2', status: 'validated' }],
    });
    assert.equal(result.length, 2);
  });

  it('normalizes string assumptions', () => {
    const result = extractAssumptions({
      assumptions: ['Simple string assumption'],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'Simple string assumption');
    assert.equal(first['status'], 'open');
    assert.equal(first['owner'], 'unassigned');
  });

  it('skips null/undefined items', () => {
    const result = extractAssumptions({
      assumptions: [null, undefined, { assumption: 'Real' }],
    });
    assert.equal(result.length, 1);
  });

  it('skips items with empty assumption text', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: '', status: 'open' }],
    });
    assert.equal(result.length, 0);
  });

  it('deduplicates by assumption text', () => {
    const result = extractAssumptions({
      assumptions: [
        { assumption: 'Same', status: 'open' },
        { assumption: 'Same', status: 'validated' },
      ],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    // Later value should win for merged truthy
    assert.equal(first['status'], 'validated');
  });

  it('normalizes invalid status to "open"', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'Test', status: 'invalid_status' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['status'], 'open');
  });

  it('reads name/summary/question as fallbacks for assumption field', () => {
    const r1 = extractAssumptions({ assumptions: [{ name: 'By name' }] });
    assert.equal((r1[0] as Record<string, unknown>)['assumption'], 'By name');

    const r2 = extractAssumptions({ assumptions: [{ summary: 'By summary' }] });
    assert.equal((r2[0] as Record<string, unknown>)['assumption'], 'By summary');

    const r3 = extractAssumptions({ assumptions: [{ question: 'By question' }] });
    assert.equal((r3[0] as Record<string, unknown>)['assumption'], 'By question');
  });
});

// ── extractAssumptionAttacks deep ────────────────────────────────────────────

describe('extractAssumptionAttacks deep', () => {
  it('returns empty for null', () => {
    assert.deepStrictEqual(extractAssumptionAttacks(null), []);
  });

  it('extracts from assumption_attacks key', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: [
        {
          target_agent: 'gemini',
          attack_vector: 'DB might not scale',
          impact: 'high',
          by: 'claude',
        },
      ],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'DB might not scale');
    assert.equal(first['assumption'], 'gemini');
  });

  it('extracts from assumption_challenges key', () => {
    const result = extractAssumptionAttacks({
      assumption_challenges: [{ challenge: 'Network latency', impact: 'medium' }],
    });
    assert.equal(result.length, 1);
  });

  it('extracts from counterarguments key', () => {
    const result = extractAssumptionAttacks({
      counterarguments: [{ critique: 'Approach is flawed', assumption: 'Scalability' }],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'Approach is flawed');
  });

  it('normalizes string items', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: ['Simple attack string'],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'Simple attack string');
    // assumption may be '' or undefined after dedup merging strips empty strings
    assert.ok(first['assumption'] === '' || first['assumption'] === undefined);
  });

  it('skips empty text items', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: ['', '  '],
    });
    assert.equal(result.length, 0);
  });

  it('skips null/non-object items', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: [null, 42, true],
    });
    assert.equal(result.length, 0);
  });

  it('deduplicates by assumption|challenge', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: [
        { assumption: 'A', challenge: 'C' },
        { assumption: 'A', challenge: 'C', impact: 'updated' },
      ],
    });
    assert.equal(result.length, 1);
  });

  it('reads text field as challenge fallback', () => {
    const result = extractAssumptionAttacks({
      assumption_attacks: [{ text: 'from text field', target: 'codex' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'from text field');
    assert.equal(first['assumption'], 'codex');
  });
});

// ── extractFinalDecision deep ────────────────────────────────────────────────

describe('extractFinalDecision deep', () => {
  it('returns null for null input', () => {
    assert.equal(extractFinalDecision(null), null);
  });

  it('returns null for non-object input', () => {
    assert.equal(extractFinalDecision('string'), null);
  });

  it('returns null when no decision fields are present', () => {
    assert.equal(extractFinalDecision({ foo: 'bar' }), null);
  });

  it('extracts from a decision sub-object', () => {
    const result = extractFinalDecision({
      decision: {
        summary: 'Use approach A',
        why: 'Best tradeoff',
        owner: 'claude',
        confidence: 'high',
        next_action: 'handoff',
        reversible_first_step: 'Create feature branch',
        tradeoffs: { correctness: 'High' },
      },
    });
    assert.ok(result !== null);
    assert.equal(result.summary, 'Use approach A');
    assert.equal(result.why, 'Best tradeoff');
    assert.equal(result.confidence, 'high');
    assert.equal(result.nextAction, 'handoff');
    assert.equal(result.reversibleFirstStep, 'Create feature branch');
  });

  it('uses fallback agent/phase when provided', () => {
    const result = extractFinalDecision(
      { decision: { summary: 'Test' } },
      { agent: 'gemini', phase: 'critique' },
    );
    assert.ok(result !== null);
    assert.equal(result.sourceAgent, 'gemini');
    assert.equal(result.sourcePhase, 'critique');
  });

  it('reads consensus/view as summary fallbacks', () => {
    const result = extractFinalDecision({ consensus: 'Agreed plan' });
    assert.ok(result !== null);
    assert.equal(result.summary, 'Agreed plan');
  });

  it('reads decision_rationale as why fallback', () => {
    const result = extractFinalDecision({
      decision_rationale: 'Because safety',
      consensus: 'Do it',
    });
    assert.ok(result !== null);
    assert.equal(result.why, 'Because safety');
  });

  it('normalizes confidence values', () => {
    const r1 = extractFinalDecision({ confidence: 'HIGH', consensus: 'X' });
    assert.equal(r1!.confidence, 'high');

    const r2 = extractFinalDecision({ confidence: 'INVALID', consensus: 'X' });
    assert.equal(r2!.confidence, '');
  });

  it('normalizes next_action values', () => {
    const r1 = extractFinalDecision({ decision: { next_action: 'delegate', summary: 'X' } });
    assert.equal(r1!.nextAction, 'handoff');

    const r2 = extractFinalDecision({
      decision: { next_action: 'deeper_council', summary: 'X' },
    });
    assert.equal(r2!.nextAction, 'council');

    const r3 = extractFinalDecision({
      decision: { next_action: 'human_decision', summary: 'X' },
    });
    assert.equal(r3!.nextAction, 'human_decision');
  });

  it('reads camelCase decision keys', () => {
    const result = extractFinalDecision({
      decision: {
        summary: 'Test',
        nextAction: 'handoff',
        reversibleFirstStep: 'Step 1',
      },
    });
    assert.ok(result !== null);
    assert.equal(result.nextAction, 'handoff');
    assert.equal(result.reversibleFirstStep, 'Step 1');
  });
});

// ── deriveCouncilRecommendation deep ─────────────────────────────────────────

describe('deriveCouncilRecommendation deep', () => {
  it('returns handoff with no inputs', () => {
    const result = deriveCouncilRecommendation();
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
  });

  it('returns council when decision says council', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'council' },
    });
    assert.equal(result.recommendedMode, 'council');
    assert.equal(result.nextAction, 'council');
  });

  it('returns council when decision says human_decision', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'human_decision' },
    });
    assert.equal(result.recommendedMode, 'council');
    assert.equal(result.nextAction, 'human_decision');
  });

  it('returns handoff when handoff with good confidence', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'high' },
    });
    assert.equal(result.recommendedMode, 'handoff');
  });

  it('returns council when handoff with low confidence and disagreements', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'low' },
      disagreements: ['issue1', 'issue2'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when many risks', () => {
    const result = deriveCouncilRecommendation({
      risks: ['r1', 'r2', 'r3', 'r4'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when disagreements present', () => {
    const result = deriveCouncilRecommendation({
      disagreements: ['d1'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when positive council votes and risks', () => {
    const result = deriveCouncilRecommendation({
      councilVotes: [{ vote: true }],
      risks: ['r1'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when low confidence with open assumptions', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      assumptions: [{ status: 'open' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when low confidence with human questions', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      questions: [{ to: 'human' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when low confidence with risks', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      risks: ['r1'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('returns council when cross-agent questions exceed threshold', () => {
    const result = deriveCouncilRecommendation({
      questions: [{ to: 'gemini' }, { to: 'codex' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('includes rationale in result', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { owner: 'claude', confidence: 'high', nextAction: 'handoff' },
    });
    assert.ok(typeof result.rationale === 'string');
    assert.ok(result.rationale.length > 0);
  });
});

// ── synthesizeCouncilTranscript deep ─────────────────────────────────────────

describe('synthesizeCouncilTranscript deep', () => {
  it('returns default tasks when no task candidates in transcript', () => {
    const result = synthesizeCouncilTranscript('Test prompt', []);
    assert.ok(result.tasks.length > 0);
    assert.equal(result.prompt, 'Test prompt');
    assert.equal(result.consensus, '');
  });

  it('extracts consensus from last codex entry', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: { consensus: 'Agreed on approach A' },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.equal(result.consensus, 'Agreed on approach A');
  });

  it('extracts consensus from last claude refine entry', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'refine',
        parsed: { view: 'Refined view' },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.equal(result.consensus, 'Refined view');
  });

  it('accumulates tasks from multiple agents', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          recommended_tasks: [{ owner: 'claude', title: 'Task A' }],
        },
        round: 1,
      },
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          task_allocations: [{ owner: 'codex', title: 'Task B' }],
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.tasks.length >= 2);
  });

  it('accumulates questions across agents', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          questions: [{ to: 'human', question: 'Q1' }],
        },
        round: 1,
      },
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          questions: [{ to: 'codex', question: 'Q2' }],
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.questions.length >= 2);
  });

  it('accumulates risks', () => {
    const transcript = [
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: { risks: ['Risk 1', 'Risk 2'], sanity_checks: ['Check 1'] },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.risks.length >= 2);
  });

  it('captures council votes', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: { should_open_council: true, council_reason: 'Need more discussion' },
        round: 1,
      },
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: { should_open_council: false },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.equal(result.councilVotes.length, 2);
  });

  it('extracts final decision from last agent', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          decision: {
            summary: 'Final approach',
            why: 'Best tradeoff',
            owner: 'codex',
            confidence: 'high',
            next_action: 'handoff',
            reversible_first_step: 'Create branch',
          },
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.finalDecision !== null);
    const fd = result.finalDecision as Record<string, unknown>;
    assert.equal(fd['summary'], 'Final approach');
  });

  it('handles entries without parsed field', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', parsed: null, round: 1 },
      { agent: 'gemini', phase: 'critique', round: 1 },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.tasks.length > 0); // default tasks
  });

  it('extracts disagreements', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: { disagreements: ['Agent A and B disagree on caching'] },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.disagreements.length >= 1);
  });

  it('extracts assumptions and assumption attacks', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          assumptions: [{ assumption: 'DB scales', status: 'open', owner: 'claude' }],
        },
        round: 1,
      },
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          assumption_attacks: [
            { target_agent: 'claude', attack_vector: 'DB may not scale under load' },
          ],
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.assumptions.length >= 1);
    assert.ok(result.assumptionAttacks.length >= 1);
  });

  it('extracts decision options from multiple agents', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          decision_options: [{ option: 'A', summary: 'Opt A' }],
        },
        round: 1,
      },
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          decision_options: [{ option: 'B', summary: 'Opt B' }],
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.decisionOptions.length >= 2);
  });

  it('computes recommendation based on accumulated data', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          decision: { summary: 'Do it', confidence: 'high', next_action: 'handoff' },
        },
        round: 1,
      },
    ];
    const result = synthesizeCouncilTranscript('Prompt', transcript);
    assert.ok(result.recommendedMode === 'handoff' || result.recommendedMode === 'council');
    assert.ok(typeof result.recommendationRationale === 'string');
  });
});

// ── buildStepPrompt deep ─────────────────────────────────────────────────────

describe('buildStepPrompt deep', () => {
  it('includes phase-specific JSON schema for propose', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Analyze' };
    const result = buildStepPrompt(step, 'Test objective', [], 1, 2);
    assert.ok(result.includes('"view"'));
    assert.ok(result.includes('should_open_council'));
    assert.ok(result.includes('recommended_tasks'));
  });

  it('includes phase-specific JSON schema for critique', () => {
    const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review' };
    const result = buildStepPrompt(step, 'Test objective', [], 1, 2);
    assert.ok(result.includes('"critique"'));
    assert.ok(result.includes('edge_cases'));
    assert.ok(result.includes('assumption_attacks'));
  });

  it('includes phase-specific JSON schema for refine', () => {
    const step = { agent: 'claude', phase: 'refine', promptLabel: 'Refine' };
    const result = buildStepPrompt(step, 'Test objective', [], 1, 2);
    assert.ok(result.includes('"view"'));
    assert.ok(result.includes('"decision"'));
  });

  it('includes phase-specific JSON schema for implement', () => {
    const step = { agent: 'codex', phase: 'implement', promptLabel: 'Implement' };
    const result = buildStepPrompt(step, 'Test objective', [], 1, 2);
    assert.ok(result.includes('"consensus"'));
    assert.ok(result.includes('task_allocations'));
    assert.ok(result.includes('review_chain'));
    assert.ok(result.includes('disagreements'));
  });

  it('includes decision criteria', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Test' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('Decision criteria for convergence:'));
  });

  it('includes spec content when provided', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Test' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1, 'SPEC: Do X, Y, Z');
    assert.ok(result.includes('Anchoring Specification'));
    assert.ok(result.includes('SPEC: Do X, Y, Z'));
  });

  it('omits spec content when null', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Test' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1, null);
    assert.ok(!result.includes('Anchoring Specification'));
  });

  it('includes context summary from transcript', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', parsed: { view: 'My view' }, round: 1 },
    ];
    const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review' };
    const result = buildStepPrompt(step, 'Objective', transcript, 1, 2);
    assert.ok(result.includes('CLAUDE'));
  });

  it('includes round information', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Test' };
    const result = buildStepPrompt(step, 'Objective', [], 2, 3);
    assert.ok(result.includes('round 2/3'));
  });

  it('includes focus instruction for critique phase', () => {
    const step = { agent: 'gemini', phase: 'critique', promptLabel: 'Review' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('attack the strongest assumption'));
  });

  it('includes focus instruction for implement phase', () => {
    const step = { agent: 'codex', phase: 'implement', promptLabel: 'Implement' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('final synthesizer'));
  });

  it('includes focus instruction for refine phase', () => {
    const step = { agent: 'claude', phase: 'refine', promptLabel: 'Refine' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('resolve critique'));
  });

  it('uses default focus for propose phase', () => {
    const step = { agent: 'claude', phase: 'propose', promptLabel: 'Analyze' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('surface distinct options'));
  });

  it('falls back to empty schema for unknown phase', () => {
    const step = { agent: 'claude', phase: 'unknown', promptLabel: 'Test' };
    const result = buildStepPrompt(step, 'Objective', [], 1, 1);
    assert.ok(result.includes('{}'));
  });
});

// ── resolveActiveAgents ──────────────────────────────────────────────────────

describe('resolveActiveAgents', () => {
  it('returns defaults when filter is null', () => {
    const result = resolveActiveAgents(null);
    assert.deepStrictEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('returns defaults when filter is empty', () => {
    const result = resolveActiveAgents([]);
    assert.deepStrictEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('filters to only matching agents in default order', () => {
    const result = resolveActiveAgents(['codex', 'claude']);
    assert.deepStrictEqual(result, ['claude', 'codex']);
  });

  it('returns empty if no agents match', () => {
    const result = resolveActiveAgents(['unknown']);
    assert.deepStrictEqual(result, []);
  });

  it('uses custom defaults', () => {
    const result = resolveActiveAgents(null, ['a', 'b']);
    assert.deepStrictEqual(result, ['a', 'b']);
  });
});

// ── computeAdversarialResumePoint ────────────────────────────────────────────

describe('computeAdversarialResumePoint', () => {
  it('returns start for empty transcript', () => {
    const result = computeAdversarialResumePoint([]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 0 });
  });

  it('returns Infinity when implement is last phase', () => {
    const result = computeAdversarialResumePoint([{ phase: 'implement', round: 2 }]);
    assert.equal(result.startRound, Infinity);
  });

  it('advances after diverge', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 1 }]);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 1);
  });

  it('advances after attack', () => {
    const result = computeAdversarialResumePoint([{ phase: 'attack', round: 1 }]);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 2);
  });

  it('advances to next round after synthesize', () => {
    const result = computeAdversarialResumePoint([{ phase: 'synthesize', round: 1 }]);
    assert.equal(result.startRound, 2);
    assert.equal(result.startPhaseIdx, 0);
  });

  it('handles unknown phase by advancing to next round', () => {
    const result = computeAdversarialResumePoint([{ phase: 'unknown', round: 2 }]);
    assert.equal(result.startRound, 3);
    assert.equal(result.startPhaseIdx, 0);
  });

  it('uses last entry when multiple entries exist', () => {
    const result = computeAdversarialResumePoint([
      { phase: 'diverge', round: 1 },
      { phase: 'attack', round: 1 },
    ]);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 2);
  });

  it('handles round 0 gracefully', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 0 }]);
    // Should treat 0 as 1
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 1);
  });

  it('handles NaN round gracefully', () => {
    const result = computeAdversarialResumePoint([{ phase: 'attack', round: Number.NaN }]);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 2);
  });
});

// ── COUNCIL_DECISION_CRITERIA ────────────────────────────────────────────────

describe('COUNCIL_DECISION_CRITERIA', () => {
  it('is a non-empty array', () => {
    assert.ok(Array.isArray(COUNCIL_DECISION_CRITERIA));
    assert.ok(COUNCIL_DECISION_CRITERIA.length > 0);
  });

  it('each entry has key and label', () => {
    for (const item of COUNCIL_DECISION_CRITERIA) {
      assert.ok(typeof item.key === 'string');
      assert.ok(typeof item.label === 'string');
    }
  });

  it('includes correctness and complexity', () => {
    const keys = COUNCIL_DECISION_CRITERIA.map((c) => c.key);
    assert.ok(keys.includes('correctness'));
    assert.ok(keys.includes('complexity'));
  });
});
