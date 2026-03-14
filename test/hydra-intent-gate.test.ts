import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntent, gateIntent } from '../lib/hydra-intent-gate.ts';

// ── normalizeIntent — filler stripping ───────────────────────────────────────

describe('normalizeIntent — filler stripping', () => {
  it('strips "please" prefix', () => {
    assert.equal(normalizeIntent('please fix the bug'), 'fix the bug');
  });

  it('strips "can you" prefix', () => {
    assert.equal(normalizeIntent('can you refactor this module'), 'refactor this module');
  });

  it('strips "could you" prefix', () => {
    assert.equal(normalizeIntent('could you add error handling'), 'add error handling');
  });

  it('strips "would you" prefix', () => {
    assert.equal(normalizeIntent('would you write a test'), 'write a test');
  });

  it('strips "just" prefix', () => {
    assert.equal(normalizeIntent('just run the tests'), 'run the tests');
  });

  it('strips "quickly" prefix', () => {
    assert.equal(normalizeIntent('quickly check the logs'), 'check the logs');
  });

  it('strips "help me" prefix', () => {
    assert.equal(normalizeIntent('help me debug this'), 'debug this');
  });

  it('strips "i need you to" prefix', () => {
    assert.equal(normalizeIntent('i need you to write a function'), 'write a function');
  });

  it('strips "i want you to" prefix', () => {
    assert.equal(normalizeIntent('i want you to create a service'), 'create a service');
  });

  it('strips "go ahead and" prefix', () => {
    assert.equal(normalizeIntent('go ahead and deploy'), 'deploy');
  });

  it('strips stacked fillers until stable', () => {
    assert.equal(normalizeIntent('please just fix the tests'), 'fix the tests');
  });

  it('strips filler case-insensitively', () => {
    assert.equal(normalizeIntent('PLEASE fix this'), 'fix this');
    assert.equal(normalizeIntent('Can You add logging'), 'add logging');
  });

  it('returns empty string for blank input', () => {
    assert.equal(normalizeIntent(''), '');
    assert.equal(normalizeIntent('   '), '');
  });

  it('leaves prompts without filler unchanged', () => {
    const text = 'implement authentication middleware';
    assert.equal(normalizeIntent(text), text);
  });
});

// ── normalizeIntent — abbreviation expansion ──────────────────────────────────

describe('normalizeIntent — abbreviation expansion', () => {
  it('expands "impl" to "implement"', () => {
    assert.ok(normalizeIntent('impl the service').includes('implement'));
  });

  it('expands "fn" to "function"', () => {
    assert.ok(normalizeIntent('write a fn for this').includes('function'));
  });

  it('expands "auth" to "authentication"', () => {
    assert.ok(normalizeIntent('add auth layer').includes('authentication'));
  });

  it('expands "config" to "configuration"', () => {
    assert.ok(normalizeIntent('update config file').includes('configuration'));
  });

  it('expands "util" to "utility"', () => {
    assert.ok(normalizeIntent('write a util for parsing').includes('utility'));
  });

  it('expands "utils" to "utilities"', () => {
    assert.ok(normalizeIntent('add to utils folder').includes('utilities'));
  });

  it('expands "params" to "parameters"', () => {
    assert.ok(normalizeIntent('validate params').includes('parameters'));
  });

  it('expands "param" to "parameter"', () => {
    assert.ok(normalizeIntent('add a param').includes('parameter'));
  });

  it('expands "env" to "environment"', () => {
    assert.ok(normalizeIntent('read env vars').includes('environment'));
  });

  it('expands "doc" to "documentation"', () => {
    assert.ok(normalizeIntent('update doc for this').includes('documentation'));
  });

  it('expands "docs" to "documentation"', () => {
    assert.ok(normalizeIntent('generate docs').includes('documentation'));
  });

  it('expands "opt" to "optimize"', () => {
    assert.ok(normalizeIntent('opt the loop').includes('optimize'));
  });

  it('expands multiple abbreviations in one string', () => {
    const result = normalizeIntent('impl auth fn');
    assert.ok(result.includes('implement'));
    assert.ok(result.includes('authentication'));
    assert.ok(result.includes('function'));
  });

  it('does not double-expand already-expanded words', () => {
    const result = normalizeIntent('implement the function');
    assert.equal(result, 'implement the function');
  });

  it('is idempotent', () => {
    const text = 'please impl a fn for auth config';
    assert.equal(normalizeIntent(normalizeIntent(text)), normalizeIntent(text));
  });
});

// ── gateIntent — passthrough and flags ───────────────────────────────────────

describe('gateIntent — passthrough and flags', () => {
  it('returns unchanged text when disabled', async () => {
    const raw = 'please impl a fn to get user auth tokens';
    const result = await gateIntent(raw, { enabled: false });
    assert.equal(result.text, raw);
    assert.equal(result.normalized, false);
    assert.equal(result.rewritten, false);
  });

  it('returns a classification object even when disabled', async () => {
    const result = await gateIntent('add tests', { enabled: false });
    assert.ok(result.classification, 'classification must be present');
    assert.ok(typeof result.classification.tier === 'string', 'tier must be a string');
  });

  it('returns normalized=true for high-confidence prompts', async () => {
    const result = await gateIntent('implement user authentication middleware', {
      confidenceThreshold: 0.1,
    });
    assert.equal(result.normalized, true);
    assert.equal(result.rewritten, false);
  });

  it('returns rewritten=true when LLM rewrite succeeds and confidence is low', async () => {
    const result = await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      rewriteFn: async () => 'implement the feature in src/index.ts',
    });
    assert.equal(result.rewritten, true);
    assert.equal(result.text, 'implement the feature in src/index.ts');
  });

  it('does not call LLM for a high-confidence prompt', async () => {
    let llmCalled = false;
    await gateIntent('fix the authentication bug in lib/hydra-operator.ts', {
      onLlmCall: () => {
        llmCalled = true;
      },
    });
    assert.equal(llmCalled, false);
  });

  it('calls LLM when confidence is below threshold', async () => {
    let llmCalled = false;
    await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      onLlmCall: () => {
        llmCalled = true;
      },
      rewriteFn: async (t) => t,
    });
    assert.equal(llmCalled, true);
  });

  it('falls back gracefully when rewriteFn throws', async () => {
    const result = await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      rewriteFn: async () => {
        throw new Error('LLM failure');
      },
    });
    assert.ok(result.text);
    assert.equal(result.rewritten, false);
    assert.equal(result.normalized, true);
  });

  it('falls back gracefully when rewriteFn returns null', async () => {
    const result = await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      rewriteFn: async () => null,
    });
    assert.ok(result.text);
    assert.equal(result.rewritten, false);
  });

  it('falls back gracefully when rewriteFn returns empty string', async () => {
    const result = await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      rewriteFn: async () => '',
    });
    assert.equal(result.rewritten, false);
  });

  it('trims whitespace from rewritten text', async () => {
    const result = await gateIntent('do the thing', {
      confidenceThreshold: 0.99,
      rewriteFn: async () => '  implement the service  ',
    });
    assert.equal(result.text, 'implement the service');
  });

  it('strips fillers and expands abbreviations before classifying', async () => {
    const result = await gateIntent('please impl a fn', { enabled: true });
    assert.ok(result.text !== 'please impl a fn', 'filler/abbrevs must be normalized');
    assert.ok(result.text.includes('implement') || result.text.includes('function'));
  });
});
