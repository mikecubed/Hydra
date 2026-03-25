/**
 * Pipeline tests for hydra-council.ts — exercises the council synthesis,
 * recommendation, transcript accumulation, and exported helpers.
 *
 * Mocks agent execution to avoid real CLI calls.
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies ────────────────────────────────────────────────────────

mock.module('../lib/hydra-env.ts', { namedExports: {} });

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mock.fn((name: string) => ({
      label: `${name}-label`,
      enabled: true,
      cli: name,
      rolePrompt: `${name} role prompt`,
    })),
    getMode: mock.fn(() => 'balanced'),
    setMode: mock.fn(),
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
    AGENTS: {},
  },
});

mock.module('../lib/hydra-setup.ts', {
  namedExports: {
    commandExists: mock.fn(() => true),
    registerCustomAgentMcp: mock.fn(),
    KNOWN_CLI_MCP_PATHS: [],
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: mock.fn(() => ({
      projectRoot: '/test',
      projectName: 'test-project',
      runsDir: '/tmp/test-runs',
    })),
    loadHydraConfig: mock.fn(() => ({
      local: { enabled: false },
      roles: {},
    })),
    getRoleConfig: mock.fn(() => null),
    _setTestConfig: mock.fn(),
    invalidateConfigCache: mock.fn(),
  },
});

mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: mock.fn(() => 'mocked context'),
  },
});

mock.module('../lib/hydra-usage.ts', {
  namedExports: {
    checkUsage: mock.fn(() => ({ level: 'ok', percent: 15 })),
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: mock.fn(() => false),
    getAgentFraming: mock.fn((a: string) => `framed-${a}`),
  },
});

mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    detectRateLimitError: mock.fn(() => false),
    calculateBackoff: mock.fn(() => 1000),
  },
});

mock.module('../lib/hydra-doctor.ts', {
  namedExports: {
    diagnose: mock.fn(),
    isDoctorEnabled: mock.fn(() => false),
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgentWithRecovery: mock.fn(async () => ({
      ok: true,
      output: '{"view":"test view"}',
      stdout: '{"view":"test view"}',
      stderr: '',
      error: '',
      exitCode: 0,
      signal: null,
      durationMs: 100,
      timedOut: false,
      recovered: false,
      originalModel: undefined,
      newModel: undefined,
    })),
    DefaultAgentExecutor: class {
      async executeAgent() {
        return { ok: true, output: '{}', stderr: '', error: null, exitCode: 0 };
      }
    },
  },
});

mock.module('../lib/hydra-ui.ts', {
  namedExports: {
    sectionHeader: (s: string) => s,
    label: (k: string, v: string) => `${k}: ${v}`,
    colorAgent: (s: string) => s,
    createSpinner: () => ({ start: mock.fn(), succeed: mock.fn(), fail: mock.fn() }),
    SUCCESS: (s: string) => s,
    ERROR: (s: string) => s,
    WARNING: (s: string) => s,
    DIM: (s: string) => s,
    ACCENT: (s: string) => s,
    divider: () => '---',
    formatElapsed: (ms: number) => `${String(ms)}ms`,
    box: (_t: string, _l: string[]) => '',
  },
});

mock.module('picocolors', {
  defaultExport: {
    white: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
    green: (s: string) => s,
    blue: (s: string) => s,
    bold: (s: string) => s,
    dim: (s: string) => s,
    gray: (s: string) => s,
    magenta: (s: string) => s,
    cyan: (s: string) => s,
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    nowIso: () => '2026-01-01T00:00:00Z',
    runId: () => 'TEST_COUNCIL_001',
    parseArgs: mock.fn((argv: string[]) => ({ options: {}, positionals: argv })),
    getPrompt: mock.fn(() => 'test prompt'),
    boolFlag: mock.fn((_v: unknown, def: boolean) => def),
    short: (s: string, n: number) => (s ?? '').slice(0, n),
    parseJsonLoose: mock.fn((s: string) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        return null;
      }
    }),
    request: mock.fn(),
    ensureDir: mock.fn(),
    sanitizeOwner: (s: string) => (s ?? 'unassigned').toLowerCase(),
    normalizeTask: mock.fn((item: unknown, fallbackOwner: string) => {
      if (item == null || typeof item !== 'object') return null;
      const t = item as Record<string, unknown>;
      return {
        owner: (t['owner'] as string) ?? fallbackOwner,
        title: (t['title'] as string) ?? '',
        rationale: (t['rationale'] as string) ?? '',
        done: (t['definition_of_done'] as string) ?? '',
      };
    }),
    dedupeTasks: mock.fn((tasks: unknown[]) => tasks),
    classifyPrompt: mock.fn(() => 'implementation'),
    generateSpec: mock.fn(() => 'spec content'),
  },
});

const {
  synthesizeCouncilTranscript,
  deriveCouncilRecommendation,
  extractDecisionOptions,
  extractAssumptions,
  extractAssumptionAttacks,
  extractFinalDecision,
  buildStepPrompt,
  resolveActiveAgents,
  computeAdversarialResumePoint,
  COUNCIL_DECISION_CRITERIA,
} = await import('../lib/hydra-council.ts');

// ── synthesizeCouncilTranscript — deep pipeline tests ────────────────────────

describe('synthesizeCouncilTranscript — pipeline paths', () => {
  it('handles multi-round transcript with all phases', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        round: 1,
        parsed: {
          view: 'Initial plan',
          risks: ['risk-1', 'risk-2'],
          recommended_tasks: [
            {
              owner: 'codex',
              title: 'Implement X',
              rationale: 'Core',
              definition_of_done: 'Tests',
            },
          ],
          questions: [{ to: 'human', question: 'What is the scope?' }],
          assumptions: [{ assumption: 'Node 20+', status: 'open' }],
          decision_options: [{ option: 'Plan A', summary: 'Go fast', preferred: true }],
          should_open_council: false,
        },
      },
      {
        agent: 'gemini',
        phase: 'critique',
        round: 1,
        parsed: {
          critique: 'Plan is incomplete',
          risks: ['risk-3'],
          edge_cases: ['edge-1'],
          sanity_checks: ['check-1'],
          assumption_attacks: [
            {
              assumption: 'Node 20+',
              challenge: 'CI uses Node 18',
              impact: 'high',
              by: 'gemini',
            },
          ],
          should_open_council: true,
          council_reason: 'Too many unknowns',
          questions: [{ to: 'claude', question: 'Have you checked CI?' }],
        },
      },
      {
        agent: 'claude',
        phase: 'refine',
        round: 1,
        parsed: {
          view: 'Refined plan',
          decision: {
            summary: 'Go with Plan A modified',
            why: 'Lower risk after fixes',
            owner: 'claude',
            confidence: 'medium',
            next_action: 'handoff',
            reversible_first_step: 'Create branch',
            tradeoffs: { correctness: 'Good', complexity: 'Medium' },
          },
          recommended_tasks: [
            {
              owner: 'gemini',
              title: 'Review changes',
              rationale: 'Quality',
              definition_of_done: 'Approved',
            },
          ],
        },
      },
      {
        agent: 'codex',
        phase: 'implement',
        round: 1,
        parsed: {
          consensus: 'Plan A modified is the way',
          task_allocations: [
            {
              owner: 'codex',
              title: 'Write code',
              rationale: 'Implementation',
              definition_of_done: 'Green tests',
            },
          ],
          disagreements: ['Minor disagreement on naming'],
          decision: {
            summary: 'Final consensus: Plan A modified',
            confidence: 'high',
            next_action: 'handoff',
          },
        },
      },
    ];

    const result = synthesizeCouncilTranscript('Fix the auth race', transcript);

    // Consensus comes from the last decision summary (extractFinalDecision)
    assert.equal(result.consensus, 'Final consensus: Plan A modified');
    assert.equal(result.prompt, 'Fix the auth race');
    assert.ok(result.tasks.length > 0);
    assert.ok(result.risks.length > 0);
    assert.ok(result.questions.length > 0);
    assert.ok(result.assumptions.length > 0);
    assert.ok(result.assumptionAttacks.length > 0);
    assert.ok(result.decisionOptions.length > 0);
    assert.ok(result.disagreements.length > 0);
    assert.ok(result.councilVotes.length > 0);
    assert.notStrictEqual(result.finalDecision, null);
    assert.equal(typeof result.recommendedMode, 'string');
    assert.equal(typeof result.recommendedNextAction, 'string');
    assert.ok(result.recommendationRationale.length > 0);
  });

  it('falls back to claude refine view when no codex entry', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'refine',
        round: 1,
        parsed: { view: 'Claude refined view' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'Claude refined view');
  });

  it('falls back to any claude view when no refine or codex', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        round: 1,
        parsed: { view: 'Claude propose view' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'Claude propose view');
  });

  it('produces default tasks when no tasks in transcript', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        round: 1,
        parsed: { view: 'A plan with no tasks' },
      },
    ];
    const result = synthesizeCouncilTranscript('Plan something', transcript);
    assert.ok(result.tasks.length > 0);
  });

  it('handles entries with rawText when parsed is null', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', parsed: null, rawText: 'raw text output' },
      {
        agent: 'codex',
        phase: 'implement',
        parsed: { consensus: 'Final answer' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'Final answer');
  });
});

// ── deriveCouncilRecommendation — edge cases ─────────────────────────────────

describe('deriveCouncilRecommendation — additional paths', () => {
  it('escalates on low confidence + risks', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      risks: ['r1'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates with many cross-agent questions', () => {
    const result = deriveCouncilRecommendation({
      questions: [{ to: 'gemini' }, { to: 'codex' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('handoff overridden to council when synthesis is weak', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'low' },
      disagreements: ['a', 'b'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('handoff with high confidence and no issues stays handoff', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'high' },
    });
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
  });

  it('handoff when many risks (>= 6) overrides to council', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'medium' },
      risks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('no explicit nextAction defaults based on escalation logic', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'high' },
    });
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
  });
});

// ── buildStepPrompt — additional phase coverage ──────────────────────────────

describe('buildStepPrompt — all phases', () => {
  it('builds propose phase prompt', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'propose', promptLabel: 'Propose plan' },
      'Fix auth',
      [],
      1,
      2,
    );
    assert.match(result, /round 1\/2/);
    assert.match(result, /phase: propose/);
    assert.match(result, /surface distinct options/);
  });

  it('builds critique phase prompt with attack instruction', () => {
    const result = buildStepPrompt(
      { agent: 'gemini', phase: 'critique', promptLabel: 'Review critically' },
      'Fix auth',
      [],
      1,
      2,
    );
    assert.match(result, /attack the strongest assumption/);
  });

  it('builds refine phase prompt with decision focus', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'refine', promptLabel: 'Refine plan' },
      'Fix auth',
      [],
      1,
      2,
    );
    assert.match(result, /resolve critique into a single decision/);
  });

  it('builds implement phase prompt with synthesizer focus', () => {
    const result = buildStepPrompt(
      { agent: 'codex', phase: 'implement', promptLabel: 'Implement' },
      'Fix auth',
      [],
      1,
      2,
    );
    assert.match(result, /act as the final synthesizer/);
  });

  it('builds prompt for unknown phase with default focus', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'advise', promptLabel: 'Advise' },
      'Fix auth',
      [],
      1,
      2,
    );
    // Unknown phase gets the default propose-like focus
    assert.match(result, /surface distinct options/);
  });

  it('includes transcript context when provided', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', round: 1, parsed: { view: 'A plan' } },
      { agent: 'gemini', phase: 'critique', round: 1, parsed: { critique: 'Issues found' } },
    ];
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'refine', promptLabel: 'Refine' },
      'Fix auth',
      transcript,
      1,
      2,
    );
    assert.match(result, /CLAUDE/);
    assert.match(result, /GEMINI/);
  });
});

// ── resolveActiveAgents ──────────────────────────────────────────────────────

describe('resolveActiveAgents — additional', () => {
  it('returns empty array when filter excludes all defaults', () => {
    const result = resolveActiveAgents(['unknown']);
    assert.deepEqual(result, []);
  });

  it('preserves order even with single agent', () => {
    assert.deepEqual(resolveActiveAgents(['gemini']), ['gemini']);
  });
});

// ── computeAdversarialResumePoint — additional ───────────────────────────────

describe('computeAdversarialResumePoint — edge cases', () => {
  it('handles NaN round by defaulting to 1', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: Number.NaN }]);
    assert.equal(result.startRound, 1);
    assert.equal(result.startPhaseIdx, 1);
  });

  it('handles multiple rounds', () => {
    const result = computeAdversarialResumePoint([
      { phase: 'diverge', round: 1 },
      { phase: 'attack', round: 1 },
      { phase: 'synthesize', round: 1 },
      { phase: 'diverge', round: 2 },
    ]);
    assert.equal(result.startRound, 2);
    assert.equal(result.startPhaseIdx, 1);
  });
});

// ── extractDecisionOptions — additional merging ──────────────────────────────

describe('extractDecisionOptions — merge behavior', () => {
  it('merges truthy values from duplicate entries', () => {
    const parsed = {
      decision_options: [
        { option: 'X', summary: 'desc', preferred: false },
        { option: 'X', summary: 'desc', preferred: true, tradeoffs: { correctness: 'High' } },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['preferred'], true);
    assert.ok(first['tradeoffs']);
  });

  it('normalizes tradeoffs with camelCase keys', () => {
    const parsed = {
      decision_options: [
        {
          option: 'A',
          summary: 'test',
          tradeoffs: { userImpact: 'High' },
        },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    const tradeoffs = first['tradeoffs'] as Record<string, string>;
    assert.equal(tradeoffs['user_impact'], 'High');
  });
});

// ── extractAssumptions — additional normalization ────────────────────────────

describe('extractAssumptions — additional', () => {
  it('extracts using question field as assumption name fallback', () => {
    const parsed = {
      assumptions: [{ question: 'Is the API stable?', status: 'open' }],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'Is the API stable?');
  });

  it('extracts using summary field as fallback', () => {
    const parsed = {
      assumptions: [{ summary: 'Summary text', status: 'validated' }],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });

  it('handles empty string assumptions', () => {
    const parsed = { assumptions: ['', '  '] };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 0);
  });
});

// ── extractFinalDecision — additional paths ──────────────────────────────────

describe('extractFinalDecision — deeper extraction', () => {
  it('normalizes ship as handoff', () => {
    const parsed = { decision: { summary: 'Ship it', next_action: 'ship' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.nextAction, 'handoff');
  });

  it('normalizes deeper_council as council', () => {
    const parsed = { decision: { summary: 'Need more', next_action: 'deeper_council' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.nextAction, 'council');
  });

  it('normalizes ask_human as human_decision', () => {
    const parsed = { decision: { summary: 'Ask', next_action: 'ask_human' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.nextAction, 'human_decision');
  });

  it('handles top-level view fallback', () => {
    const parsed = { view: 'Top-level view text' };
    const result = extractFinalDecision(parsed);
    assert.notStrictEqual(result, null);
    assert.equal(result!.summary, 'Top-level view text');
  });

  it('handles decision_rationale at top level', () => {
    const parsed = { decision: { summary: 'Do X' }, decision_rationale: 'Because Y' };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.why, 'Because Y');
  });

  it('uses fallback agent for owner when provided', () => {
    const parsed = { decision: { summary: 'Do X', owner: 'codex' } };
    const result = extractFinalDecision(parsed, { agent: 'gemini' });
    assert.equal(result!.owner, 'gemini');
  });

  it('uses owner from decision when no fallback agent', () => {
    const parsed = { decision: { summary: 'Do X', owner: 'codex' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.owner, 'codex');
  });

  it('extracts reversibleFirstStep from camelCase', () => {
    const parsed = {
      decision: { summary: 'X', reversibleFirstStep: 'Create a branch' },
    };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.reversibleFirstStep, 'Create a branch');
  });
});

// ── extractAssumptionAttacks — additional ────────────────────────────────────

describe('extractAssumptionAttacks — additional', () => {
  it('extracts text field as challenge', () => {
    const parsed = {
      assumption_attacks: [{ text: 'This is flawed' }],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'This is flawed');
  });

  it('deduplicates attacks by assumption|challenge key', () => {
    const parsed = {
      assumption_attacks: [
        { assumption: 'A', challenge: 'B' },
        { assumption: 'A', challenge: 'B', impact: 'high' },
      ],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['impact'], 'high'); // merged truthy
  });
});

// ── COUNCIL_DECISION_CRITERIA ────────────────────────────────────────────────

describe('COUNCIL_DECISION_CRITERIA structure', () => {
  it('has exactly 4 criteria', () => {
    assert.equal(COUNCIL_DECISION_CRITERIA.length, 4);
  });

  it('all criteria have key and label', () => {
    for (const c of COUNCIL_DECISION_CRITERIA) {
      assert.ok(c.key.length > 0);
      assert.ok(c.label.length > 0);
    }
  });
});
