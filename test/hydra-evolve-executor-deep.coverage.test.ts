/**
 * Deep coverage tests for lib/hydra-evolve-executor.ts
 *
 * Uses mock.module() to mock all I/O dependencies so we can exercise
 * the phase functions (phaseResearch, phaseDeliberate, phasePlan,
 * phaseTest, phaseImplement, phaseAnalyze) and the retry/error handling
 * logic (executeAgent, executeAgentWithRetry) without spawning real
 * agent processes.
 *
 * Run: node --test --experimental-test-module-mocks test/hydra-evolve-executor-deep.coverage.test.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-return -- test mocking */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies BEFORE importing the target module ─────────────────

const mockSharedExecuteAgent = mock.fn(async (_agent: string, _prompt: string, _opts?: any) => ({
  ok: true,
  output: '{"result": "mock output"}',
  stderr: '',
  error: null as string | null,
  durationMs: 1234,
  timedOut: false,
  exitCode: 0 as number | null,
  signal: null as string | null,
}));

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgent: mockSharedExecuteAgent,
  },
});

const mockSetAgentActivity = mock.fn();
mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    setAgentActivity: mockSetAgentActivity,
  },
});

const mockLoadHydraConfig = mock.fn(() => ({
  rateLimits: { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100 },
  evolve: { investigator: { maxAttemptsPerPhase: 2 } },
  routing: { mode: 'balanced' },
}));
mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
    resolveProject: mock.fn(() => ({
      projectRoot: '/tmp/test-project',
      projectName: 'test',
    })),
  },
});

const mockGetAgent: any = mock.fn((name: string) => ({
  name,
  displayName: name,
  type: 'physical',
  features: { jsonOutput: name === 'codex' },
  strengths: [],
  tags: [],
  enabled: true,
}));
mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getAgent: mockGetAgent,
  },
});

const mockIsInvestigatorAvailable = mock.fn(() => false);
const mockInvestigate = mock.fn(async () => ({
  diagnosis: 'fixable' as string,
  explanation: 'test fix' as string,
  corrective: 'try again' as string | null,
  retryRecommendation: {
    retryPhase: true as boolean,
    retryAgent: null as string | null,
    modifiedPrompt: null as string | null,
    preamble: 'correction preamble' as string | null,
  },
}));
mock.module('../lib/hydra-evolve-investigator.ts', {
  namedExports: {
    isInvestigatorAvailable: mockIsInvestigatorAvailable,
    investigate: mockInvestigate,
  },
});

const mockGetPriorLearnings = mock.fn((): any[] => []);
const mockFormatStatsForPrompt = mock.fn(() => 'KB stats: 0 entries');
mock.module('../lib/hydra-evolve-knowledge.ts', {
  namedExports: {
    getPriorLearnings: mockGetPriorLearnings,
    formatStatsForPrompt: mockFormatStatsForPrompt,
    loadKnowledgeBase: mock.fn(() => ({ entries: [] })),
  },
});

const mockEnsureDir = mock.fn();
const mockParseJsonLoose = mock.fn((s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
});
const mockRunProcess = mock.fn(() => ({
  ok: true,
  stdout: 'tests passed',
  stderr: '',
}));
const mockParseTestOutput = mock.fn(() => ({
  total: 5,
  passed: 5,
  failed: 0,
  skipped: 0,
  durationMs: 1000,
  failures: [] as any[],
}));
mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    ensureDir: mockEnsureDir,
    parseJsonLoose: mockParseJsonLoose,
    runProcess: mockRunProcess,
    parseTestOutput: mockParseTestOutput,
  },
});

const mockBuildAgentContext = mock.fn(() => 'mock project context');
mock.module('../lib/hydra-context.ts', {
  namedExports: {
    buildAgentContext: mockBuildAgentContext,
  },
});

const mockDetectModelError = mock.fn(() => ({ isModelError: false }));
const mockDetectCodexError = mock.fn(() => ({ isCodexError: false }));
const mockRecoverFromModelError = mock.fn(async () => ({ recovered: false }));
const mockDetectRateLimitError = mock.fn(() => ({ isRateLimit: false }));
const mockDetectUsageLimitError = mock.fn(() => ({ isUsageLimit: false }));
const mockFormatResetTime = mock.fn(() => '5m');
const mockCalculateBackoff = mock.fn(() => 10);
const mockVerifyAgentQuota = mock.fn(async () => ({ verified: false as boolean | string }));
mock.module('../lib/hydra-model-recovery.ts', {
  namedExports: {
    detectModelError: mockDetectModelError,
    detectCodexError: mockDetectCodexError,
    recoverFromModelError: mockRecoverFromModelError,
    detectRateLimitError: mockDetectRateLimitError,
    detectUsageLimitError: mockDetectUsageLimitError,
    formatResetTime: mockFormatResetTime,
    calculateBackoff: mockCalculateBackoff,
    verifyAgentQuota: mockVerifyAgentQuota,
  },
});

// Mock hydra-env (imported by transitive deps)
mock.module('../lib/hydra-env.ts', {
  namedExports: {
    envFileExists: mock.fn(() => false),
  },
});

// Mock hydra-doctor (lazy imported)
mock.module('../lib/hydra-doctor.ts', {
  namedExports: {
    isDoctorEnabled: mock.fn(() => false),
    diagnose: mock.fn(),
  },
});

// Mock fs.writeFileSync for plan artifact saving
const mockWriteFileSync = mock.fn();
mock.module('node:fs', {
  defaultExport: {
    writeFileSync: mockWriteFileSync,
    readFileSync: mock.fn(() => ''),
    existsSync: mock.fn(() => false),
    mkdirSync: mock.fn(),
    readdirSync: mock.fn(() => []),
    statSync: mock.fn(() => ({ isFile: () => true, isDirectory: () => false })),
  },
  namedExports: {
    writeFileSync: mockWriteFileSync,
    readFileSync: mock.fn(() => ''),
    existsSync: mock.fn(() => false),
    mkdirSync: mock.fn(),
    readdirSync: mock.fn(() => []),
    statSync: mock.fn(() => ({ isFile: () => true, isDirectory: () => false })),
  },
});

// ── Import target module AFTER mocking ───────────────────────────────────

const {
  formatDuration,
  DEFAULT_PHASE_TIMEOUTS,
  disabledAgents,
  executeAgent,
  executeAgentWithRetry,
  sessionInvestigations,
  recordInvestigation,
  phaseResearch,
  phaseDeliberate,
  phasePlan,
  phaseTest,
  phaseImplement,
  phaseAnalyze,
} = await import('../lib/hydra-evolve-executor.ts');

// ── Test helpers ─────────────────────────────────────────────────────────

function resetAllMocks() {
  // Reset call counts
  mockSharedExecuteAgent.mock.resetCalls();
  mockSetAgentActivity.mock.resetCalls();
  mockLoadHydraConfig.mock.resetCalls();
  mockGetAgent.mock.resetCalls();
  mockIsInvestigatorAvailable.mock.resetCalls();
  mockInvestigate.mock.resetCalls();
  mockGetPriorLearnings.mock.resetCalls();
  mockFormatStatsForPrompt.mock.resetCalls();
  mockEnsureDir.mock.resetCalls();
  mockParseJsonLoose.mock.resetCalls();
  mockRunProcess.mock.resetCalls();
  mockParseTestOutput.mock.resetCalls();
  mockBuildAgentContext.mock.resetCalls();
  mockDetectModelError.mock.resetCalls();
  mockDetectCodexError.mock.resetCalls();
  mockDetectRateLimitError.mock.resetCalls();
  mockDetectUsageLimitError.mock.resetCalls();
  mockVerifyAgentQuota.mock.resetCalls();
  mockWriteFileSync.mock.resetCalls();

  // Restore default implementations (important: mockImplementation is sticky)
  mockSharedExecuteAgent.mock.mockImplementation(async () => ({ ...defaultOkResult }));
  mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
  mockDetectRateLimitError.mock.mockImplementation(() => ({ isRateLimit: false }));
  mockDetectModelError.mock.mockImplementation(() => ({ isModelError: false }));
  mockDetectCodexError.mock.mockImplementation(() => ({ isCodexError: false }));
  mockIsInvestigatorAvailable.mock.mockImplementation(() => false);
  mockGetAgent.mock.mockImplementation((name: string) => ({
    name,
    displayName: name,
    type: 'physical',
    features: { jsonOutput: name === 'codex' },
    strengths: [],
    tags: [],
    enabled: true,
  }));
  mockParseJsonLoose.mock.mockImplementation((s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  });
  mockRunProcess.mock.mockImplementation(() => ({
    ok: true,
    stdout: 'tests passed',
    stderr: '',
  }));
  mockParseTestOutput.mock.mockImplementation(() => ({
    total: 5,
    passed: 5,
    failed: 0,
    skipped: 0,
    durationMs: 1000,
    failures: [],
  }));
  mockGetPriorLearnings.mock.mockImplementation(() => []);

  // Reset disabled agents
  disabledAgents.clear();
  // Reset session investigations
  sessionInvestigations.count = 0;
  sessionInvestigations.healed = 0;
  sessionInvestigations.diagnoses.length = 0;
}

const defaultOkResult = {
  ok: true,
  output: '{"result": "mock output"}',
  stderr: '',
  error: null,
  durationMs: 1234,
  timedOut: false,
  exitCode: 0,
  signal: null,
};

const defaultFailResult = {
  ok: false,
  output: '',
  stderr: 'some error',
  error: 'agent failed',
  durationMs: 5000,
  timedOut: false,
  exitCode: 1,
  signal: null,
};

// ── formatDuration (deep) ────────────────────────────────────────────────

describe('formatDuration (deep)', () => {
  it('returns "0s" for zero milliseconds', () => {
    assert.equal(formatDuration(0), '0s');
  });

  it('formats seconds correctly', () => {
    assert.equal(formatDuration(1000), '1s');
    assert.equal(formatDuration(30_000), '30s');
    assert.equal(formatDuration(59_000), '59s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(60_000), '1m 0s');
    assert.equal(formatDuration(90_000), '1m 30s');
    assert.equal(formatDuration(3599_000), '59m 59s');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatDuration(3600_000), '1h 0m');
    assert.equal(formatDuration(7200_000), '2h 0m');
    assert.equal(formatDuration(5400_000), '1h 30m');
  });
});

// ── DEFAULT_PHASE_TIMEOUTS ───────────────────────────────────────────────

describe('DEFAULT_PHASE_TIMEOUTS (deep)', () => {
  it('has six phase timeout keys', () => {
    assert.equal(Object.keys(DEFAULT_PHASE_TIMEOUTS).length, 6);
  });

  it('implement timeout is the longest', () => {
    const max = Math.max(...Object.values(DEFAULT_PHASE_TIMEOUTS));
    assert.equal(DEFAULT_PHASE_TIMEOUTS.implementTimeoutMs, max);
  });
});

// ── disabledAgents ───────────────────────────────────────────────────────

describe('disabledAgents', () => {
  beforeEach(() => {
    disabledAgents.clear();
  });

  it('is a mutable Set', () => {
    assert.ok(disabledAgents instanceof Set);
  });

  it('can add and check agents', () => {
    disabledAgents.add('claude');
    assert.ok(disabledAgents.has('claude'));
    assert.ok(!disabledAgents.has('gemini'));
  });
});

// ── sessionInvestigations / recordInvestigation ──────────────────────────

describe('recordInvestigation (deep)', () => {
  beforeEach(() => {
    sessionInvestigations.count = 0;
    sessionInvestigations.healed = 0;
    sessionInvestigations.diagnoses.length = 0;
  });

  it('increments count and stores diagnosis', () => {
    recordInvestigation('test-phase', {
      diagnosis: 'fixable',
      explanation: 'test explanation',
    });
    assert.equal(sessionInvestigations.count, 1);
    assert.equal(sessionInvestigations.diagnoses.length, 1);
    assert.equal(sessionInvestigations.diagnoses[0].phase, 'test-phase');
    assert.equal(sessionInvestigations.diagnoses[0].diagnosis, 'fixable');
  });

  it('increments healed count for fixable with retryPhase', () => {
    recordInvestigation('test-phase', {
      diagnosis: 'fixable',
      explanation: 'fixable issue',
      retryRecommendation: { retryPhase: true },
    });
    assert.equal(sessionInvestigations.healed, 1);
  });

  it('increments healed count for transient with retryPhase', () => {
    recordInvestigation('test-phase', {
      diagnosis: 'transient',
      explanation: 'transient issue',
      retryRecommendation: { retryPhase: true },
    });
    assert.equal(sessionInvestigations.healed, 1);
  });

  it('does not increment healed for fundamental diagnosis', () => {
    recordInvestigation('test-phase', {
      diagnosis: 'fundamental',
      explanation: 'fundamental issue',
      retryRecommendation: { retryPhase: true },
    });
    assert.equal(sessionInvestigations.healed, 0);
  });

  it('does not increment healed when retryPhase is false', () => {
    recordInvestigation('test-phase', {
      diagnosis: 'fixable',
      explanation: 'fixable issue',
      retryRecommendation: { retryPhase: false },
    });
    assert.equal(sessionInvestigations.healed, 0);
  });

  it('accumulates multiple investigations', () => {
    recordInvestigation('phase1', { diagnosis: 'fixable', explanation: 'e1' });
    recordInvestigation('phase2', { diagnosis: 'fundamental', explanation: 'e2' });
    recordInvestigation('phase3', {
      diagnosis: 'transient',
      explanation: 'e3',
      retryRecommendation: { retryPhase: true },
    });
    assert.equal(sessionInvestigations.count, 3);
    assert.equal(sessionInvestigations.healed, 1);
    assert.equal(sessionInvestigations.diagnoses.length, 3);
  });
});

// ── executeAgent ─────────────────────────────────────────────────────────

describe('executeAgent (local wrapper)', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('calls shared executeAgent with progress callbacks', async () => {
    const result = await executeAgent('claude', 'test prompt');
    assert.ok(result.ok);
    assert.equal(mockSharedExecuteAgent.mock.callCount(), 1);
    const callArgs = mockSharedExecuteAgent.mock.calls[0].arguments;
    assert.equal(callArgs[0], 'claude');
    assert.equal(callArgs[1], 'test prompt');
    // Should have onProgress and onStatusBar callbacks
    assert.ok(typeof callArgs[2].onProgress === 'function');
    assert.ok(typeof callArgs[2].onStatusBar === 'function');
  });

  it('passes phaseLabel in options', async () => {
    await executeAgent('gemini', 'test prompt', { phaseLabel: 'research: area' });
    const callArgs = mockSharedExecuteAgent.mock.calls[0].arguments;
    assert.equal(callArgs[2].phaseLabel, 'research: area');
  });

  it('onProgress callback writes to stderr', async () => {
    await executeAgent('claude', 'test');
    const opts = mockSharedExecuteAgent.mock.calls[0].arguments[2];
    // Should not throw when called
    opts.onProgress(5000, 10, 'running');
    opts.onProgress(5000, 0, '');
  });

  it('onStatusBar callback sets agent activity', async () => {
    await executeAgent('claude', 'test');
    const opts = mockSharedExecuteAgent.mock.calls[0].arguments[2];
    opts.onStatusBar('claude', { step: 'running', phase: 'research' });
    assert.equal(mockSetAgentActivity.mock.callCount(), 1);
    assert.equal(mockSetAgentActivity.mock.calls[0].arguments[0], 'claude');
    assert.equal(mockSetAgentActivity.mock.calls[0].arguments[1], 'working');

    mockSetAgentActivity.mock.resetCalls();
    opts.onStatusBar('claude', { step: 'done', phase: 'research' });
    assert.equal(mockSetAgentActivity.mock.calls[0].arguments[1], 'idle');
  });
});

// ── executeAgentWithRetry ────────────────────────────────────────────────

describe('executeAgentWithRetry', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('returns immediately for disabled agents', async () => {
    disabledAgents.add('claude');
    const result = await executeAgentWithRetry('claude', 'test');
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.error!, /disabled for session/);
    assert.equal(mockSharedExecuteAgent.mock.callCount(), 0);
  });

  it('returns successful result directly', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);
    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
    assert.equal(mockSharedExecuteAgent.mock.callCount(), 1);
  });

  it('returns timed out result without retry', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultFailResult,
      timedOut: true,
    }));
    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(!result.ok);
    assert.ok(result.timedOut);
  });

  it('handles usage limit - verified true', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);
    mockDetectUsageLimitError.mock.mockImplementationOnce(() => ({
      isUsageLimit: true,
      errorMessage: 'usage limit exceeded',
      resetInSeconds: 300,
    }));
    mockVerifyAgentQuota.mock.mockImplementationOnce(async () => ({ verified: true }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.equal(result.usageLimited, true);
    assert.equal(result.usageLimitConfirmed, true);
    assert.ok(disabledAgents.has('claude'));
  });

  it('handles usage limit - false positive (verified false)', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);
    mockDetectUsageLimitError.mock.mockImplementationOnce(() => ({
      isUsageLimit: true,
      errorMessage: 'usage limit exceeded',
      resetInSeconds: 300,
    }));
    mockVerifyAgentQuota.mock.mockImplementationOnce(async () => ({
      verified: false,
      reason: 'account active',
    }));
    // It will fall through to blind retry since no other handler catches
    // Need to mock the second executeAgent call too
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    const result = await executeAgentWithRetry('claude', 'test');
    assert.equal(result.usageLimitFalsePositive, undefined); // returned from blind retry
  });

  it('handles usage limit - structured JSONL from codex', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultFailResult,
      errorCategory: 'codex-jsonl-error',
    }));
    mockDetectUsageLimitError.mock.mockImplementationOnce(() => ({
      isUsageLimit: true,
      errorMessage: 'codex usage limit',
      resetInSeconds: 600,
    }));
    mockVerifyAgentQuota.mock.mockImplementationOnce(async () => ({
      verified: 'unknown',
      reason: 'no API key',
    }));

    const result = await executeAgentWithRetry('codex', 'test');
    assert.equal(result.usageLimited, true);
    assert.equal(result.usageLimitStructured, true);
    assert.ok(disabledAgents.has('codex'));
  });

  it('handles rate limit with retries', async () => {
    // First call fails
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);
    mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
    mockDetectRateLimitError.mock.mockImplementationOnce(() => ({
      isRateLimit: true,
      errorMessage: 'rate limited',
      retryAfterMs: 10,
    }));
    // Retry succeeds
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
  });

  it('handles rate limit - exhausted retries', async () => {
    mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
    mockDetectRateLimitError.mock.mockImplementation(() => ({
      isRateLimit: true,
      errorMessage: 'rate limited',
      retryAfterMs: 10,
    }));
    // All calls fail with rate limit
    mockSharedExecuteAgent.mock.mockImplementation(async () => defaultFailResult);

    const result = await executeAgentWithRetry('claude', 'test');
    assert.equal(result.rateLimited, true);
    assert.ok(disabledAgents.has('claude'));
  });

  it('handles model error with recovery', async () => {
    let callNum = 0;
    mockSharedExecuteAgent.mock.mockImplementation(async () => {
      callNum++;
      return callNum === 1 ? { ...defaultFailResult } : { ...defaultOkResult };
    });
    mockDetectModelError.mock.mockImplementationOnce(() => ({
      isModelError: true,
      errorMessage: 'model not found',
      failedModel: 'old-model',
    }));
    mockRecoverFromModelError.mock.mockImplementationOnce(async () => ({
      recovered: true,
      newModel: 'fallback-model',
    }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
    assert.equal(result.recovered, true);
    assert.equal(result.originalModel, 'old-model');
    assert.equal(result.newModel, 'fallback-model');
  });

  it('handles model error without recovery - disables agent', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);
    mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
    mockDetectRateLimitError.mock.mockImplementation(() => ({ isRateLimit: false }));
    mockDetectModelError.mock.mockImplementationOnce(() => ({
      isModelError: true,
      errorMessage: 'model not found',
      failedModel: 'old-model',
    }));
    mockRecoverFromModelError.mock.mockImplementationOnce(async () => ({
      recovered: false,
    }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(!result.ok);
    assert.ok(disabledAgents.has('claude'));
  });

  it('handles codex JSONL error (non-retryable category)', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);
    mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
    mockDetectRateLimitError.mock.mockImplementation(() => ({ isRateLimit: false }));
    mockDetectModelError.mock.mockImplementation(() => ({ isModelError: false }));
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'codex',
      features: { jsonOutput: true },
    }));
    mockDetectCodexError.mock.mockImplementationOnce(() => ({
      isCodexError: true,
      category: 'auth',
      errorMessage: 'auth error',
    }));

    const result = await executeAgentWithRetry('codex', 'test');
    assert.ok(!result.ok);
    assert.ok(disabledAgents.has('codex'));
  });

  it('handles codex startup failure', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultFailResult,
      startupFailure: true,
      durationMs: 2000,
      errorDetail: 'something went wrong',
      args: ['--model', 'bad-model'],
    }));
    mockDetectUsageLimitError.mock.mockImplementation(() => ({ isUsageLimit: false }));
    mockDetectRateLimitError.mock.mockImplementation(() => ({ isRateLimit: false }));
    mockDetectModelError.mock.mockImplementation(() => ({ isModelError: false }));
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'codex',
      features: { jsonOutput: true },
    }));
    mockDetectCodexError.mock.mockImplementationOnce(() => ({
      isCodexError: true,
      category: 'internal',
      errorMessage: '',
    }));

    const result = await executeAgentWithRetry('codex', 'test');
    assert.equal(result.startupFailureDisabled, true);
    assert.ok(disabledAgents.has('codex'));
  });

  it('uses investigator-guided retry when available', async () => {
    let callNum = 0;
    mockSharedExecuteAgent.mock.mockImplementation(async () => {
      callNum++;
      return callNum === 1 ? { ...defaultFailResult } : { ...defaultOkResult };
    });
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'claude',
      features: { jsonOutput: false },
    }));
    mockIsInvestigatorAvailable.mock.mockImplementation(() => true);
    mockInvestigate.mock.mockImplementationOnce(async () => ({
      diagnosis: 'fixable',
      explanation: 'prompt issue',
      corrective: null,
      retryRecommendation: {
        retryPhase: true,
        retryAgent: null,
        modifiedPrompt: 'modified prompt text',
        preamble: null,
      },
    }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
    assert.ok(result.investigation);
  });

  it('investigator says fundamental - disables agent', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({ ...defaultFailResult }));
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'claude',
      features: { jsonOutput: false },
    }));
    mockIsInvestigatorAvailable.mock.mockImplementation(() => true);
    mockInvestigate.mock.mockImplementationOnce(async () => ({
      diagnosis: 'fundamental',
      explanation: 'cannot fix',
      corrective: null,
      retryRecommendation: {
        retryPhase: false,
        retryAgent: null,
        modifiedPrompt: null,
        preamble: null,
      },
    }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(!result.ok);
    assert.ok(disabledAgents.has('claude'));
  });

  it('blind retry on failure when investigator unavailable', async () => {
    let callNum = 0;
    mockSharedExecuteAgent.mock.mockImplementation(async () => {
      callNum++;
      return callNum === 1 ? { ...defaultFailResult } : { ...defaultOkResult };
    });
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'claude',
      features: { jsonOutput: false },
    }));
    mockIsInvestigatorAvailable.mock.mockImplementation(() => false);

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
  });

  it('blind retry failure disables agent', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({ ...defaultFailResult }));
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'claude',
      features: { jsonOutput: false },
    }));
    mockIsInvestigatorAvailable.mock.mockImplementation(() => false);

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(!result.ok);
    assert.ok(disabledAgents.has('claude'));
  });

  it('investigator retry with alternative agent', async () => {
    let callNum = 0;
    const agentsCalled: string[] = [];
    mockSharedExecuteAgent.mock.mockImplementation(async (agent: string) => {
      callNum++;
      agentsCalled.push(agent);
      return callNum === 1 ? { ...defaultFailResult } : { ...defaultOkResult };
    });
    mockGetAgent.mock.mockImplementation(() => ({
      name: 'claude',
      features: { jsonOutput: false },
    }));
    mockIsInvestigatorAvailable.mock.mockImplementation(() => true);
    mockInvestigate.mock.mockImplementationOnce(async () => ({
      diagnosis: 'fixable',
      explanation: 'agent issue',
      corrective: null,
      retryRecommendation: {
        retryPhase: true,
        retryAgent: 'gemini',
        modifiedPrompt: null,
        preamble: 'try different approach',
      },
    }));

    const result = await executeAgentWithRetry('claude', 'test');
    assert.ok(result.ok);
    // Verify gemini was called as the retry agent
    assert.equal(agentsCalled[1], 'gemini');
  });
});

// ── phaseResearch ────────────────────────────────────────────────────────

describe('phaseResearch', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('dispatches research to three agents in parallel', async () => {
    const jsonResponse = JSON.stringify({
      area: 'testing-reliability',
      findings: ['finding1'],
      applicableIdeas: ['idea1'],
      sources: [],
    });
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: jsonResponse,
    }));
    mockParseJsonLoose.mock.mockImplementation((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });

    const result = await phaseResearch('testing-reliability', { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      evolveDir: '/tmp/evolve',
    });

    assert.equal(result.area, 'testing-reliability');
    // Three agents called
    assert.ok(mockSharedExecuteAgent.mock.callCount() >= 3);
    assert.ok(mockEnsureDir.mock.callCount() >= 1);
  });

  it('handles prior learnings in context', async () => {
    mockGetPriorLearnings.mock.mockImplementationOnce(() => [
      { outcome: 'success', finding: 'prior finding' },
    ]);
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: '{}',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => ({}));

    const result = await phaseResearch('testing-reliability', { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      evolveDir: '/tmp/evolve',
    });

    assert.equal(result.area, 'testing-reliability');
  });

  it('uses fallback search queries for unknown areas', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: '{}',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => ({}));

    const result = await phaseResearch('unknown-custom-area', { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      evolveDir: '/tmp/evolve',
    });

    assert.equal(result.area, 'unknown-custom-area');
    // Should have called agents with fallback queries
    const firstPrompt = mockSharedExecuteAgent.mock.calls[0].arguments[1];
    assert.ok(firstPrompt.includes('unknown-custom-area'));
  });

  it('gracefully handles agent failures', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultFailResult,
      output: '',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseResearch('testing-reliability', { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      evolveDir: '/tmp/evolve',
    });

    assert.equal(result.area, 'testing-reliability');
    // Should still return a valid structure with empty findings
    assert.ok(result.claudeFindings);
    assert.ok(result.geminiFindings);
    assert.ok(result.codexFindings);
  });
});

// ── phaseDeliberate ──────────────────────────────────────────────────────

describe('phaseDeliberate', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  const fakeResearch = {
    area: 'testing-reliability',
    claudeFindings: { findings: ['finding1'], applicableIdeas: ['idea1'], sources: [] },
    geminiFindings: { findings: ['finding2'], applicableIdeas: ['idea2'], sources: [] },
    codexFindings: {
      existingPatterns: ['pattern1'],
      gaps: ['gap1'],
      implementationIdeas: ['impl1'],
      relevantFiles: [],
    },
  };

  it('runs four deliberation steps in sequence', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: JSON.stringify({
        suggestedImprovement: 'test improvement',
        selectedImprovement: 'test improvement',
      }),
    }));
    mockParseJsonLoose.mock.mockImplementation((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });

    const result = await phaseDeliberate(fakeResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    assert.ok(result.selectedImprovement);
    assert.notEqual(result.selectedImprovement, 'No improvement selected');
    // Should have called executeAgent for synthesize + critique + feasibility + prioritize
    assert.ok(mockSharedExecuteAgent.mock.callCount() >= 4);
  });

  it('falls back to research findings when deliberation fails', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultFailResult,
      output: '',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseDeliberate(fakeResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    // Should fall back to research finding
    assert.equal(result.selectedImprovement, 'idea1');
  });

  it('uses "No improvement selected" when all fails', async () => {
    const emptyResearch = {
      area: 'testing-reliability',
      claudeFindings: { findings: [], applicableIdeas: [], sources: [] },
      geminiFindings: { findings: [], applicableIdeas: [], sources: [] },
      codexFindings: { existingPatterns: [], gaps: [], implementationIdeas: [], relevantFiles: [] },
    };
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultFailResult,
      output: '',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseDeliberate(emptyResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    assert.equal(result.selectedImprovement, 'No improvement selected');
  });

  it('uses labeled text extraction fallback when JSON parse fails', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: 'Improvement: Add better error handling for agent timeouts in the dispatch pipeline',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseDeliberate(fakeResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    // Should extract from labeled text
    assert.ok(result.selectedImprovement);
  });

  it('uses substantial sentence fallback when no labeled line found', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output:
        'This is a substantial sentence describing the improvement that should be extracted as fallback text',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseDeliberate(fakeResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    assert.ok(result.selectedImprovement);
    assert.notEqual(result.selectedImprovement, 'No improvement selected');
  });

  it('returns null improvement text when only JSON fragments found', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: '{ broken json\n[array\n```code',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);

    const result = await phaseDeliberate(fakeResearch, { entries: [] } as never, {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    // Should fall back to research findings since text extraction finds nothing useful
    assert.ok(result.selectedImprovement);
  });
});

// ── phasePlan ────────────────────────────────────────────────────────────

describe('phasePlan', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('creates a plan and saves spec artifact', async () => {
    const planData = {
      objectives: ['obj1'],
      constraints: ['c1'],
      acceptanceCriteria: ['ac1'],
      filesToModify: [{ path: 'lib/test.ts', changes: 'add feature' }],
      testPlan: { scenarios: ['s1'], edgeCases: ['e1'] },
      rollbackCriteria: ['r1'],
    };
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultOkResult,
      output: JSON.stringify(planData),
    }));
    mockParseJsonLoose.mock.mockImplementationOnce((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });

    const result = await phasePlan(
      { selectedImprovement: 'test improvement' },
      'testing-reliability',
      { entries: [] } as never,
      {
        cwd: '/tmp/test',
        timeouts: DEFAULT_PHASE_TIMEOUTS,
        evolveDir: '/tmp/evolve',
        roundNum: 1,
      },
    );

    assert.ok(result.plan);
    assert.ok(result.specPath.includes('ROUND_1_SPEC.md'));
    assert.ok(mockEnsureDir.mock.callCount() >= 1);
    assert.ok(mockWriteFileSync.mock.callCount() >= 1);
  });

  it('handles null plan data gracefully', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultFailResult,
      output: '',
    }));
    mockParseJsonLoose.mock.mockImplementationOnce(() => null);

    const result = await phasePlan(
      { selectedImprovement: 'test improvement' },
      'testing-reliability',
      { entries: [] } as never,
      {
        cwd: '/tmp/test',
        timeouts: DEFAULT_PHASE_TIMEOUTS,
        evolveDir: '/tmp/evolve',
        roundNum: 2,
      },
    );

    assert.equal(result.plan, null);
    assert.ok(result.specPath.includes('ROUND_2_SPEC.md'));
  });

  it('includes prior learnings when available', async () => {
    mockGetPriorLearnings.mock.mockImplementationOnce(() => [
      { outcome: 'failed', learnings: 'dont do X', finding: 'issue' },
    ]);
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => ({
      ...defaultOkResult,
      output: '{"objectives":["o1"]}',
    }));
    mockParseJsonLoose.mock.mockImplementationOnce((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });

    const result = await phasePlan(
      { selectedImprovement: 'test improvement' },
      'testing-reliability',
      { entries: [] } as never,
      {
        cwd: '/tmp/test',
        timeouts: DEFAULT_PHASE_TIMEOUTS,
        evolveDir: '/tmp/evolve',
        roundNum: 1,
      },
    );

    assert.ok(result.plan);
  });
});

// ── phaseTest ────────────────────────────────────────────────────────────

describe('phaseTest', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('dispatches test writing to codex', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    const result = await phaseTest(
      { plan: { objectives: ['o1'], acceptanceCriteria: ['ac1'] } },
      'evolve/round-1',
      'safety: do not modify protected files',
      { cwd: '/tmp/test', timeouts: DEFAULT_PHASE_TIMEOUTS },
    );

    assert.ok(result.ok);
    assert.equal(result.durationMs, 1234);
  });

  it('includes investigator preamble when provided', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    await phaseTest({ plan: null }, 'evolve/round-1', 'safety prompt', {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      investigatorPreamble: 'Fix the import paths',
    });

    const prompt = mockSharedExecuteAgent.mock.calls[0].arguments[1];
    assert.ok(prompt.includes('Investigator Guidance'));
    assert.ok(prompt.includes('Fix the import paths'));
  });

  it('reports failure result from agent', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultFailResult);

    const result = await phaseTest({ plan: null }, 'evolve/round-1', 'safety', {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
    });

    assert.ok(!result.ok);
    assert.equal(result.error, 'agent failed');
  });
});

// ── phaseImplement ───────────────────────────────────────────────────────

describe('phaseImplement', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('dispatches implementation to codex by default', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    const result = await phaseImplement(
      { plan: { objectives: ['o1'] } },
      'evolve/round-1',
      'safety prompt',
      { cwd: '/tmp/test', timeouts: DEFAULT_PHASE_TIMEOUTS },
    );

    assert.ok(result.ok);
    assert.equal(mockSharedExecuteAgent.mock.calls[0].arguments[0], 'codex');
  });

  it('uses agentOverride when provided', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    await phaseImplement({ plan: { objectives: ['o1'] } }, 'evolve/round-1', 'safety prompt', {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      agentOverride: 'claude',
    });

    assert.equal(mockSharedExecuteAgent.mock.calls[0].arguments[0], 'claude');
  });

  it('includes investigator preamble', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    await phaseImplement({ plan: { objectives: ['o1'] } }, 'evolve/round-1', 'safety prompt', {
      cwd: '/tmp/test',
      timeouts: DEFAULT_PHASE_TIMEOUTS,
      investigatorPreamble: 'Fix path issues',
    });

    const prompt = mockSharedExecuteAgent.mock.calls[0].arguments[1];
    assert.ok(prompt.includes('Investigator Guidance'));
  });

  it('includes deliberation context', async () => {
    mockSharedExecuteAgent.mock.mockImplementationOnce(async () => defaultOkResult);

    await phaseImplement(
      { plan: { objectives: ['o1'], acceptanceCriteria: ['ac1', 'ac2'] } },
      'evolve/round-1',
      'safety prompt',
      {
        cwd: '/tmp/test',
        timeouts: DEFAULT_PHASE_TIMEOUTS,
        deliberation: { selectedImprovement: 'add error handling' },
      },
    );

    const prompt = mockSharedExecuteAgent.mock.calls[0].arguments[1];
    assert.ok(prompt.includes('add error handling'));
    assert.ok(prompt.includes('ac1'));
  });
});

// ── phaseAnalyze ─────────────────────────────────────────────────────────

describe('phaseAnalyze', () => {
  beforeEach(() => {
    resetAllMocks();
  });

  it('dispatches analysis to three agents and runs tests', async () => {
    const analysisResult = JSON.stringify({
      quality: 8,
      confidence: 7,
      concerns: ['minor concern'],
      suggestions: ['suggestion1'],
      verdict: 'approve',
    });
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: analysisResult,
    }));
    mockParseJsonLoose.mock.mockImplementation((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    mockRunProcess.mock.mockImplementation(() => ({
      ok: true,
      stdout: 'tests passed',
      stderr: '',
    }));
    mockParseTestOutput.mock.mockImplementation(() => ({
      total: 5,
      passed: 5,
      failed: 0,
      skipped: 0,
      durationMs: 2000,
      failures: [],
    }));

    const result = await phaseAnalyze(
      'diff content here',
      'evolve/round-1',
      { plan: { objectives: ['o1'], acceptanceCriteria: ['ac1'] } },
      {
        cwd: '/tmp/test',
        timeouts: DEFAULT_PHASE_TIMEOUTS,
        deliberation: { selectedImprovement: 'test improvement' },
      },
    );

    assert.ok(result.testsPassed);
    assert.ok(result.aggregateScore > 0);
    assert.ok(result.aggregateConfidence > 0);
    assert.ok(Array.isArray(result.concerns));
    assert.ok(result.agentVerdicts.claude);
  });

  it('handles failed tests', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: JSON.stringify({ quality: 5, confidence: 4, concerns: [], verdict: 'revise' }),
    }));
    mockParseJsonLoose.mock.mockImplementation((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    mockRunProcess.mock.mockImplementation(() => ({
      ok: false,
      stdout: 'test output',
      stderr: 'test errors',
    }));
    mockParseTestOutput.mock.mockImplementation(() => ({
      total: 10,
      passed: 7,
      failed: 3,
      skipped: 0,
      durationMs: 3000,
      failures: [
        { name: 'test1', error: 'assertion failed' },
        { name: 'test2', error: 'timeout' },
        { name: 'test3', error: 'undefined' },
      ],
    }));

    const result = await phaseAnalyze('diff content here', 'evolve/round-1', {
      plan: { objectives: ['o1'] },
    });

    assert.ok(!result.testsPassed);
  });

  it('truncates long diffs', async () => {
    const longDiff = 'x'.repeat(10000);
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultOkResult,
      output: JSON.stringify({ quality: 7, confidence: 6, concerns: [], verdict: 'approve' }),
    }));
    mockParseJsonLoose.mock.mockImplementation((s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    });
    mockRunProcess.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    mockParseTestOutput.mock.mockImplementation(() => ({
      total: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      durationMs: 100,
      failures: [],
    }));

    await phaseAnalyze(longDiff, 'evolve/round-1', { plan: null });

    // The prompt should contain truncation marker
    const prompt = mockSharedExecuteAgent.mock.calls[0].arguments[1];
    assert.ok(prompt.includes('truncated'));
  });

  it('handles null agent analysis gracefully', async () => {
    mockSharedExecuteAgent.mock.mockImplementation(async () => ({
      ...defaultFailResult,
      output: '',
    }));
    mockParseJsonLoose.mock.mockImplementation(() => null);
    mockRunProcess.mock.mockImplementation(() => ({ ok: true, stdout: '', stderr: '' }));
    mockParseTestOutput.mock.mockImplementation(() => ({
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      failures: [],
    }));

    const result = await phaseAnalyze('diff', 'evolve/round-1', { plan: null });

    assert.equal(result.aggregateScore, 0);
    assert.equal(result.aggregateConfidence, 0);
    assert.deepEqual(result.concerns, []);
  });
});
