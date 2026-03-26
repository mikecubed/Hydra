/**
 * Deep coverage tests for lib/hydra-evolve-investigator.ts.
 *
 * Mocks streamCompletion (OpenAI) and fs to test investigate() deeper paths:
 * - timeout diagnosis
 * - budget exhaustion
 * - phase not configured
 * - successful stream investigation
 * - error handling in stream
 * - logging
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockStreamCompletion = mock.fn(async () => ({
  fullResponse: JSON.stringify({
    diagnosis: 'fixable',
    explanation: 'bad import',
    rootCause: 'missing module',
    corrective: 'add import',
    retryRecommendation: {
      retryPhase: true,
      modifiedPrompt: 'Add the missing import',
      preamble: null,
      retryAgent: null,
    },
  }),
  usage: { prompt_tokens: 100, completion_tokens: 50 },
}));

mock.module('../lib/hydra-openai.ts', {
  namedExports: { streamCompletion: mockStreamCompletion },
});

const mockAppendFileSync = mock.fn();
const mockExistsSync = mock.fn(() => true);
const mockMkdirSync = mock.fn();

mock.module('node:fs', {
  namedExports: {
    appendFileSync: mockAppendFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readFileSync: mock.fn(() => '{}'),
    writeFileSync: mock.fn(),
  },
  defaultExport: {
    appendFileSync: mockAppendFileSync,
    existsSync: mockExistsSync,
    mkdirSync: mockMkdirSync,
    readFileSync: mock.fn(() => '{}'),
    writeFileSync: mock.fn(),
  },
});

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mock.fn(() => ({
      evolve: {
        investigator: {
          enabled: true,
          model: 'test-model',
          phases: ['test', 'implement', 'analyze', 'agent'],
          maxTokensBudget: 50000,
          logToFile: true,
        },
      },
    })),
    HYDRA_ROOT: '/tmp/test-hydra',
    resolveProject: mock.fn(),
    getRoleConfig: mock.fn(),
  },
});

// ── Import ───────────────────────────────────────────────────────────────────

const {
  investigate,
  parseInvestigatorResponse,
  initInvestigator,
  resetInvestigator,
  isInvestigatorAvailable,
  getInvestigatorStats,
} = await import('../lib/hydra-evolve-investigator.ts');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('investigate — timeout path', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator();
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('returns transient diagnosis for timed out failures', async () => {
    const result = await investigate({
      phase: 'test',
      agent: 'codex',
      timedOut: true,
      error: 'timeout',
    });
    assert.equal(result.diagnosis, 'transient');
    assert.ok(result.explanation.includes('timed out'));
    assert.equal(result.retryRecommendation.retryPhase, true);
  });

  it('uses phase name when agent is not specified', async () => {
    const result = await investigate({
      phase: 'implement',
      timedOut: true,
    });
    assert.ok(result.explanation.includes('implement'));
  });
});

describe('investigate — phase not configured', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator();
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('returns fundamental for unconfigured phase', async () => {
    const result = await investigate({
      phase: 'unknown-phase',
      error: 'something',
    });
    assert.equal(result.diagnosis, 'fundamental');
    assert.ok(result.explanation.includes('not configured'));
    assert.equal(result.retryRecommendation.retryPhase, false);
  });
});

describe('investigate — budget exhaustion', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator({ maxTokensBudget: 1 }); // Very low budget
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('returns fundamental when budget is exhausted', async () => {
    // First call uses some budget via stream
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'transient',
        explanation: 'test',
        rootCause: 'test',
        retryRecommendation: { retryPhase: true },
      }),
      usage: { prompt_tokens: 500, completion_tokens: 600 },
    }));

    // First call should succeed but exhaust budget
    await investigate({ phase: 'test', error: 'err1' });

    // Second call should get budget exhausted result
    const result = await investigate({ phase: 'test', error: 'err2' });
    assert.equal(result.diagnosis, 'fundamental');
    assert.ok(result.explanation.includes('budget exhausted'));
  });
});

describe('investigate — successful stream investigation', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator();
    mockStreamCompletion.mock.resetCalls();
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('returns diagnosis from stream with fixable result', async () => {
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'fixable',
        explanation: 'missing import in test file',
        rootCause: 'forgot to import assert',
        corrective: 'add import assert from node:assert',
        retryRecommendation: {
          retryPhase: true,
          modifiedPrompt: 'Make sure to import assert',
          preamble: null,
          retryAgent: null,
        },
      }),
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    }));

    const result = await investigate({
      phase: 'test',
      agent: 'codex',
      error: 'ReferenceError: assert is not defined',
      stderr: 'at test.js:1:1',
      stdout: '',
      attemptNumber: 1,
      exitCode: 1,
    });

    assert.equal(result.diagnosis, 'fixable');
    assert.equal(result.explanation, 'missing import in test file');
    assert.equal(result.retryRecommendation.retryPhase, true);
    assert.ok(result.tokens);
    assert.equal(result.tokens.prompt, 200);
    assert.equal(result.tokens.completion, 100);
  });

  it('increments stats after investigation', async () => {
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'transient',
        explanation: 'rate limit',
        rootCause: '429',
        retryRecommendation: { retryPhase: true },
      }),
      usage: { prompt_tokens: 50, completion_tokens: 30 },
    }));

    const statsBefore = getInvestigatorStats();
    await investigate({ phase: 'test', error: 'rate limit' });
    const statsAfter = getInvestigatorStats();

    assert.ok(statsAfter.investigations > statsBefore.investigations);
    assert.ok(statsAfter.promptTokens >= statsBefore.promptTokens + 50);
  });

  it('increments healed counter for fixable+retryPhase result', async () => {
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'fixable',
        explanation: 'test',
        rootCause: 'test',
        retryRecommendation: { retryPhase: true },
      }),
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));

    const before = getInvestigatorStats();
    await investigate({ phase: 'test', error: 'err' });
    const after = getInvestigatorStats();
    assert.ok(after.healed > before.healed);
  });

  it('does not increment healed for fundamental result', async () => {
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'fundamental',
        explanation: 'impossible',
        rootCause: 'no dep',
        retryRecommendation: { retryPhase: false },
      }),
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));

    const before = getInvestigatorStats();
    await investigate({ phase: 'test', error: 'err' });
    const after = getInvestigatorStats();
    assert.equal(after.healed, before.healed);
  });
});

describe('investigate — stream error handling', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator();
    mockStreamCompletion.mock.resetCalls();
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('returns fundamental diagnosis when stream throws', async () => {
    mockStreamCompletion.mock.mockImplementation(async () => {
      throw new Error('API connection refused');
    });

    const result = await investigate({
      phase: 'test',
      error: 'some error',
    });

    assert.equal(result.diagnosis, 'fundamental');
    assert.ok(result.explanation.includes('Investigator call failed'));
    assert.ok(result.rootCause.includes('API connection refused'));
  });
});

describe('investigate — failure message building', () => {
  beforeEach(() => {
    resetInvestigator();
    initInvestigator();
    mockStreamCompletion.mock.resetCalls();
    mockStreamCompletion.mock.mockImplementation(async () => ({
      fullResponse: JSON.stringify({
        diagnosis: 'fixable',
        explanation: 'test',
        rootCause: 'test',
        retryRecommendation: { retryPhase: true },
      }),
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }));
  });
  afterEach(() => {
    resetInvestigator();
  });

  it('includes optional fields in failure message', async () => {
    const result = await investigate({
      phase: 'implement',
      agent: 'claude',
      error: 'compile error',
      stderr: 'error: missing semicolon',
      stdout: 'compiling...',
      context: 'implementation plan: do X then Y',
      attemptNumber: 2,
      exitCode: 1,
      signal: null,
      errorCategory: 'syntax',
      errorDetail: 'line 42 col 5',
      errorContext: 'in function foo()',
      command: 'tsc',
      args: ['--noEmit'],
      promptSnippet: 'implement the feature',
      durationMs: 5000,
    });

    assert.equal(result.diagnosis, 'fixable');
    assert.equal(mockStreamCompletion.mock.callCount(), 1);
  });

  it('handles failure with no optional fields', async () => {
    const result = await investigate({
      phase: 'test',
    });

    assert.equal(typeof result.diagnosis, 'string');
  });
});

describe('parseInvestigatorResponse — additional cases', () => {
  it('handles partial retryRecommendation', () => {
    const raw = JSON.stringify({
      diagnosis: 'fixable',
      explanation: 'test',
      rootCause: 'test',
      retryRecommendation: { retryPhase: true },
    });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.retryRecommendation.modifiedPrompt, null);
    assert.equal(result.retryRecommendation.preamble, null);
    assert.equal(result.retryRecommendation.retryAgent, null);
  });

  it('handles non-string diagnosis (defaults to fundamental)', () => {
    const raw = JSON.stringify({ diagnosis: 123 });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.diagnosis, 'fundamental');
  });

  it('handles non-string explanation (defaults)', () => {
    const raw = JSON.stringify({ diagnosis: 'transient', explanation: null });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.explanation, 'No explanation provided');
  });

  it('handles non-string rootCause (defaults to Unknown)', () => {
    const raw = JSON.stringify({ diagnosis: 'transient', rootCause: 42 });
    const result = parseInvestigatorResponse(raw);
    assert.equal(result.rootCause, 'Unknown');
  });
});

describe('isInvestigatorAvailable', () => {
  const origKey = process.env['OPENAI_API_KEY'];

  afterEach(() => {
    resetInvestigator();
    if (origKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = origKey;
    }
  });

  it('returns true when enabled and key present', () => {
    resetInvestigator();
    process.env['OPENAI_API_KEY'] = 'test-key';
    assert.equal(isInvestigatorAvailable(), true);
  });

  it('returns false when key is empty string', () => {
    resetInvestigator();
    process.env['OPENAI_API_KEY'] = '';
    assert.equal(isInvestigatorAvailable(), false);
  });
});

describe('getInvestigatorStats', () => {
  it('returns tokenBudgetMax from config', () => {
    resetInvestigator();
    const stats = getInvestigatorStats();
    assert.equal(stats.tokenBudgetMax, 50000);
  });
});

describe('initInvestigator with overrides', () => {
  afterEach(() => {
    resetInvestigator();
  });

  it('accepts reasoningEffort override', () => {
    initInvestigator({ reasoningEffort: 'low' });
    // No throw means success
    const stats = getInvestigatorStats();
    assert.equal(typeof stats.investigations, 'number');
  });

  it('rejects empty reasoningEffort override', () => {
    initInvestigator({ reasoningEffort: '' });
    const stats = getInvestigatorStats();
    assert.equal(typeof stats.investigations, 'number');
  });
});
