/**
 * Deep coverage tests for hydra-operator-dispatch.ts — brief builders,
 * dispatch functions, cross-verification, and daemon HTTP delegation.
 *
 * Requires --experimental-test-module-mocks.
 */

import { describe, it, mock, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock State ────────────────────────────────────────────────────────────────

const mockRequest = mock.fn(
  async (_method: string, _baseUrl: string, _path: string, _payload?: unknown) => ({
    task: { id: 'task-1', owner: 'claude' },
    handoff: { id: 'handoff-1' },
    decision: { id: 'decision-1' },
    ok: true,
  }),
);

const mockExecuteAgent = mock.fn(async (_agent: string, _prompt: string, _opts?: unknown) => ({
  ok: true,
  output: '{"approved": true, "issues": [], "suggestions": ["improve X"]}',
  stdout: '{"approved": true, "issues": [], "suggestions": ["improve X"]}',
  stderr: '',
  error: '',
  exitCode: 0,
}));

// ── Module Mocks ──────────────────────────────────────────────────────────────

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
      taskRules: ['Rule 1'],
      taskAffinity: { code: 0.8, review: 0.6, analysis: 0.7 },
    }),
    getVerifier: (producer: string) => {
      const map: Record<string, string> = {
        claude: 'gemini',
        gemini: 'codex',
        codex: 'claude',
      };
      return map[producer] ?? producer;
    },
    AGENT_NAMES: ['claude', 'gemini', 'codex'],
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
      routing: {},
      roles: {},
      crossModelVerification: { enabled: true, mode: 'always' },
    }),
    getRoleConfig: () => {},
    invalidateConfigCache: () => {},
    configStore: { load: () => ({}) },
  },
});

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    short: (text: unknown, max: number) => {
      const s = typeof text === 'string' ? text : '';
      return s.length > max ? `${s.slice(0, max)}...` : s;
    },
    request: mockRequest,
    normalizeTask: (item: unknown, fallbackOwner = 'unassigned') => {
      if (item == null || typeof item !== 'object') return null;
      const t = item as Record<string, unknown>;
      return {
        owner: (t['owner'] as string) ?? fallbackOwner,
        title: (t['title'] as string) ?? '',
        done: (t['done'] as string) ?? '',
        rationale: (t['rationale'] as string) ?? '',
      };
    },
    selectTandemPair: (_taskType: string, suggested: string, agents: string[]) => {
      if (agents.length < 2) return null;
      const follow = agents.find((a) => a !== suggested) ?? agents[1];
      return { lead: suggested, follow };
    },
  },
});

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    DefaultAgentExecutor: class {
      executeAgent = mockExecuteAgent;
    },
  },
});

mock.module('../lib/hydra-persona.ts', {
  namedExports: {
    isPersonaEnabled: () => false,
    getAgentFraming: (agent: string) => `[${agent}]`,
    getProcessLabel: (k: string) => k,
  },
});

mock.module('../lib/hydra-activity.ts', {
  namedExports: {
    pushActivity: mock.fn(() => {}),
    annotateDispatch: mock.fn((data: unknown) => data),
    annotateHandoff: () => '',
    annotateCompletion: () => '',
    getRecentActivity: () => [],
    clearActivityLog: () => {},
    formatDigestForPrompt: () => '',
    getSessionContext: () => ({ priorSessions: [] }),
    detectSituationalQuery: () => ({ isSituational: false, topic: null }),
    saveSessionSummary: () => {},
  },
});

// ── Import module under test ──────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import type needed for mock pattern
type DispatchMod = typeof import('../lib/hydra-operator-dispatch.ts');

interface MiniRoundReport {
  tasks?: unknown[];
  questions?: Array<{ to?: string; question?: string }>;
  consensus?: string | number | boolean | null;
  recommendedMode?: string | number | boolean | null;
  recommendationRationale?: string | number | boolean | null;
}

let mod: DispatchMod;

before(async () => {
  mod = await import('../lib/hydra-operator-dispatch.ts');
});

afterEach(() => {
  mockRequest.mock.resetCalls();
  mockExecuteAgent.mock.resetCalls();
});

// ── buildAgentMessage ─────────────────────────────────────────────────────────

describe('buildAgentMessage', () => {
  it('builds a message with agent label and prompt', () => {
    const result = mod.buildAgentMessage('claude', 'Fix the bug');
    assert.ok(result.includes('Fix the bug'));
    assert.ok(result.includes('Claude'));
  });

  it('includes role prompt', () => {
    const result = mod.buildAgentMessage('gemini', 'Review code');
    assert.ok(result.includes('You are gemini.'));
  });

  it('includes task rules', () => {
    const result = mod.buildAgentMessage('claude', 'Do thing');
    assert.ok(result.includes('Rule 1'));
  });

  it('includes context', () => {
    const result = mod.buildAgentMessage('claude', 'task');
    assert.ok(result.includes('[test-context]'));
  });

  it('includes handoff instruction', () => {
    const result = mod.buildAgentMessage('claude', 'task');
    assert.ok(result.includes('handoff'));
  });
});

// ── buildMiniRoundBrief ───────────────────────────────────────────────────────

describe('buildMiniRoundBrief', () => {
  it('builds brief with no report', () => {
    const result = mod.buildMiniRoundBrief('claude', 'objective', null);
    assert.ok(result.includes('objective'));
    assert.ok(result.includes('No explicit task assigned'));
  });

  it('builds brief with tasks and questions', () => {
    const report: MiniRoundReport = {
      tasks: [{ owner: 'claude', title: 'Task A', done: 'Tests pass' }],
      questions: [{ to: 'claude', question: 'What about edge case?' }],
      consensus: 'We agreed on approach A',
      recommendedMode: 'handoff',
      recommendationRationale: 'High confidence',
    };
    const result = mod.buildMiniRoundBrief('claude', 'objective', report);
    assert.ok(result.includes('Task A'));
    assert.ok(result.includes('Tests pass'));
    assert.ok(result.includes('What about edge case'));
    assert.ok(result.includes('We agreed on approach A'));
  });

  it('shows no tasks message when agent has no assigned tasks', () => {
    const report: MiniRoundReport = {
      tasks: [{ owner: 'gemini', title: 'Gemini task' }],
      questions: [],
    };
    const result = mod.buildMiniRoundBrief('claude', 'obj', report);
    assert.ok(result.includes('No explicit task assigned'));
  });

  it('handles unassigned tasks for agent', () => {
    const report: MiniRoundReport = {
      tasks: [{ owner: 'unassigned', title: 'Unassigned task' }],
      questions: [],
    };
    const result = mod.buildMiniRoundBrief('claude', 'obj', report);
    assert.ok(result.includes('Unassigned task'));
  });
});

// ── buildTandemBrief ──────────────────────────────────────────────────────────

describe('buildTandemBrief', () => {
  it('builds lead brief', () => {
    const result = mod.buildTandemBrief('claude', 'gemini', 'Fix bug', {}, 'lead');
    assert.ok(result.includes('lead'));
    assert.ok(result.includes('Fix bug'));
    assert.ok(result.includes('Gemini'));
  });

  it('builds follow brief', () => {
    const result = mod.buildTandemBrief('gemini', 'claude', 'Fix bug', {}, 'follow');
    assert.ok(result.includes('follow'));
    assert.ok(result.includes('Claude'));
  });

  it('includes context', () => {
    const result = mod.buildTandemBrief('claude', 'gemini', 'task', {}, 'lead');
    assert.ok(result.includes('[test-context]'));
  });
});

// ── shouldCrossVerify ─────────────────────────────────────────────────────────

describe('shouldCrossVerify', () => {
  it('returns true when mode is always', () => {
    const result = mod.shouldCrossVerify({ tier: 'simple' });
    assert.equal(result, true);
  });

  it('returns true for complex tier in on-complex mode', () => {
    // Our mock returns mode: 'always', so it's always true
    const result = mod.shouldCrossVerify({ tier: 'complex' });
    assert.equal(result, true);
  });
});

// ── runCrossVerification ──────────────────────────────────────────────────────

describe('runCrossVerification', () => {
  it('runs cross verification and returns result', async () => {
    const result = await mod.runCrossVerification(
      'claude',
      'some output',
      'original prompt',
      null,
      { executeAgent: mockExecuteAgent } as unknown as Parameters<
        typeof mod.runCrossVerification
      >[4],
    );
    assert.ok(result !== null);
    assert.equal(result.verifier, 'gemini');
    assert.equal(result.approved, true);
    assert.deepEqual(result.suggestions, ['improve X']);
  });

  it('runs verification when verifier differs from producer', async () => {
    // Default getVerifier returns 'gemini' for 'claude', so verification proceeds
    const result = await mod.runCrossVerification('claude', 'output', 'prompt', null, {
      executeAgent: mock.fn(async () => ({ ok: true, output: '{}', stdout: '{}' })),
    } as unknown as Parameters<typeof mod.runCrossVerification>[4]);
    assert.ok(result !== null);
  });

  it('returns null when executor fails', async () => {
    const failExecutor = {
      executeAgent: mock.fn(async () => ({
        ok: false,
        output: '',
        stdout: '',
        stderr: 'failed',
        error: 'timeout',
      })),
    };
    const result = await mod.runCrossVerification(
      'claude',
      'output',
      'prompt',
      null,
      failExecutor as unknown as Parameters<typeof mod.runCrossVerification>[4],
    );
    assert.equal(result, null);
  });

  it('returns null on unparseable JSON', async () => {
    const badJsonExecutor = {
      executeAgent: mock.fn(async () => ({
        ok: true,
        output: 'not json at all',
        stdout: 'not json at all',
        stderr: '',
        error: '',
      })),
    };
    const result = await mod.runCrossVerification(
      'claude',
      'output',
      'prompt',
      null,
      badJsonExecutor as unknown as Parameters<typeof mod.runCrossVerification>[4],
    );
    assert.equal(result, null);
  });

  it('includes spec content when provided', async () => {
    await mod.runCrossVerification('claude', 'output', 'prompt', 'spec content here', {
      executeAgent: mockExecuteAgent,
    } as unknown as Parameters<typeof mod.runCrossVerification>[4]);
    const call = mockExecuteAgent.mock.calls.at(-1);
    const promptArg = call?.arguments[1] as string;
    assert.ok(promptArg.includes('spec content here'));
  });

  it('extracts JSON from wrapped output', async () => {
    const wrappedJsonExecutor = {
      executeAgent: mock.fn(async () => ({
        ok: true,
        output: 'Here is my review:\n{"approved": false, "issues": ["bug"], "suggestions": []}',
        stdout: 'Here is my review:\n{"approved": false, "issues": ["bug"], "suggestions": []}',
        stderr: '',
        error: '',
      })),
    };
    const result = await mod.runCrossVerification(
      'claude',
      'output',
      'prompt',
      null,
      wrappedJsonExecutor as unknown as Parameters<typeof mod.runCrossVerification>[4],
    );
    assert.ok(result !== null);
    assert.equal(result.approved, false);
    assert.deepEqual(result.issues, ['bug']);
  });
});

// ── dispatchPrompt ────────────────────────────────────────────────────────────

describe('dispatchPrompt', () => {
  it('dispatches to multiple agents', async () => {
    const result = await mod.dispatchPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      agents: ['claude', 'gemini'],
      promptText: 'Fix the bug',
    });
    assert.equal(result.length, 2);
    assert.equal(result[0].agent, 'claude');
    assert.equal(result[1].agent, 'gemini');
    assert.ok(result[0].summary.includes('Fix the bug'));
  });

  it('creates handoff for each agent', async () => {
    await mod.dispatchPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'task',
    });
    assert.equal(mockRequest.mock.callCount(), 1);
    const call = mockRequest.mock.calls[0];
    assert.equal(call.arguments[0], 'POST');
    assert.equal(call.arguments[2], '/handoff');
  });
});

// ── publishFastPathDelegation ─────────────────────────────────────────────────

describe('publishFastPathDelegation', () => {
  it('creates task and handoff', async () => {
    const result = await mod.publishFastPathDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'Implement feature',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.9,
        reason: 'Best fit',
      },
    });
    assert.ok(result.task);
    assert.ok(result.handoff);
    assert.equal(result.agent, 'claude');
  });

  it('overrides agent when not in allowed agents list', async () => {
    const result = await mod.publishFastPathDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'task',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.5,
        reason: 'default',
      },
      agents: ['gemini', 'codex'],
    });
    // Should pick best affinity from allowed agents
    assert.ok(['gemini', 'codex'].includes(result.agent));
  });

  it('keeps suggested agent when in allowed list', async () => {
    const result = await mod.publishFastPathDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'task',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.9,
        reason: 'fit',
      },
      agents: ['claude', 'gemini'],
    });
    assert.equal(result.agent, 'claude');
  });
});

// ── publishMiniRoundDelegation ────────────────────────────────────────────────

describe('publishMiniRoundDelegation', () => {
  it('creates tasks and handoffs for all agents', async () => {
    const result = await mod.publishMiniRoundDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      agents: ['claude', 'gemini'],
      promptText: 'Plan feature',
      report: {
        tasks: [
          { owner: 'claude', title: 'Plan' },
          { owner: 'gemini', title: 'Review' },
        ],
        consensus: 'Agreed',
        recommendedMode: 'handoff',
        recommendationRationale: 'High confidence',
      },
    });
    assert.ok(result.decision);
    assert.ok(result.tasks.length > 0);
    assert.ok(result.handoffs.length > 0);
  });

  it('generates fallback tasks when report has none', async () => {
    const result = await mod.publishMiniRoundDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      agents: ['claude'],
      promptText: 'Do thing',
      report: null,
    });
    assert.ok(result.tasks.length > 0);
  });

  it('omits council metadata from decision payload when report is null', async () => {
    mockRequest.mock.resetCalls();
    await mod.publishMiniRoundDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      agents: ['claude'],
      promptText: 'Null report test',
      report: null,
    });
    // Find the /decision call among all request() calls
    const decisionCall = mockRequest.mock.calls.find((call) => call.arguments[2] === '/decision');
    assert.ok(decisionCall, 'Expected a /decision request call');
    const payload = decisionCall.arguments[3] as Record<string, unknown>;
    assert.equal(
      payload['councilParticipants'],
      undefined,
      'councilParticipants must be omitted when report is null',
    );
    assert.equal(
      payload['councilTransitions'],
      undefined,
      'councilTransitions must be omitted when report is null',
    );
    assert.equal(
      payload['councilFinalOutcome'],
      undefined,
      'councilFinalOutcome must be omitted when report is null',
    );
    assert.equal(
      payload['councilStatus'],
      undefined,
      'councilStatus must be omitted when report is null',
    );
  });

  it('includes council metadata in decision payload when report is provided', async () => {
    mockRequest.mock.resetCalls();
    await mod.publishMiniRoundDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      agents: ['claude', 'gemini'],
      promptText: 'Real report test',
      report: {
        tasks: [{ owner: 'claude', title: 'Implement' }],
        consensus: 'All agreed',
        recommendedMode: 'handoff',
        recommendationRationale: 'Straightforward task',
      },
    });
    const decisionCall = mockRequest.mock.calls.find((call) => call.arguments[2] === '/decision');
    assert.ok(decisionCall, 'Expected a /decision request call');
    const payload = decisionCall.arguments[3] as Record<string, unknown>;
    assert.ok(
      Array.isArray(payload['councilParticipants']),
      'councilParticipants should be present when report exists',
    );
    assert.ok(
      Array.isArray(payload['councilTransitions']),
      'councilTransitions should be present when report exists',
    );
    assert.equal(payload['councilStatus'], 'completed');
    assert.ok(
      typeof payload['councilFinalOutcome'] === 'string',
      'councilFinalOutcome should be a string when report exists',
    );
  });
});

// ── publishTandemDelegation ───────────────────────────────────────────────────

describe('publishTandemDelegation', () => {
  it('creates lead and follow tasks and handoffs', async () => {
    const result = await mod.publishTandemDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'Build feature',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.9,
        reason: 'best',
        tandemPair: { lead: 'claude', follow: 'gemini' },
      },
    });
    assert.ok(result.tasks);
    assert.ok(result.handoffs);
    assert.equal(result.lead, 'claude');
    assert.equal(result.follow, 'gemini');
  });

  it('falls back to fast path when tandem not viable', async () => {
    const result = await mod.publishTandemDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'task',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.5,
        reason: 'only one',
        tandemPair: null,
      },
      agents: ['claude'],
    });
    // With only 1 agent, selectTandemPair returns null, falls back to fast-path
    assert.ok(result.agent);
  });

  it('uses selectTandemPair when agents provided', async () => {
    const result = await mod.publishTandemDelegation({
      baseUrl: 'http://localhost:4173',
      from: 'human',
      promptText: 'task',
      classification: {
        taskType: 'code',
        suggestedAgent: 'claude',
        confidence: 0.9,
        reason: 'fit',
      },
      agents: ['claude', 'gemini'],
    });
    assert.equal(result.lead, 'claude');
    assert.equal(result.follow, 'gemini');
  });
});
