import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStepPrompt,
  deriveCouncilRecommendation,
  synthesizeCouncilTranscript,
  extractAssumptionAttacks,
  extractDecisionOptions,
  extractAssumptions,
  extractFinalDecision,
  resolveActiveAgents,
  computeAdversarialResumePoint,
  COUNCIL_DECISION_CRITERIA,
} from '../lib/hydra-council.ts';

interface StepConfig {
  agent: string;
  phase: string;
  promptLabel: string;
}

interface TranscriptEntry {
  agent: string;
  phase: string;
  parsed?: Record<string, unknown>;
  round?: number;
}

test('buildStepPrompt adds structured convergence instructions', () => {
  const stepConfig: StepConfig = {
    agent: 'gemini',
    phase: 'critique',
    promptLabel:
      'Review this plan critically. Identify risks, edge cases, missed files, and regressions. Cite specific code.',
  };
  const prompt = buildStepPrompt(stepConfig, 'Redesign the task routing system', [], 1, 2);

  assert.match(prompt, /Decision criteria for convergence:/);
  assert.match(prompt, /Do not use majority vote/i);
  assert.match(prompt, /attack the strongest assumption/i);
  assert.match(prompt, /decision_options/);
  assert.match(prompt, /assumption_attacks/);
});

test('synthesizeCouncilTranscript follows final synthesis over positive council votes', () => {
  const transcript: TranscriptEntry[] = [
    {
      agent: 'claude',
      phase: 'propose',
      parsed: {
        view: 'Two viable rollout shapes exist.',
        should_open_council: true,
        council_reason: 'Need more critique before converging.',
        decision_options: [
          {
            option: 'feature_flag',
            summary: 'Ship a reversible rollout behind a flag.',
            preferred: true,
            tradeoffs: {
              correctness: 'Safe if guarded by existing checks.',
              complexity: 'Moderate.',
              reversibility: 'High.',
              user_impact: 'Contained blast radius.',
            },
          },
        ],
        assumptions: [
          {
            assumption: 'Existing checks are sufficient for a flagged rollout.',
            status: 'validated',
            evidence: 'Covered by integration tests.',
            owner: 'claude',
          },
        ],
      },
    },
    {
      agent: 'gemini',
      phase: 'critique',
      parsed: {
        critique: 'The leading option is acceptable if rollout remains reversible.',
        should_open_council: true,
        council_reason: 'Pressure-test the implementation details.',
        assumption_attacks: [
          {
            assumption: 'Feature flags are wired everywhere.',
            challenge: 'Audit the API edge before rollout.',
            impact: 'Missed edge could leak behavior.',
            by: 'gemini',
          },
        ],
      },
    },
    {
      agent: 'codex',
      phase: 'implement',
      parsed: {
        consensus: 'Use the feature-flag rollout.',
        should_open_council: true,
        council_reason: 'Earlier phases requested more analysis.',
        decision: {
          summary: 'Use the feature-flag rollout.',
          why: 'It satisfies correctness while keeping rollback trivial.',
          owner: 'codex',
          confidence: 'high',
          next_action: 'handoff',
          reversible_first_step: 'Implement the flag gate and ship dark.',
          tradeoffs: {
            correctness: 'Preserves current behavior until enabled.',
            complexity: 'Adds one controlled branch.',
            reversibility: 'Flag can be disabled immediately.',
            user_impact: 'No visible impact until enabled.',
          },
        },
        assumptions: [
          {
            assumption: 'Feature flags are wired everywhere.',
            status: 'validated',
            evidence: 'Audit complete.',
            owner: 'codex',
          },
        ],
        task_allocations: [
          {
            owner: 'codex',
            title: 'Add feature flag gate to routing path',
            rationale: 'Enable a reversible rollout',
            definition_of_done: 'Flag defaults off and integration tests cover the gate.',
          },
        ],
      },
    },
  ];

  const report = synthesizeCouncilTranscript('Redesign the task routing system', transcript);

  assert.equal(report.recommendedMode, 'handoff');
  assert.equal(report.recommendedNextAction, 'handoff');
  assert.equal((report.finalDecision as Record<string, unknown>)?.['owner'], 'codex');
  assert.equal(
    (report.finalDecision as Record<string, unknown>)?.['reversibleFirstStep'],
    'Implement the flag gate and ship dark.',
  );
  assert.match(report.recommendationRationale, /decision_next_action=handoff/);
  assert.equal(
    report.councilVotes.filter((item) => (item as Record<string, unknown>)['vote']).length,
    3,
  );
  assert.equal((report.tasks as Record<string, unknown>[])[0]['owner'], 'codex');
});

test('deriveCouncilRecommendation keeps council open for human decisions', () => {
  const recommendation = deriveCouncilRecommendation({
    finalDecision: {
      owner: 'codex',
      confidence: 'medium',
      nextAction: 'human_decision',
    },
    assumptions: [],
    questions: [
      { to: 'human', question: 'Which product tradeoff matters more?' } as { to: string },
    ],
    risks: [],
    disagreements: [],
    councilVotes: [],
  });

  assert.equal(recommendation.recommendedMode, 'council');
  assert.equal(recommendation.nextAction, 'human_decision');
  assert.match(recommendation.rationale, /human_questions=1/);
});

// ─── Adversarial: ATTACK schema tests ───────────────────────────────────────

test('extractAssumptionAttacks maps attack_vector/target_agent (new schema)', () => {
  const parsed: Record<string, unknown> = {
    assumption_attacks: [
      {
        attack_vector: 'The cache never invalidates under concurrent writes',
        target_agent: 'claude',
        impact: 'data loss',
        by: 'gemini',
      },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal(
    (attacks[0] as Record<string, unknown>)['challenge'],
    'The cache never invalidates under concurrent writes',
  );
  assert.equal((attacks[0] as Record<string, unknown>)['assumption'], 'claude');
});

test('extractAssumptionAttacks backward-compat with challenge/target (old schema)', () => {
  const parsed: Record<string, unknown> = {
    assumption_attacks: [
      {
        challenge: 'The lock is not held across retries',
        target: 'gemini',
        impact: 'race',
        by: 'codex',
      },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal(
    (attacks[0] as Record<string, unknown>)['challenge'],
    'The lock is not held across retries',
  );
  assert.equal((attacks[0] as Record<string, unknown>)['assumption'], 'gemini');
});

test('extractAssumptionAttacks prefers attack_vector over challenge when both present', () => {
  const parsed: Record<string, unknown> = {
    assumption_attacks: [
      {
        attack_vector: 'primary attack',
        challenge: 'old field',
        target_agent: 'codex',
        target: 'claude',
      },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal((attacks[0] as Record<string, unknown>)['challenge'], 'primary attack');
  assert.equal((attacks[0] as Record<string, unknown>)['assumption'], 'codex');
});

// ─── Adversarial: resolveActiveAgents ───────────────────────────────────────

test('resolveActiveAgents returns defaults when no filter given', () => {
  const agents = resolveActiveAgents(null);
  assert.deepEqual(agents, ['claude', 'gemini', 'codex']);
});

test('resolveActiveAgents filters to single agent preserving order', () => {
  const agents = resolveActiveAgents(['claude']);
  assert.deepEqual(agents, ['claude']);
});

test('resolveActiveAgents filters to subset preserving default order', () => {
  const agents = resolveActiveAgents(['codex', 'claude']); // input order shouldn't matter
  assert.deepEqual(agents, ['claude', 'codex']); // default order preserved
});

test('resolveActiveAgents returns empty array for unknown agents', () => {
  const agents = resolveActiveAgents(['unknown']);
  assert.deepEqual(agents, []);
});

// ─── Adversarial: computeAdversarialResumePoint ──────────────────────────────

test('computeAdversarialResumePoint returns round 1, phase 0 for empty transcript', () => {
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint([]);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 0);
});

test('computeAdversarialResumePoint advances to next phase within same round', () => {
  const transcript: Array<{ round: number; agent: string; phase: string }> = [
    { round: 1, agent: 'claude', phase: 'diverge' },
  ];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 1); // next = attack
});

test('computeAdversarialResumePoint advances to next round after synthesize', () => {
  const transcript: Array<{ round: number; agent: string; phase: string }> = [
    { round: 1, agent: 'claude', phase: 'diverge' },
    { round: 1, agent: 'claude', phase: 'attack' },
    { round: 1, agent: 'claude', phase: 'synthesize' },
  ];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 2);
  assert.equal(startPhaseIdx, 0); // next = diverge in round 2
});

test('computeAdversarialResumePoint returns Infinity when implement already done', () => {
  const transcript: Array<{ round: number; agent: string; phase: string }> = [
    { round: 1, agent: 'claude', phase: 'synthesize' },
    { round: 1, agent: 'codex', phase: 'implement' },
  ];
  const { startRound } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, Infinity);
});

// ── COUNCIL_DECISION_CRITERIA ────────────────────────────────────────────────

test('COUNCIL_DECISION_CRITERIA contains all four criteria', () => {
  assert.equal(COUNCIL_DECISION_CRITERIA.length, 4);
  const keys = COUNCIL_DECISION_CRITERIA.map((c) => c.key);
  assert.ok(keys.includes('correctness'));
  assert.ok(keys.includes('complexity'));
  assert.ok(keys.includes('reversibility'));
  assert.ok(keys.includes('user_impact'));
});

test('COUNCIL_DECISION_CRITERIA entries have both key and label', () => {
  for (const criterion of COUNCIL_DECISION_CRITERIA) {
    assert.ok(typeof criterion.key === 'string' && criterion.key.length > 0);
    assert.ok(typeof criterion.label === 'string' && criterion.label.length > 0);
  }
});

// ── extractDecisionOptions ───────────────────────────────────────────────────

test('extractDecisionOptions returns empty for null/undefined', () => {
  assert.deepEqual(extractDecisionOptions(null), []);
  assert.deepEqual(extractDecisionOptions(undefined), []);
  assert.deepEqual(extractDecisionOptions('not an object'), []);
});

test('extractDecisionOptions extracts from decision_options key', () => {
  const parsed = {
    decision_options: [
      {
        option: 'feature_flag',
        summary: 'Ship behind a flag',
        preferred: true,
        tradeoffs: { correctness: 'Good', complexity: 'Low' },
      },
    ],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal(options.length, 1);
  assert.equal((options[0] as Record<string, unknown>)['option'], 'feature_flag');
  assert.equal((options[0] as Record<string, unknown>)['preferred'], true);
});

test('extractDecisionOptions extracts from options key', () => {
  const parsed = {
    options: [{ option: 'rollback', summary: 'Roll back the change' }],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal(options.length, 1);
  assert.equal((options[0] as Record<string, unknown>)['option'], 'rollback');
});

test('extractDecisionOptions extracts from candidate_options key', () => {
  const parsed = {
    candidate_options: [{ name: 'opt_a', description: 'First option' }],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal(options.length, 1);
  assert.equal((options[0] as Record<string, unknown>)['option'], 'opt_a');
  assert.equal((options[0] as Record<string, unknown>)['summary'], 'First option');
});

test('extractDecisionOptions skips null/empty items', () => {
  const parsed = {
    decision_options: [null, {}, { option: 'valid', summary: 'ok' }],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal(options.length, 1);
});

test('extractDecisionOptions deduplicates by option+summary', () => {
  const parsed = {
    decision_options: [
      { option: 'flag', summary: 'Ship behind a flag' },
      { option: 'flag', summary: 'Ship behind a flag' },
    ],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal(options.length, 1);
});

test('extractDecisionOptions assigns default option name for empty option', () => {
  const parsed = {
    decision_options: [{ summary: 'Some approach' }],
  };
  const options = extractDecisionOptions(parsed);
  assert.equal((options[0] as Record<string, unknown>)['option'], 'option_1');
});

test('extractDecisionOptions normalizes tradeoffs with camelCase keys', () => {
  const parsed = {
    decision_options: [
      {
        option: 'test',
        summary: 'test',
        tradeoffs: { correctness: 'High', userImpact: 'Low' },
      },
    ],
  };
  const options = extractDecisionOptions(parsed);
  const tradeoffs = (options[0] as Record<string, unknown>)['tradeoffs'] as Record<string, string>;
  assert.equal(tradeoffs['correctness'], 'High');
  assert.equal(tradeoffs['user_impact'], 'Low');
});

// ── extractAssumptions ───────────────────────────────────────────────────────

test('extractAssumptions returns empty for null/undefined', () => {
  assert.deepEqual(extractAssumptions(null), []);
  assert.deepEqual(extractAssumptions(undefined), []);
});

test('extractAssumptions extracts from assumptions key', () => {
  const parsed = {
    assumptions: [
      { assumption: 'API is stable', status: 'validated', evidence: 'Tests pass', owner: 'claude' },
    ],
  };
  const assumptions = extractAssumptions(parsed);
  assert.equal(assumptions.length, 1);
  assert.equal((assumptions[0] as Record<string, unknown>)['assumption'], 'API is stable');
  assert.equal((assumptions[0] as Record<string, unknown>)['status'], 'validated');
});

test('extractAssumptions extracts from open_assumptions key', () => {
  const parsed = {
    open_assumptions: [{ assumption: 'Cache is warm' }],
  };
  const result = extractAssumptions(parsed);
  assert.equal(result.length, 1);
  assert.equal((result[0] as Record<string, unknown>)['status'], 'open');
});

test('extractAssumptions extracts from key_assumptions key', () => {
  const parsed = {
    key_assumptions: [{ name: 'DB handles load', impact: 'critical' }],
  };
  const result = extractAssumptions(parsed);
  assert.equal(result.length, 1);
  assert.equal((result[0] as Record<string, unknown>)['assumption'], 'DB handles load');
});

test('extractAssumptions handles string items as assumptions', () => {
  const parsed = {
    assumptions: ['The auth flow is correct', 'Rate limits are configured'],
  };
  const result = extractAssumptions(parsed);
  assert.equal(result.length, 2);
  assert.equal((result[0] as Record<string, unknown>)['assumption'], 'The auth flow is correct');
  assert.equal((result[0] as Record<string, unknown>)['status'], 'open');
  assert.equal((result[0] as Record<string, unknown>)['owner'], 'unassigned');
});

test('extractAssumptions normalizes invalid status to open', () => {
  const parsed = {
    assumptions: [{ assumption: 'test', status: 'invalid_status' }],
  };
  const result = extractAssumptions(parsed);
  assert.equal((result[0] as Record<string, unknown>)['status'], 'open');
});

test('extractAssumptions deduplicates by assumption text', () => {
  const parsed = {
    assumptions: [
      { assumption: 'same thing', status: 'open' },
      { assumption: 'same thing', status: 'validated', evidence: 'proven' },
    ],
  };
  const result = extractAssumptions(parsed);
  assert.equal(result.length, 1);
  // The merged result should have the validated evidence
  assert.equal((result[0] as Record<string, unknown>)['evidence'], 'proven');
});

// ── extractAssumptionAttacks extended ────────────────────────────────────────

test('extractAssumptionAttacks returns empty for null/undefined', () => {
  assert.deepEqual(extractAssumptionAttacks(null), []);
  assert.deepEqual(extractAssumptionAttacks(undefined), []);
});

test('extractAssumptionAttacks extracts from assumption_challenges key', () => {
  const parsed = {
    assumption_challenges: [
      { challenge: 'Race condition possible', target: 'gemini', impact: 'data loss' },
    ],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal((attacks[0] as Record<string, unknown>)['challenge'], 'Race condition possible');
});

test('extractAssumptionAttacks extracts from counterarguments key', () => {
  const parsed = {
    counterarguments: [{ critique: 'Performance concern', target_agent: 'codex', by: 'claude' }],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal((attacks[0] as Record<string, unknown>)['challenge'], 'Performance concern');
  assert.equal((attacks[0] as Record<string, unknown>)['assumption'], 'codex');
});

test('extractAssumptionAttacks handles string items', () => {
  const parsed = {
    assumption_attacks: ['This approach ignores caching'],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 1);
  assert.equal(
    (attacks[0] as Record<string, unknown>)['challenge'],
    'This approach ignores caching',
  );
});

test('extractAssumptionAttacks skips empty items', () => {
  const parsed = {
    assumption_attacks: [null, {}, { challenge: '', assumption: '' }],
  };
  const attacks = extractAssumptionAttacks(parsed);
  assert.equal(attacks.length, 0);
});

// ── extractFinalDecision ─────────────────────────────────────────────────────

test('extractFinalDecision returns null for null/undefined', () => {
  assert.equal(extractFinalDecision(null), null);
  assert.equal(extractFinalDecision(undefined), null);
  assert.equal(extractFinalDecision('string'), null);
});

test('extractFinalDecision returns null when no meaningful decision fields', () => {
  assert.equal(extractFinalDecision({}), null);
  assert.equal(extractFinalDecision({ unrelated: 'data' }), null);
});

test('extractFinalDecision extracts decision from nested decision object', () => {
  const parsed = {
    decision: {
      summary: 'Use feature flags',
      why: 'Reversible approach',
      owner: 'codex',
      confidence: 'high',
      next_action: 'handoff',
      reversible_first_step: 'Add flag gate',
      tradeoffs: { correctness: 'Good', complexity: 'Low' },
    },
  };
  const result = extractFinalDecision(parsed);
  assert.ok(result !== null);
  assert.equal(result.summary, 'Use feature flags');
  assert.equal(result.why, 'Reversible approach');
  assert.equal(result.confidence, 'high');
  assert.equal(result.nextAction, 'handoff');
  assert.equal(result.reversibleFirstStep, 'Add flag gate');
  assert.ok(result.tradeoffs !== null);
  assert.equal(result.tradeoffs['correctness'], 'Good');
});

test('extractFinalDecision uses fallback agent for owner', () => {
  const parsed = {
    decision: { summary: 'test', owner: 'gemini' },
  };
  const result = extractFinalDecision(parsed, { agent: 'claude', phase: 'refine' });
  assert.ok(result !== null);
  assert.equal(result.owner, 'claude');
  assert.equal(result.sourceAgent, 'claude');
  assert.equal(result.sourcePhase, 'refine');
});

test('extractFinalDecision extracts from top-level consensus/view', () => {
  const parsed = {
    consensus: 'Ship the feature',
    confidence: 'medium',
  };
  const result = extractFinalDecision(parsed);
  assert.ok(result !== null);
  assert.equal(result.summary, 'Ship the feature');
  assert.equal(result.confidence, 'medium');
});

test('extractFinalDecision normalizes next_action values', () => {
  const handoff = extractFinalDecision({ decision: { summary: 'x', next_action: 'delegate' } });
  assert.equal(handoff!.nextAction, 'handoff');

  const council = extractFinalDecision({
    decision: { summary: 'x', next_action: 'deeper_council' },
  });
  assert.equal(council!.nextAction, 'council');

  const human = extractFinalDecision({
    decision: { summary: 'x', next_action: 'ask_human' },
  });
  assert.equal(human!.nextAction, 'human_decision');
});

test('extractFinalDecision normalizes confidence values', () => {
  const low = extractFinalDecision({ decision: { summary: 'x', confidence: 'LOW' } });
  assert.equal(low!.confidence, 'low');

  const invalid = extractFinalDecision({ decision: { summary: 'x', confidence: 'maybe' } });
  assert.equal(invalid!.confidence, '');
});

// ── deriveCouncilRecommendation extended ──────────────────────────────────────

test('deriveCouncilRecommendation defaults to handoff with no inputs', () => {
  const rec = deriveCouncilRecommendation({});
  assert.equal(rec.recommendedMode, 'handoff');
  assert.equal(rec.nextAction, 'handoff');
});

test('deriveCouncilRecommendation escalates to council with many risks', () => {
  const rec = deriveCouncilRecommendation({
    risks: ['r1', 'r2', 'r3', 'r4'],
    finalDecision: { confidence: 'medium' },
  });
  assert.equal(rec.recommendedMode, 'council');
});

test('deriveCouncilRecommendation escalates for disagreements', () => {
  const rec = deriveCouncilRecommendation({
    disagreements: ['agents disagree'],
  });
  assert.equal(rec.recommendedMode, 'council');
});

test('deriveCouncilRecommendation escalates for low confidence with open assumptions', () => {
  const rec = deriveCouncilRecommendation({
    finalDecision: { confidence: 'low' },
    assumptions: [{ status: 'open' }],
  });
  assert.equal(rec.recommendedMode, 'council');
});

test('deriveCouncilRecommendation respects explicit handoff next_action', () => {
  const rec = deriveCouncilRecommendation({
    finalDecision: { nextAction: 'handoff', confidence: 'high' },
    risks: [],
    disagreements: [],
  });
  assert.equal(rec.recommendedMode, 'handoff');
  assert.equal(rec.nextAction, 'handoff');
});

test('deriveCouncilRecommendation overrides handoff when synthesis is weak', () => {
  const rec = deriveCouncilRecommendation({
    finalDecision: { nextAction: 'handoff', confidence: 'low' },
    disagreements: ['d1', 'd2'],
  });
  assert.equal(rec.recommendedMode, 'council');
});

test('deriveCouncilRecommendation escalates with cross-agent questions > 1', () => {
  const rec = deriveCouncilRecommendation({
    questions: [{ to: 'gemini' }, { to: 'codex' }],
  });
  assert.equal(rec.recommendedMode, 'council');
});

test('deriveCouncilRecommendation includes rationale with all fields', () => {
  const rec = deriveCouncilRecommendation({
    finalDecision: { owner: 'claude', confidence: 'high', nextAction: 'handoff' },
    assumptions: [{ status: 'validated' }],
    questions: [{ to: 'human' }],
    risks: ['risk1'],
    councilVotes: [{ vote: true }],
  });
  assert.ok(rec.rationale.includes('decision_owner=claude'));
  assert.ok(rec.rationale.includes('decision_confidence=high'));
  assert.ok(rec.rationale.includes('human_questions=1'));
  assert.ok(rec.rationale.includes('risk_items=1'));
});

test('deriveCouncilRecommendation escalates for positive council signals with risks', () => {
  const rec = deriveCouncilRecommendation({
    councilVotes: [{ vote: true }],
    risks: ['a risk'],
  });
  assert.equal(rec.recommendedMode, 'council');
});

// ── synthesizeCouncilTranscript extended ──────────────────────────────────────

test('synthesizeCouncilTranscript with empty transcript returns defaults', () => {
  const report = synthesizeCouncilTranscript('test prompt', []);
  assert.equal(report.prompt, 'test prompt');
  assert.ok(report.tasks.length > 0, 'Should generate default tasks');
  assert.equal(report.consensus, '');
  assert.equal(report.recommendedMode, 'handoff');
});

test('synthesizeCouncilTranscript deduplicates risks and disagreements', () => {
  const transcript = [
    {
      agent: 'claude',
      phase: 'propose',
      parsed: {
        view: 'Plan A',
        risks: ['same risk', 'same risk', 'unique risk'],
        disagreements: ['conflict', 'conflict'],
      },
    },
  ];
  const report = synthesizeCouncilTranscript('test', transcript);
  assert.equal(report.risks.length, 2); // 'same risk' + 'unique risk'
  assert.equal(report.disagreements.length, 1);
});

test('synthesizeCouncilTranscript accumulates questions across entries', () => {
  const transcript = [
    {
      agent: 'claude',
      phase: 'propose',
      parsed: {
        view: 'approach',
        questions: [{ to: 'human', question: 'Which priority?' }],
      },
    },
    {
      agent: 'gemini',
      phase: 'critique',
      parsed: {
        critique: 'concerns',
        questions: [{ to: 'codex', question: 'How to implement?' }],
      },
    },
  ];
  const report = synthesizeCouncilTranscript('test', transcript);
  assert.equal(report.questions.length, 2);
});

test('synthesizeCouncilTranscript uses consensus from last codex entry', () => {
  const transcript = [
    {
      agent: 'claude',
      phase: 'propose',
      parsed: { view: 'Claude view' },
    },
    {
      agent: 'codex',
      phase: 'implement',
      parsed: { consensus: 'Codex consensus view' },
    },
  ];
  const report = synthesizeCouncilTranscript('test', transcript);
  assert.equal(report.consensus, 'Codex consensus view');
});

// ── buildStepPrompt extended ─────────────────────────────────────────────────

test('buildStepPrompt includes phase-specific schema instructions', () => {
  const proposePrompt = buildStepPrompt(
    { agent: 'claude', phase: 'propose', promptLabel: 'Analyze this.' },
    'Test objective',
    [],
    1,
    2,
  );
  assert.ok(proposePrompt.includes('"view"'));
  assert.ok(proposePrompt.includes('recommended_tasks'));
});

test('buildStepPrompt includes spec content when provided', () => {
  const prompt = buildStepPrompt(
    { agent: 'claude', phase: 'propose', promptLabel: 'Test' },
    'Objective',
    [],
    1,
    1,
    'Spec: Must support Node 24+',
  );
  assert.ok(prompt.includes('Must support Node 24+'));
  assert.ok(prompt.includes('Anchoring Specification'));
});

test('buildStepPrompt excludes spec section when null', () => {
  const prompt = buildStepPrompt(
    { agent: 'claude', phase: 'propose', promptLabel: 'Test' },
    'Objective',
    [],
    1,
    1,
    null,
  );
  assert.ok(!prompt.includes('Anchoring Specification'));
});

test('buildStepPrompt includes round info and phase', () => {
  const prompt = buildStepPrompt(
    { agent: 'gemini', phase: 'critique', promptLabel: 'Review critically.' },
    'Test',
    [],
    2,
    3,
  );
  assert.ok(prompt.includes('round 2/3'));
  assert.ok(prompt.includes('phase: critique'));
});

test('buildStepPrompt includes context summary from transcript', () => {
  const transcript = [
    { agent: 'claude', phase: 'propose', round: 1, parsed: { view: 'My proposal' } },
  ];
  const prompt = buildStepPrompt(
    { agent: 'gemini', phase: 'critique', promptLabel: 'Review.' },
    'Test',
    transcript,
    1,
    2,
  );
  assert.ok(prompt.includes('CLAUDE'));
  assert.ok(prompt.includes('My proposal'));
});

test('buildStepPrompt includes focus instruction for critique phase', () => {
  const prompt = buildStepPrompt(
    { agent: 'gemini', phase: 'critique', promptLabel: 'Review.' },
    'Test',
    [],
    1,
    1,
  );
  assert.ok(prompt.includes('attack the strongest assumption'));
});

test('buildStepPrompt includes focus instruction for implement phase', () => {
  const prompt = buildStepPrompt(
    { agent: 'codex', phase: 'implement', promptLabel: 'Implement.' },
    'Test',
    [],
    1,
    1,
  );
  assert.ok(prompt.includes('final synthesizer'));
});

test('buildStepPrompt includes decision criteria instruction', () => {
  const prompt = buildStepPrompt(
    { agent: 'claude', phase: 'refine', promptLabel: 'Refine.' },
    'Test',
    [],
    1,
    1,
  );
  assert.ok(prompt.includes('Correctness'));
  assert.ok(prompt.includes('Reversibility'));
});

// ── resolveActiveAgents extended ─────────────────────────────────────────────

test('resolveActiveAgents with empty array returns defaults', () => {
  const agents = resolveActiveAgents([]);
  assert.deepEqual(agents, ['claude', 'gemini', 'codex']);
});

test('resolveActiveAgents preserves default order regardless of input order', () => {
  const agents = resolveActiveAgents(['gemini', 'codex', 'claude']);
  assert.deepEqual(agents, ['claude', 'gemini', 'codex']);
});

test('resolveActiveAgents with custom defaults', () => {
  const agents = resolveActiveAgents(null, ['alpha', 'beta', 'gamma']);
  assert.deepEqual(agents, ['alpha', 'beta', 'gamma']);
});

test('resolveActiveAgents filters custom defaults', () => {
  const agents = resolveActiveAgents(['beta'], ['alpha', 'beta', 'gamma']);
  assert.deepEqual(agents, ['beta']);
});

// ── computeAdversarialResumePoint extended ───────────────────────────────────

test('computeAdversarialResumePoint handles attack phase mid-round', () => {
  const transcript = [
    { round: 1, agent: 'claude', phase: 'diverge' },
    { round: 1, agent: 'gemini', phase: 'attack' },
  ];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 2); // next = synthesize
});

test('computeAdversarialResumePoint with unknown phase advances round', () => {
  const transcript = [{ round: 2, agent: 'claude', phase: 'unknown_phase' }];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  // Unknown phase has index -1, which triggers round advance
  assert.equal(startRound, 3);
  assert.equal(startPhaseIdx, 0);
});

test('computeAdversarialResumePoint handles round 0 as round 1', () => {
  const transcript = [{ round: 0, agent: 'claude', phase: 'diverge' }];
  const { startRound, startPhaseIdx } = computeAdversarialResumePoint(transcript);
  assert.equal(startRound, 1);
  assert.equal(startPhaseIdx, 1);
});
