import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Interface as ReadlineInterface } from 'node:readline';
import { createGhostTextHelpers } from '../lib/hydra-operator-ghost-text.ts';

// Minimal readline-like mock
function makeRl(): ReadlineInterface {
  return {
    line: '',
    prompt: (_preserveCursor?: boolean) => {},
    write: (_text: unknown, _key?: unknown) => {},
    _ttyWrite: (_s: unknown, _key: unknown) => {},
  } as unknown as ReadlineInterface;
}

describe('createGhostTextHelpers', () => {
  it('returns getGhostText, showGhostAfterPrompt, upgradeGhostText, cleanup', () => {
    const rl = makeRl();
    const helpers = createGhostTextHelpers({
      rl,
      getConciergeActive: () => false,
      getConciergeModelLabel: () => 'gpt-4o',
    });
    assert.equal(typeof helpers.getGhostText, 'function');
    assert.equal(typeof helpers.showGhostAfterPrompt, 'function');
    assert.equal(typeof helpers.upgradeGhostText, 'function');
    assert.equal(typeof helpers.cleanup, 'function');
  });

  describe('getGhostText', () => {
    it('returns a non-empty string in normal mode', () => {
      const rl = makeRl();
      const { getGhostText } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => false,
        getConciergeModelLabel: () => 'gpt-4o',
      });
      const text = getGhostText();
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, 'ghost text should be non-empty');
    });

    it('returns a non-empty string in concierge mode', () => {
      const rl = makeRl();
      const { getGhostText } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => true,
        getConciergeModelLabel: () => 'claude-3-opus',
      });
      const text = getGhostText();
      assert.equal(typeof text, 'string');
      assert.ok(text.length > 0, 'concierge ghost text should be non-empty');
    });

    it('cycles through hints (does not always return the same string)', () => {
      const rl = makeRl();
      const { getGhostText } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => false,
        getConciergeModelLabel: () => 'gpt-4o',
      });
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) seen.add(getGhostText());
      assert.ok(seen.size > 1, 'should cycle through multiple hints');
    });

    it('embeds the model label in concierge hints', () => {
      const rl = makeRl();
      const { getGhostText } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => true,
        getConciergeModelLabel: () => 'my-special-model',
      });
      const results: string[] = [];
      for (let i = 0; i < 10; i++) results.push(getGhostText());
      const withModel = results.find((t) => t.includes('my-special-model'));
      assert.ok(withModel, 'at least one hint should embed the model label');
    });
  });

  describe('showGhostAfterPrompt', () => {
    it('does not throw when stdout is not a TTY', () => {
      const rl = makeRl();
      const { showGhostAfterPrompt } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => false,
        getConciergeModelLabel: () => 'gpt-4o',
      });
      // process.stdout.isTTY is falsy in test runner — just verify no throw
      assert.doesNotThrow(() => {
        showGhostAfterPrompt();
      });
      assert.doesNotThrow(() => {
        showGhostAfterPrompt('custom hint', 'acceptable text');
      });
    });
  });

  describe('upgradeGhostText', () => {
    it('does not throw when stdout is not a TTY', () => {
      const rl = makeRl();
      const { upgradeGhostText } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => false,
        getConciergeModelLabel: () => 'gpt-4o',
      });
      assert.doesNotThrow(() => {
        upgradeGhostText('new suggestion');
      });
    });
  });

  describe('cleanup', () => {
    it('can be called safely when no ghost cleanup is registered', () => {
      const rl = makeRl();
      const { cleanup } = createGhostTextHelpers({
        rl,
        getConciergeActive: () => false,
        getConciergeModelLabel: () => 'gpt-4o',
      });
      assert.doesNotThrow(() => {
        cleanup();
      });
    });
  });

  it('wraps rl.prompt so that fresh prompts (no preserveCursor) call showGhostAfterPrompt', () => {
    const rl = makeRl();
    let originalCalled = false;
    const originalPrompt = (_preserveCursor?: boolean) => {
      originalCalled = true;
    };
    Object.assign(rl, { prompt: originalPrompt });
    createGhostTextHelpers({
      rl,
      getConciergeActive: () => false,
      getConciergeModelLabel: () => 'gpt-4o',
    });
    // After factory setup, rl.prompt should be wrapped
    rl.prompt(); // preserveCursor = undefined → fresh prompt
    assert.ok(originalCalled, 'original rl.prompt should still be called');
  });
});
