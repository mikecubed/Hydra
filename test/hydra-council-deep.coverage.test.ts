/**
 * Deep coverage tests for lib/hydra-council.ts — exercises internal logic paths
 * through exported functions with carefully crafted inputs.
 *
 * Complements hydra-council.coverage.test.ts by targeting previously-uncovered
 * internal functions: normalizeTradeoffs, normalizeConfidence, normalizeNextAction,
 * extractQuestions, extractRisks, extractCouncilSignal, extractDisagreements,
 * accumulateTranscriptData, deduplicateAccumulatedData, buildContextSummary, etc.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDecisionOptions,
  extractAssumptions,
  // extractAssumptionAttacks is tested via indirect paths below
  extractFinalDecision,
  deriveCouncilRecommendation,
  synthesizeCouncilTranscript,
  buildStepPrompt,
  resolveActiveAgents,
  computeAdversarialResumePoint,
  COUNCIL_DECISION_CRITERIA,
} from '../lib/hydra-council.ts';

// ── COUNCIL_DECISION_CRITERIA ─────────────────────────────────────────────────

describe('COUNCIL_DECISION_CRITERIA', () => {
  it('has expected keys', () => {
    const keys = COUNCIL_DECISION_CRITERIA.map((c) => c.key);
    assert.ok(keys.includes('correctness'));
    assert.ok(keys.includes('complexity'));
    assert.ok(keys.includes('reversibility'));
    assert.ok(keys.includes('user_impact'));
  });

  it('each entry has key and label', () => {
    for (const item of COUNCIL_DECISION_CRITERIA) {
      assert.ok(typeof item.key === 'string' && item.key.length > 0);
      assert.ok(typeof item.label === 'string' && item.label.length > 0);
    }
  });
});

// ── extractFinalDecision — normalizeNextAction paths ─────────────────────────

describe('extractFinalDecision — nextAction normalization', () => {
  it('normalizes "delegate" to "handoff"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', next_action: 'delegate' } });
    assert.equal(result!.nextAction, 'handoff');
  });

  it('normalizes "ship" to "handoff"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', next_action: 'ship' } });
    assert.equal(result!.nextAction, 'handoff');
  });

  it('normalizes "deeper_council" to "council"', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'deeper_council' },
    });
    assert.equal(result!.nextAction, 'council');
  });

  it('normalizes "open_council" to "council"', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'open_council' },
    });
    assert.equal(result!.nextAction, 'council');
  });

  it('normalizes "continue_council" to "council"', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'continue_council' },
    });
    assert.equal(result!.nextAction, 'council');
  });

  it('normalizes "human" to "human_decision"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', next_action: 'human' } });
    assert.equal(result!.nextAction, 'human_decision');
  });

  it('normalizes "ask_human" to "human_decision"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', next_action: 'ask_human' } });
    assert.equal(result!.nextAction, 'human_decision');
  });

  it('normalizes "needs_human" to "human_decision"', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'needs_human' },
    });
    assert.equal(result!.nextAction, 'human_decision');
  });

  it('normalizes "human_decision" to "human_decision"', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'human_decision' },
    });
    assert.equal(result!.nextAction, 'human_decision');
  });

  it('returns empty string for unknown next_action', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: 'unknown_action' },
    });
    assert.equal(result!.nextAction, '');
  });

  it('handles whitespace in next_action', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', next_action: '  handoff  ' },
    });
    assert.equal(result!.nextAction, 'handoff');
  });
});

// ── extractFinalDecision — normalizeConfidence paths ────────────────────────

describe('extractFinalDecision — confidence normalization', () => {
  it('normalizes "LOW" to "low"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', confidence: 'LOW' } });
    assert.equal(result!.confidence, 'low');
  });

  it('normalizes "Medium" to "medium"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', confidence: 'Medium' } });
    assert.equal(result!.confidence, 'medium');
  });

  it('normalizes "HIGH" to "high"', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', confidence: 'HIGH' } });
    assert.equal(result!.confidence, 'high');
  });

  it('returns empty string for non-standard confidence', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', confidence: 'very high' } });
    assert.equal(result!.confidence, '');
  });

  it('returns empty string for numeric confidence', () => {
    const result = extractFinalDecision({ decision: { summary: 'X', confidence: 0.9 } });
    assert.equal(result!.confidence, '');
  });

  it('falls back to top-level confidence when decision lacks it', () => {
    const result = extractFinalDecision({ confidence: 'high', decision: { summary: 'X' } });
    assert.equal(result!.confidence, 'high');
  });
});

// ── extractFinalDecision — normalizeTradeoffs paths ─────────────────────────

describe('extractFinalDecision — tradeoffs normalization', () => {
  it('extracts tradeoffs from nested decision', () => {
    const result = extractFinalDecision({
      decision: {
        summary: 'X',
        tradeoffs: { correctness: 'Good', complexity: 'Low', reversibility: 'High' },
      },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.equal(result!.tradeoffs!['correctness'], 'Good');
    assert.equal(result!.tradeoffs!['complexity'], 'Low');
  });

  it('falls back to criteria key for tradeoffs', () => {
    const result = extractFinalDecision({
      decision: {
        summary: 'X',
        criteria: { correctness: 'Fine' },
      },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.equal(result!.tradeoffs!['correctness'], 'Fine');
  });

  it('falls back to top-level tradeoffs', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X' },
      tradeoffs: { complexity: 'Medium' },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.equal(result!.tradeoffs!['complexity'], 'Medium');
  });

  it('falls back to top-level decision_criteria', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X' },
      decision_criteria: { user_impact: 'Low' },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.equal(result!.tradeoffs!['user_impact'], 'Low');
  });

  it('returns null tradeoffs for array tradeoffs', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', tradeoffs: ['a', 'b'] },
    });
    assert.strictEqual(result!.tradeoffs, null);
  });

  it('returns null tradeoffs when no known criteria keys match', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', tradeoffs: { unknown_key: 'value' } },
    });
    assert.strictEqual(result!.tradeoffs, null);
  });

  it('ignores empty string values in tradeoffs', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', tradeoffs: { correctness: '', complexity: 'Low' } },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.ok(!('correctness' in result!.tradeoffs!));
    assert.equal(result!.tradeoffs!['complexity'], 'Low');
  });

  it('supports camelCase variants of criteria keys', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', tradeoffs: { userImpact: 'Critical' } },
    });
    assert.notStrictEqual(result!.tradeoffs, null);
    assert.equal(result!.tradeoffs!['user_impact'], 'Critical');
  });
});

// ── extractFinalDecision — decision field fallbacks ─────────────────────────

describe('extractFinalDecision — field extraction fallbacks', () => {
  it('extracts summary from decision.choice', () => {
    const result = extractFinalDecision({ decision: { choice: 'Plan B' } });
    assert.equal(result!.summary, 'Plan B');
  });

  it('extracts summary from decision.recommendation', () => {
    const result = extractFinalDecision({ decision: { recommendation: 'Go with X' } });
    assert.equal(result!.summary, 'Go with X');
  });

  it('extracts summary from top-level view', () => {
    const result = extractFinalDecision({ view: 'My view' });
    assert.equal(result!.summary, 'My view');
  });

  it('extracts why from decision.rationale', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', rationale: 'Because Y' },
    });
    assert.equal(result!.why, 'Because Y');
  });

  it('extracts why from decision.reason', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', reason: 'For Z' },
    });
    assert.equal(result!.why, 'For Z');
  });

  it('extracts why from top-level decision_rationale', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X' },
      decision_rationale: 'Top-level reason',
    });
    assert.equal(result!.why, 'Top-level reason');
  });

  it('extracts owner from decision.decider', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', decider: 'gemini' },
    });
    // Without fallback.agent, uses decision owner
    assert.equal(result!.owner, 'gemini');
  });

  it('extracts reversible_first_step from camelCase', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', reversibleFirstStep: 'Create branch' },
    });
    assert.equal(result!.reversibleFirstStep, 'Create branch');
  });

  it('extracts reversible_first_step from top-level', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X' },
      reversible_first_step: 'Create PR',
    });
    assert.equal(result!.reversibleFirstStep, 'Create PR');
  });

  it('uses nextAction from camelCase', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X', nextAction: 'handoff' },
    });
    assert.equal(result!.nextAction, 'handoff');
  });

  it('extracts nextAction from top-level next_action', () => {
    const result = extractFinalDecision({
      decision: { summary: 'X' },
      next_action: 'council',
    });
    assert.equal(result!.nextAction, 'council');
  });
});

// ── synthesizeCouncilTranscript — exercising internal extraction functions ───

describe('synthesizeCouncilTranscript — question extraction', () => {
  it('extracts questions from multiple bucket keys', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          questions: [{ to: 'human', question: 'Clarify scope?' }],
          final_questions: [{ to: 'gemini', question: 'Check tests?' }],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.questions.length >= 2);
  });

  it('extracts string questions as to=human', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          questions: ['What is the deployment target?'],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.questions.length >= 1);
    const q = result.questions[0] as Record<string, unknown>;
    assert.equal(q['to'], 'human');
    assert.equal(q['question'], 'What is the deployment target?');
  });

  it('extracts from open_questions bucket', () => {
    const transcript = [
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          open_questions: [{ to: 'codex', text: 'Feasibility check?' }],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.questions.length >= 1);
  });

  it('skips empty string questions', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          questions: ['', '  ', 'Valid question?'],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.questions.length, 1);
  });
});

describe('synthesizeCouncilTranscript — risk extraction', () => {
  it('extracts risks from multiple bucket keys', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          risks: ['Data loss risk'],
          sanity_checks: ['Check backups'],
          edge_cases: ['Empty input case'],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.risks.length >= 3);
  });

  it('deduplicates identical risk strings', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: { risks: ['Same risk', 'Same risk'] },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.risks.length, 1);
  });

  it('skips empty string risks', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: { risks: ['', '  ', 'Real risk'] },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.risks.length, 1);
  });

  it('skips non-string risk items', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: { risks: [42, null, { nested: true }, 'Valid'] },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.risks.length, 1);
  });
});

describe('synthesizeCouncilTranscript — council signal extraction', () => {
  it('captures council votes from should_open_council', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          view: 'some view',
          should_open_council: true,
          council_reason: 'Need more critique',
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.councilVotes.length >= 1);
    const vote = result.councilVotes[0] as Record<string, unknown>;
    assert.equal(vote['vote'], true);
  });

  it('captures false council votes', () => {
    const transcript = [
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          critique: 'Looks good',
          needs_council: false,
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.councilVotes.length >= 1);
    const vote = result.councilVotes[0] as Record<string, unknown>;
    assert.equal(vote['vote'], false);
  });

  it('uses reason from top-level reason field', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          consensus: 'agree',
          council_needed: true,
          reason: 'Complex design question',
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.councilVotes.length >= 1);
    const vote = result.councilVotes[0] as Record<string, unknown>;
    assert.equal(vote['reason'], 'Complex design question');
  });
});

describe('synthesizeCouncilTranscript — disagreement extraction', () => {
  it('extracts disagreements from multiple bucket keys', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          consensus: 'partial',
          disagreements: ['Approach differs'],
          unresolved_tensions: ['Architecture conflict'],
          conflicts: ['Priority mismatch'],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.disagreements.length >= 3);
  });

  it('deduplicates identical disagreements', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          consensus: 'X',
          disagreements: ['Same', 'Same'],
          unresolved_tensions: ['Same'],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.equal(result.disagreements.length, 1);
  });
});

describe('synthesizeCouncilTranscript — task extraction', () => {
  it('extracts from task_allocations bucket', () => {
    const transcript = [
      {
        agent: 'codex',
        phase: 'implement',
        parsed: {
          consensus: 'go',
          task_allocations: [
            { owner: 'claude', title: 'Task 1', rationale: 'R1', definition_of_done: 'D1' },
          ],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.tasks.length >= 1);
  });

  it('extracts from recommended_tasks bucket', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: {
          view: 'X',
          recommended_tasks: [
            { owner: 'gemini', title: 'Review', rationale: 'QA', definition_of_done: 'Pass' },
          ],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.tasks.length >= 1);
  });

  it('extracts from tasks bucket', () => {
    const transcript = [
      {
        agent: 'gemini',
        phase: 'critique',
        parsed: {
          critique: 'ok',
          tasks: [{ owner: 'codex', title: 'Fix bug', rationale: 'Urgent' }],
        },
      },
    ];
    const result = synthesizeCouncilTranscript('prompt', transcript);
    assert.ok(result.tasks.length >= 1);
  });

  it('provides default tasks when transcript has no tasks', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        parsed: { view: 'Plain view, no tasks' },
      },
    ];
    const result = synthesizeCouncilTranscript('My prompt', transcript);
    assert.ok(result.tasks.length >= 3);
  });
});

// ── buildStepPrompt — phase-specific schema and focus instructions ──────────

describe('buildStepPrompt — phase-specific content', () => {
  const makeStep = (agent: string, phase: string) => ({
    agent,
    phase,
    promptLabel: 'Do something.',
  });

  it('includes propose schema for propose phase', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 1, 1);
    assert.match(prompt, /should_open_council/);
    assert.match(prompt, /recommended_tasks/);
    assert.match(prompt, /decision_options/);
  });

  it('includes critique-specific focus for critique phase', () => {
    const prompt = buildStepPrompt(makeStep('gemini', 'critique'), 'Test', [], 1, 1);
    assert.match(prompt, /attack the strongest assumption/i);
    assert.match(prompt, /assumption_attacks/);
  });

  it('includes refine-specific focus for refine phase', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'refine'), 'Test', [], 1, 1);
    assert.match(prompt, /resolve critique/i);
    assert.match(prompt, /"decision"/);
  });

  it('includes implement-specific focus for implement phase', () => {
    const prompt = buildStepPrompt(makeStep('codex', 'implement'), 'Test', [], 1, 1);
    assert.match(prompt, /final synthesizer/i);
    assert.match(prompt, /task_allocations/);
    assert.match(prompt, /disagreements/);
  });

  it('includes spec content when provided', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 1, 1, 'My spec');
    assert.match(prompt, /Anchoring Specification/);
    assert.match(prompt, /My spec/);
  });

  it('omits spec content when null', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 1, 1, null);
    assert.ok(!prompt.includes('Anchoring Specification'));
  });

  it('includes round info', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 2, 3);
    assert.match(prompt, /round 2\/3/);
  });

  it('includes context summary from transcript', () => {
    const transcript = [
      { agent: 'claude', phase: 'propose', round: 1, rawText: 'Previous output' },
    ];
    const prompt = buildStepPrompt(makeStep('gemini', 'critique'), 'Test', transcript, 1, 1);
    assert.match(prompt, /CLAUDE/);
  });

  it('shows (none) for empty transcript context', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 1, 1);
    assert.match(prompt, /\(none\)/);
  });

  it('includes decision criteria instruction', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'propose'), 'Test', [], 1, 1);
    assert.match(prompt, /correctness/);
    assert.match(prompt, /complexity/);
    assert.match(prompt, /reversibility/);
    assert.match(prompt, /user_impact|User impact/i);
  });

  it('returns empty schema for unknown phase', () => {
    const prompt = buildStepPrompt(makeStep('claude', 'unknown'), 'Test', [], 1, 1);
    // Unknown phase should still produce a prompt, just with empty schema {}
    assert.ok(prompt.length > 0);
  });
});

// ── resolveActiveAgents — more paths ────────────────────────────────────────

describe('resolveActiveAgents', () => {
  it('returns defaults when filter is null', () => {
    const result = resolveActiveAgents(null);
    assert.deepStrictEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('returns defaults when filter is empty array', () => {
    const result = resolveActiveAgents([]);
    assert.deepStrictEqual(result, ['claude', 'gemini', 'codex']);
  });

  it('filters to subset preserving order', () => {
    const result = resolveActiveAgents(['codex', 'claude']);
    assert.deepStrictEqual(result, ['claude', 'codex']);
  });

  it('filters out agents not in defaults', () => {
    const result = resolveActiveAgents(['claude', 'unknown']);
    assert.deepStrictEqual(result, ['claude']);
  });

  it('returns empty when no agents match', () => {
    const result = resolveActiveAgents(['unknown1', 'unknown2']);
    assert.deepStrictEqual(result, []);
  });

  it('accepts custom defaults', () => {
    const result = resolveActiveAgents(null, ['alpha', 'beta']);
    assert.deepStrictEqual(result, ['alpha', 'beta']);
  });

  it('filters custom defaults', () => {
    const result = resolveActiveAgents(['beta'], ['alpha', 'beta', 'gamma']);
    assert.deepStrictEqual(result, ['beta']);
  });
});

// ── computeAdversarialResumePoint — comprehensive paths ─────────────────────

describe('computeAdversarialResumePoint', () => {
  it('returns {1, 0} for empty transcript', () => {
    const result = computeAdversarialResumePoint([]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 0 });
  });

  it('returns Infinity for completed implement phase', () => {
    const result = computeAdversarialResumePoint([{ phase: 'implement', round: 1 }]);
    assert.equal(result.startRound, Infinity);
  });

  it('advances to next phase after diverge', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 1 }]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 1 });
  });

  it('advances to next phase after attack', () => {
    const result = computeAdversarialResumePoint([{ phase: 'attack', round: 1 }]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 2 });
  });

  it('advances to next round after synthesize (last phase)', () => {
    const result = computeAdversarialResumePoint([{ phase: 'synthesize', round: 2 }]);
    assert.deepStrictEqual(result, { startRound: 3, startPhaseIdx: 0 });
  });

  it('handles unknown phase (negative indexOf) by advancing round', () => {
    const result = computeAdversarialResumePoint([{ phase: 'unknown', round: 1 }]);
    assert.deepStrictEqual(result, { startRound: 2, startPhaseIdx: 0 });
  });

  it('uses last entry when multiple are present', () => {
    const result = computeAdversarialResumePoint([
      { phase: 'diverge', round: 1 },
      { phase: 'attack', round: 1 },
    ]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 2 });
  });

  it('handles round=0 by defaulting to round 1', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: 0 }]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 1 });
  });

  it('handles NaN round by defaulting to round 1', () => {
    const result = computeAdversarialResumePoint([{ phase: 'diverge', round: Number.NaN }]);
    assert.deepStrictEqual(result, { startRound: 1, startPhaseIdx: 1 });
  });
});

// ── deriveCouncilRecommendation — additional escalation paths ───────────────

describe('deriveCouncilRecommendation — advanced escalation logic', () => {
  it('escalates with low confidence and risk items', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { confidence: 'low' },
      risks: ['risk 1'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('escalates with many cross-agent questions', () => {
    const result = deriveCouncilRecommendation({
      questions: [{ to: 'gemini' }, { to: 'codex' }],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('does not escalate with single cross-agent question', () => {
    const result = deriveCouncilRecommendation({
      questions: [{ to: 'gemini' }],
    });
    assert.equal(result.recommendedMode, 'handoff');
  });

  it('escalates with positive council signals and risks', () => {
    const result = deriveCouncilRecommendation({
      councilVotes: [{ vote: true }],
      risks: ['something'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('does not escalate with positive council signals but no issues', () => {
    const result = deriveCouncilRecommendation({
      councilVotes: [{ vote: true }],
    });
    assert.equal(result.recommendedMode, 'handoff');
  });

  it('overrides handoff to council when synthesis looks weak (many risks)', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff' },
      risks: ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('overrides handoff to council when low confidence with disagreements', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { nextAction: 'handoff', confidence: 'low' },
      disagreements: ['d1', 'd2'],
    });
    assert.equal(result.recommendedMode, 'council');
  });

  it('rationale includes owner info', () => {
    const result = deriveCouncilRecommendation({
      finalDecision: { owner: 'claude' },
    });
    assert.match(result.rationale, /decision_owner=claude/);
  });
});

// ── extractDecisionOptions — option normalization edge cases ────────────────

describe('extractDecisionOptions — normalization edge cases', () => {
  it('handles tradeoffs with only non-matching keys', () => {
    const parsed = {
      decision_options: [
        {
          option: 'A',
          summary: 'approach A',
          tradeoffs: { foo: 'bar', baz: 'qux' },
        },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    // normalizeTradeoffs returns null for no matching keys, and mergeTruthy drops null values
    assert.ok(first['tradeoffs'] === null || first['tradeoffs'] === undefined);
  });

  it('merges overlapping entries via dedupeBy/mergeTruthy', () => {
    const parsed = {
      decision_options: [
        { option: 'X', summary: 'desc', preferred: false },
        { option: 'X', summary: 'desc', preferred: true, tradeoffs: { correctness: 'High' } },
      ],
    };
    const result = extractDecisionOptions(parsed);
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    // mergeTruthy should update preferred and add tradeoffs
    assert.equal(first['preferred'], true);
    assert.notStrictEqual(first['tradeoffs'], null);
  });
});

// ── extractAssumptions — edge cases ─────────────────────────────────────────

describe('extractAssumptions — edge cases', () => {
  it('extracts assumption from summary field', () => {
    const result = extractAssumptions({
      assumptions: [{ summary: 'All tests green' }],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'All tests green');
  });

  it('extracts assumption from question field', () => {
    const result = extractAssumptions({
      assumptions: [{ question: 'Is the API stable?' }],
    });
    assert.equal(result.length, 1);
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['assumption'], 'Is the API stable?');
  });

  it('respects validated status', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'X', status: 'validated' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['status'], 'validated');
  });

  it('respects rejected status', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'X', status: 'rejected' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['status'], 'rejected');
  });

  it('extracts evidence and impact', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'Test', evidence: 'CI logs', impact: 'High', owner: 'claude' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['evidence'], 'CI logs');
    assert.equal(first['impact'], 'High');
    assert.equal(first['owner'], 'claude');
  });

  it('uses basis field as evidence fallback', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'X', basis: 'Historical data' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['evidence'], 'Historical data');
  });

  it('uses risk field as impact fallback', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'X', risk: 'Data loss' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['impact'], 'Data loss');
  });

  it('skips null items', () => {
    const result = extractAssumptions({
      assumptions: [null, undefined],
    });
    assert.equal(result.length, 0);
  });

  it('skips empty assumption text', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: '' }],
    });
    assert.equal(result.length, 0);
  });

  it('uses to field as owner fallback', () => {
    const result = extractAssumptions({
      assumptions: [{ assumption: 'X', to: 'gemini' }],
    });
    const first = result[0] as Record<string, unknown>;
    assert.equal(first['owner'], 'gemini');
  });
});

// ── synthesizeCouncilTranscript — full integration scenario ─────────────────

describe('synthesizeCouncilTranscript — multi-round integration', () => {
  it('synthesizes a complete multi-round transcript', () => {
    const transcript = [
      {
        agent: 'claude',
        phase: 'propose',
        round: 1,
        parsed: {
          view: 'Propose two options',
          should_open_council: true,
          council_reason: 'Need critique',
          decision_options: [
            {
              option: 'Feature flag',
              summary: 'Roll out behind flag',
              preferred: true,
              tradeoffs: { correctness: 'Safe', complexity: 'Medium' },
            },
            {
              option: 'Big bang',
              summary: 'Ship directly',
              preferred: false,
              tradeoffs: { correctness: 'Risky', complexity: 'Low' },
            },
          ],
          assumptions: [{ assumption: 'API is stable', status: 'open' }],
          recommended_tasks: [{ owner: 'gemini', title: 'Review', rationale: 'QA' }],
          questions: [{ to: 'gemini', question: 'Performance impact?' }],
          risks: ['Feature flag complexity'],
        },
      },
      {
        agent: 'gemini',
        phase: 'critique',
        round: 1,
        parsed: {
          critique: 'Feature flag adds runtime overhead',
          should_open_council: false,
          assumption_attacks: [
            { assumption: 'API is stable', challenge: 'Recent breaking changes', by: 'gemini' },
          ],
          edge_cases: ['Concurrent flag changes'],
          risks: ['Memory leak in flag evaluator'],
        },
      },
      {
        agent: 'claude',
        phase: 'refine',
        round: 1,
        parsed: {
          view: 'Refined plan: use flag with cache',
          decision: {
            summary: 'Feature flag with caching',
            why: 'Best balance of safety and speed',
            owner: 'claude',
            confidence: 'high',
            next_action: 'handoff',
            reversible_first_step: 'Create feature branch',
            tradeoffs: {
              correctness: 'Verified with tests',
              complexity: 'Moderate',
              reversibility: 'High',
              user_impact: 'Low',
            },
          },
          assumptions: [
            { assumption: 'API is stable', status: 'validated', evidence: 'Tests pass' },
          ],
          recommended_tasks: [{ owner: 'codex', title: 'Implement flag', rationale: 'Core work' }],
        },
      },
      {
        agent: 'codex',
        phase: 'implement',
        round: 1,
        parsed: {
          consensus: 'Feature flag with caching approved',
          task_allocations: [
            {
              owner: 'codex',
              title: 'Implement flag',
              rationale: 'Assigned',
              definition_of_done: 'Tests pass',
            },
            {
              owner: 'gemini',
              title: 'Review implementation',
              rationale: 'Quality',
              definition_of_done: 'Approved',
            },
          ],
          disagreements: ['Minor disagreement on cache TTL'],
          questions: [{ to: 'human', question: 'Deploy timeline?' }],
        },
      },
    ];

    const result = synthesizeCouncilTranscript('Implement feature flags', transcript);

    // Consensus from last codex
    assert.equal(result.consensus, 'Feature flag with caching approved');

    // Tasks extracted from transcript (not defaults)
    assert.ok(result.tasks.length >= 2);

    // Questions accumulated
    assert.ok(result.questions.length >= 2);

    // Risks accumulated and deduplicated
    assert.ok(result.risks.length >= 2);

    // Council votes
    assert.ok(result.councilVotes.length >= 2);

    // Decision options
    assert.ok(result.decisionOptions.length >= 2);

    // Assumptions
    assert.ok(result.assumptions.length >= 1);

    // Assumption attacks
    assert.ok(result.assumptionAttacks.length >= 1);

    // Disagreements
    assert.ok(result.disagreements.length >= 1);

    // Final decision present
    assert.notStrictEqual(result.finalDecision, null);

    // Recommendation reflects high confidence handoff
    assert.equal(typeof result.recommendedMode, 'string');
    assert.equal(typeof result.recommendedNextAction, 'string');
    assert.ok(result.recommendationRationale.length > 0);
  });
});
