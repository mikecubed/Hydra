/**
 * Coverage tests for lib/hydra-council.ts — pure extraction and synthesis functions.
 *
 * Focuses on exported functions that operate on structured data without network calls.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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
} from '../lib/hydra-council.ts';

// ── extractDecisionOptions ───────────────────────────────────────────────────

describe('extractDecisionOptions', () => {
  it('returns empty array for null/undefined input', () => {
    assert.deepStrictEqual(extractDecisionOptions(null), []);
    assert.deepStrictEqual(extractDecisionOptions(), []);
  });

  it('returns empty array for non-object input', () => {
    assert.deepStrictEqual(extractDecisionOptions('string'), []);
    assert.deepStrictEqual(extractDecisionOptions(42), []);
  });

  it('returns empty array when no known bucket keys are present', () => {
    assert.deepStrictEqual(extractDecisionOptions({ foo: 'bar' }), []);
  });

  it('extracts from decision_options key', () => {
    const parsed = {
      decision_options: [
        {
          option: 'Option A',
          summary: 'Use approach A',
          preferred: true,
          tradeoffs: { correctness: 'High', complexity: 'Low' },
        },
        { option: 'Option B', summary: 'Use approach B', preferred: false },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 2);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'Option A');
    assert.equal(first['preferred'], true);
  });

  it('extracts from options key', () => {
    const parsed = {
      options: [{ name: 'Foo', description: 'Do foo' }],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'Foo');
    assert.equal(first['summary'], 'Do foo');
  });

  it('extracts from candidate_options key', () => {
    const parsed = {
      candidate_options: [{ title: 'Bar', view: 'Use bar approach' }],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('deduplicates options with same option|summary', () => {
    const parsed = {
      decision_options: [
        { option: 'X', summary: 'desc' },
        { option: 'X', summary: 'desc', preferred: true },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    // mergeTruthy should keep preferred=true from the update
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['preferred'], true);
  });

  it('skips null items in the bucket', () => {
    const parsed = {
      decision_options: [null, undefined, { option: 'Valid', summary: 'OK' }],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
  });

  it('assigns fallback option name for items without option/name/title', () => {
    const parsed = {
      decision_options: [{ summary: 'description only' }],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['option'], 'option_1');
  });

  it('skips items with no option, summary, or tradeoffs', () => {
    const parsed = {
      decision_options: [{ irrelevant: true }],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 0);
  });
});

// ── extractAssumptions ───────────────────────────────────────────────────────

describe('extractAssumptions', () => {
  it('returns empty array for null/undefined', () => {
    assert.deepStrictEqual(extractAssumptions(null), []);
    assert.deepStrictEqual(extractAssumptions(), []);
  });

  it('returns empty array for non-object', () => {
    assert.deepStrictEqual(extractAssumptions(123), []);
  });

  it('extracts from assumptions key', () => {
    const parsed = {
      assumptions: [
        {
          assumption: 'Users have Node 20+',
          status: 'open',
          evidence: 'Not verified',
          impact: 'High',
        },
      ],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'Users have Node 20+');
    assert.equal(first['status'], 'open');
  });

  it('extracts from open_assumptions key', () => {
    const parsed = {
      open_assumptions: [{ assumption: 'API is stable', status: 'validated' }],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });

  it('extracts from key_assumptions key', () => {
    const parsed = {
      key_assumptions: [{ name: 'Tests pass', status: 'open' }],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });

  it('normalizes string assumptions', () => {
    const parsed = {
      assumptions: ['All tests pass on CI'],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'All tests pass on CI');
    assert.equal(first['status'], 'open');
    assert.equal(first['owner'], 'unassigned');
  });

  it('normalizes unknown status to open', () => {
    const parsed = {
      assumptions: [{ assumption: 'Test', status: 'unknown-status' }],
    };
    const result = extractAssumptions(parsed);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['status'], 'open');
  });

  it('deduplicates by assumption text', () => {
    const parsed = {
      assumptions: [
        { assumption: 'Same thing', status: 'open' },
        { assumption: 'Same thing', status: 'validated' },
      ],
    };
    const result = extractAssumptions(parsed);
    assert.equal(result.length, 1);
  });
});

// ── extractAssumptionAttacks ─────────────────────────────────────────────────

describe('extractAssumptionAttacks', () => {
  it('returns empty array for null/undefined', () => {
    assert.deepStrictEqual(extractAssumptionAttacks(null), []);
    assert.deepStrictEqual(extractAssumptionAttacks(), []);
  });

  it('returns empty array for non-object', () => {
    assert.deepStrictEqual(extractAssumptionAttacks('nope'), []);
  });

  it('extracts from assumption_attacks key', () => {
    const parsed = {
      assumption_attacks: [
        {
          assumption: 'API stable',
          challenge: 'API was last changed 2 weeks ago',
          impact: 'medium',
          by: 'gemini',
        },
      ],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'API stable');
    assert.equal(first['challenge'], 'API was last changed 2 weeks ago');
  });

  it('extracts from assumption_challenges key', () => {
    const parsed = {
      assumption_challenges: [{ attack_vector: 'Timeout edge case', target: 'concurrency' }],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
  });

  it('extracts from counterarguments key', () => {
    const parsed = {
      counterarguments: [{ critique: 'Design is fragile', target_agent: 'codex' }],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
  });

  it('normalizes string attacks', () => {
    const parsed = {
      assumption_attacks: ['Token caching might stale'],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['challenge'], 'Token caching might stale');
  });

  it('skips items with empty challenge and assumption', () => {
    const parsed = {
      assumption_attacks: [{ impact: 'low' }],
    };
    const result = extractAssumptionAttacks(parsed);
    assert.equal(result.length, 0);
  });
});

// ── extractFinalDecision ─────────────────────────────────────────────────────

describe('extractFinalDecision', () => {
  it('returns null for null/undefined input', () => {
    assert.strictEqual(extractFinalDecision(null), null);
    assert.strictEqual(extractFinalDecision(), null);
  });

  it('returns null for non-object input', () => {
    assert.strictEqual(extractFinalDecision('string'), null);
  });

  it('returns null when no decision fields are present', () => {
    assert.strictEqual(extractFinalDecision({ foo: 'bar' }), null);
  });

  it('extracts decision from nested decision object', () => {
    const parsed = {
      decision: {
        summary: 'Use approach A',
        why: 'Least risky',
        owner: 'claude',
        confidence: 'high',
        next_action: 'handoff',
        reversible_first_step: 'Create feature branch',
        tradeoffs: { correctness: 'Verified', complexity: 'Low' },
      },
    };
    const result = extractFinalDecision(parsed);
    assert.notStrictEqual(result, null);
    assert.equal(result!.summary, 'Use approach A');
    assert.equal(result!.why, 'Least risky');
    assert.equal(result!.confidence, 'high');
    assert.equal(result!.nextAction, 'handoff');
    assert.equal(result!.reversibleFirstStep, 'Create feature branch');
  });

  it('extracts from top-level consensus/view fallbacks', () => {
    const parsed = { consensus: 'We agree on approach B' };
    const result = extractFinalDecision(parsed);
    assert.notStrictEqual(result, null);
    assert.equal(result!.summary, 'We agree on approach B');
  });

  it('uses fallback agent and phase', () => {
    const parsed = { decision: { summary: 'Do X' } };
    const result = extractFinalDecision(parsed, { agent: 'gemini', phase: 'critique' });
    assert.notStrictEqual(result, null);
    assert.equal(result!.sourceAgent, 'gemini');
    assert.equal(result!.sourcePhase, 'critique');
    assert.equal(result!.owner, 'gemini');
  });

  it('normalizes confidence values', () => {
    const parsed = { decision: { summary: 'X', confidence: 'LOW' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.confidence, 'low');
  });

  it('returns empty string for invalid confidence', () => {
    const parsed = { decision: { summary: 'X', confidence: 'maybe' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.confidence, '');
  });

  it('normalizes next_action values', () => {
    const parsed = { decision: { summary: 'X', next_action: 'delegate' } };
    const result = extractFinalDecision(parsed);
    assert.equal(result!.nextAction, 'handoff');
  });
});

// ── deriveCouncilRecommendation ──────────────────────────────────────────────

describe('deriveCouncilRecommendation', () => {
  it('returns handoff with no inputs', () => {
    const result = deriveCouncilRecommendation();
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
    assert.equal(typeof result.rationale, 'string');
  });

  it('recommends council when explicit nextAction is council', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'council' },
    });
    assert.equal(result.recommendedMode, 'council');
    assert.equal(result.nextAction, 'council');
  });

  it('recommends council for human_decision nextAction', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'human_decision' },
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('recommends handoff for explicit handoff with high confidence', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'high' },
    });
    assert.equal(result.recommendedMode, 'handoff');
    assert.equal(result.nextAction, 'handoff');
  });

  it('escalates to council when handoff with low confidence and disagreements', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'low' },
      disagreements: ['There is a dispute', 'Another dispute'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates to council with many risk items', () => {
    const result = deriveCouncilRecommendation({
      risks: ['r1', 'r2', 'r3', 'r4'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates to council with disagreements', () => {
    const result = deriveCouncilRecommendation({
      disagreements: ['agents disagree'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates with low confidence and open assumptions', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      assumptions: [{ status: 'open' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates with low confidence and human questions', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      questions: [{ to: 'human' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates with positive council signals and open assumptions', () => {
    const result = deriveCouncilRecommendation({
      councilVotes: [{ vote: true }],
      assumptions: [{ status: 'open' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('includes rationale with key metrics', () => {
    const result = deriveCouncilRecommendation({
      risks: ['a', 'b'],
      assumptions: [{ status: 'open' }],
    });
    assert.match(result.rationale, /open_assumptions=1/);
    assert.match(result.rationale, /risk_items=2/);
  });
});

// ── synthesizeCouncilTranscript ──────────────────────────────────────────────

describe('synthesizeCouncilTranscript', () => {
  it('returns defaults for empty transcript', () => {
    const result = synthesizeCouncilTranscript('Test prompt', []);
    assert.equal(result.prompt, 'Test prompt');
    assert.equal(result.consensus, '');
    assert.ok(Array.isArray(result.tasks));
    assert.ok(result.tasks.length > 0); // default tasks
    assert.ok(Array.isArray(result.risks));
    assert.ok(Array.isArray(result.questions));
    assert.equal(typeof result.recommendedMode, 'string');
    assert.equal(typeof result.recommendedNextAction, 'string');
    assert.equal(typeof result.recommendationRationale, 'string');
  });

  it('extracts consensus from codex implement phase', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: { consensus: 'We should use approach A' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'We should use approach A');
  });

  it('extracts consensus from claude refine phase when no codex', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'refine',
        parsed: { view: 'Refined approach' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'Refined approach');
  });

  it('accumulates tasks across transcript entries', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          recommended_tasks: [
            {
              owner: 'codex',
              title: 'Implement feature',
              rationale: 'Core work',
              definition_of_done: 'Tests pass',
            },
          ],
        },
      },
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          task_allocations: [
            {
              owner: 'gemini',
              title: 'Review code',
              rationale: 'Quality gate',
              definition_of_done: 'Approved',
            },
          ],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.tasks.length >= 2);
  });

  it('accumulates decision options, assumptions, and attacks', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          decision_options: [{ option: 'A', summary: 'Approach A' }],
          assumptions: [{ assumption: 'API stable', status: 'open' }],
        },
      },
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          assumption_attacks: [{ assumption: 'API stable', challenge: 'Not verified' }],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.decisionOptions.length >= 1);
    assert.ok(result.assumptions.length >= 1);
    assert.ok(result.assumptionAttacks.length >= 1);
  });

  it('includes final decision and recommendation', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'refine',
        parsed: {
          decision: {
            summary: 'Go with plan B',
            why: 'Lower risk',
            owner: 'claude',
            confidence: 'high',
            next_action: 'handoff',
          },
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.notStrictEqual(result.finalDecision, null);
    assert.equal(typeof result.recommendedMode, 'string');
  });

  it('skips transcript entries with no parsed data', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', parsed: null },
      { agent: 'gemini', phase: 'critique' },
      {
        agent: 'codex',
        phase: 'implement',
        parsed: { consensus: 'Done' },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.consensus, 'Done');
  });
});

// ── buildStepPrompt ──────────────────────────────────────────────────────────

describe('buildStepPrompt', () => {
  it('includes round and phase in output', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'propose', promptLabel: 'Analyze' },
      'Test objective',
      [],
      1,
      3,
    );
    assert.match(result, /round 1\/3/);
    assert.match(result, /phase: propose/);
  });

  it('includes objective and phase instruction', () => {
    const result = buildStepPrompt(
      { agent: 'gemini', phase: 'critique', promptLabel: 'Review critically' },
      'Fix the bug',
      [],
      2,
      3,
    );
    assert.match(result, /Objective: Fix the bug/);
    assert.match(result, /Phase instruction: Review critically/);
  });

  it('includes JSON schema for critique phase', () => {
    const result = buildStepPrompt(
      { agent: 'gemini', phase: 'critique', promptLabel: 'Critique' },
      'Prompt',
      [],
      1,
      1,
    );
    assert.match(result, /assumption_attacks/);
    assert.match(result, /critique/);
  });

  it('includes JSON schema for implement phase', () => {
    const result = buildStepPrompt(
      { agent: 'codex', phase: 'implement', promptLabel: 'Implement' },
      'Prompt',
      [],
      1,
      1,
    );
    assert.match(result, /task_allocations/);
    assert.match(result, /consensus/);
  });

  it('includes spec content when provided', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'propose', promptLabel: 'Propose' },
      'Prompt',
      [],
      1,
      1,
      'Must use TypeScript strict mode.',
    );
    assert.match(result, /Anchoring Specification/);
    assert.match(result, /Must use TypeScript strict mode/);
  });

  it('omits spec section when null', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'propose', promptLabel: 'Propose' },
      'Prompt',
      [],
      1,
      1,
      null,
    );
    assert.doesNotMatch(result, /Anchoring Specification/);
  });

  it('includes recent context summary from transcript', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', round: 1, parsed: { view: 'Plan A' } },
    ];
    const result = buildStepPrompt(
      { agent: 'gemini', phase: 'critique', promptLabel: 'Critique' },
      'Prompt',
      transcript,
      1,
      2,
    );
    assert.match(result, /CLAUDE.*propose/i);
  });

  it('includes decision criteria instruction', () => {
    const result = buildStepPrompt(
      { agent: 'claude', phase: 'refine', promptLabel: 'Refine' },
      'Prompt',
      [],
      1,
      1,
    );
    assert.match(result, /Decision criteria for convergence/);
    assert.match(result, /Do not use majority vote/);
  });
});

// ── resolveActiveAgents ──────────────────────────────────────────────────────

describe('resolveActiveAgents', () => {
  it('returns defaults when filter is null', () => {
    assert.deepStrictEqual(resolveActiveAgents(null), ['claude', 'gemini', 'codex']);
  });

  it('returns defaults when filter is empty array', () => {
    assert.deepStrictEqual(resolveActiveAgents([]), ['claude', 'gemini', 'codex']);
  });

  it('filters to only specified agents', () => {
    assert.deepStrictEqual(resolveActiveAgents(['claude', 'codex']), ['claude', 'codex']);
  });

  it('preserves default ordering', () => {
    // Even though filter lists codex first, result follows defaults order
    assert.deepStrictEqual(resolveActiveAgents(['codex', 'claude']), ['claude', 'codex']);
  });

  it('ignores agents not in defaults', () => {
    assert.deepStrictEqual(resolveActiveAgents(['claude', 'unknown']), ['claude']);
  });

  it('respects custom defaults', () => {
    assert.deepStrictEqual(resolveActiveAgents(null, ['a', 'b']), ['a', 'b']);
  });
});

// ── computeAdversarialResumePoint ────────────────────────────────────────────

describe('computeAdversarialResumePoint', () => {
  it('returns round 1, phase 0 for empty transcript', () => {
    const result = computeAdversarialResumePoint([]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 0 });
  });

  it('returns Infinity when last entry is implement', () => {
    const result = computeAdversarialResumePoint([{ phase: 'implement', round: 1 }]);
    assert.equal(result.startRound, Infinity);
  });

  it('advances to next phase after diverge', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 1 }]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 1 });
  });

  it('advances to next phase after attack', () => {
    const result = computeAdversarialResumePoint([{ phase: 'attack', round: 2 }]);
    assert.deepStrictEqual(result, { startRound: 2, startPhaseIdx: 2 });
  });

  it('advances to next round after synthesize', () => {
    const result = computeAdversarialResumePoint([{ phase: 'synthesize', round: 1 }]);
    assert.deepStrictEqual(result, { startRound: 2, startPhaseIdx: 0 });
  });

  it('uses last entry when multiple exist', () => {
    const result = computeAdversarialResumePoint([
      { phase: 'diverge', round: 1 },
      { phase: 'attack', round: 1 },
    ]);
    // last is attack (idx 1), so next is synthesize (idx 2)
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 2 });
  });

  it('handles unknown phase by advancing round', () => {
    const result = computeAdversarialResumePoint([{ phase: 'unknown', round: 3 }]);
    assert.deepStrictEqual(result, { startRound: 4, startPhaseIdx: 0 });
  });

  it('handles round 0 or NaN by defaulting to round 1', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 0 }]);
    assert.equal(result.startRound, 1);
  });
});

// ── COUNCIL_DECISION_CRITERIA ────────────────────────────────────────────────

describe('COUNCIL_DECISION_CRITERIA', () => {
  it('exports an array of criteria with key and label', () => {
    assert.ok(Array.isArray(COUNCIL_DECISION_CRITERIA));
    assert.ok(COUNCIL_DECISION_CRITERIA.length > 0);
    for (const c of COUNCIL_DECISION_CRITERIA) {
      assert.equal(typeof c.key, 'string');
      assert.equal(typeof c.label, 'string');
    }
  });

  it('includes correctness, complexity, reversibility, user_impact', () => {
    const keys = COUNCIL_DECISION_CRITERIA.map((c) => c.key);
    assert.ok(keys.includes('correctness'));
    assert.ok(keys.includes('complexity'));
    assert.ok(keys.includes('reversibility'));
    assert.ok(keys.includes('user_impact'));
  });
});
