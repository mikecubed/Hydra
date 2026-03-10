import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIntent, gateIntent } from '../lib/hydra-intent-gate.mjs';

test('normalizeIntent strips leading filler words', () => {
  assert.equal(normalizeIntent('please fix the bug in auth'), 'fix the bug in authentication');
  assert.equal(normalizeIntent('can you add a test for login'), 'add a test for login');
  assert.equal(normalizeIntent('just quickly refactor this'), 'refactor this');
});

test('normalizeIntent expands common abbreviations', () => {
  assert.equal(normalizeIntent('impl the fn'), 'implement the function');
  assert.equal(normalizeIntent('add auth middleware'), 'add authentication middleware');
});

test('normalizeIntent is idempotent', () => {
  const text = 'fix the bug in hydra-operator.mjs';
  assert.equal(normalizeIntent(normalizeIntent(text)), normalizeIntent(text));
});

test('normalizeIntent handles empty input', () => {
  assert.equal(normalizeIntent(''), '');
  assert.equal(normalizeIntent('   '), '');
});

test('gateIntent returns text and classification', async () => {
  const result = await gateIntent('fix the bug in hydra-utils.mjs');
  assert.ok(result.text, 'text missing');
  assert.ok(result.classification, 'classification missing');
  assert.ok(result.classification.tier, 'tier missing');
});

test('gateIntent does not call LLM for high-confidence prompt', async () => {
  let llmCalled = false;
  await gateIntent('fix the auth bug in lib/hydra-operator.mjs', {
    onLlmCall: () => {
      llmCalled = true;
    },
  });
  assert.equal(llmCalled, false, 'LLM was called for high-confidence prompt');
});

test('gateIntent falls back gracefully when LLM rewrite throws', async () => {
  const result = await gateIntent('do the thing', {
    rewriteFn: async () => {
      throw new Error('LLM failure');
    },
    confidenceThreshold: 0.99,
  });
  assert.ok(result.text);
  assert.ok(result.classification);
});

test('gateIntent passthrough when disabled', async () => {
  const raw = 'please impl a fn to get user auth tokens';
  const result = await gateIntent(raw, { enabled: false });
  assert.equal(result.text, raw);
});
