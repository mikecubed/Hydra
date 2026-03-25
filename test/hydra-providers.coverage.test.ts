/**
 * Coverage tests for provider modules — basic existence, callability, and error handling.
 *
 * Tests hydra-anthropic.ts, hydra-openai.ts, and hydra-google.ts exported functions.
 * Verifies that missing API keys produce clear errors without making network calls.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { streamAnthropicCompletion } from '../lib/hydra-anthropic.ts';
import { streamCompletion } from '../lib/hydra-openai.ts';
import { streamGoogleCompletion } from '../lib/hydra-google.ts';

// ── streamAnthropicCompletion ────────────────────────────────────────────────

describe('streamAnthropicCompletion', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = savedKey;
    }
  });

  it('is a function', () => {
    assert.equal(typeof streamAnthropicCompletion, 'function');
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    await assert.rejects(
      () =>
        streamAnthropicCompletion([{ role: 'user', content: 'hello' }], {
          model: 'claude-sonnet-4-20250514',
        }),
      (err: Error) => {
        assert.match(err.message, /ANTHROPIC_API_KEY/i);
        return true;
      },
    );
  });

  it('throws when model is not set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    await assert.rejects(
      () => streamAnthropicCompletion([{ role: 'user', content: 'hello' }], {}),
      (err: Error) => {
        assert.match(err.message, /model/i);
        return true;
      },
    );
  });
});

// ── streamCompletion (OpenAI) ────────────────────────────────────────────────

describe('streamCompletion (OpenAI)', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    if (savedKey === undefined) {
      delete process.env['OPENAI_API_KEY'];
    } else {
      process.env['OPENAI_API_KEY'] = savedKey;
    }
  });

  it('is a function', () => {
    assert.equal(typeof streamCompletion, 'function');
  });

  it('throws when OPENAI_API_KEY is not set', async () => {
    await assert.rejects(
      () => streamCompletion([{ role: 'user', content: 'hello' }], { model: 'gpt-4' }),
      (err: Error) => {
        assert.match(err.message, /OPENAI_API_KEY/i);
        return true;
      },
    );
  });

  it('throws when model is not set', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    await assert.rejects(
      () => streamCompletion([{ role: 'user', content: 'hello' }], { model: '' }),
      (err: Error) => {
        assert.match(err.message, /model/i);
        return true;
      },
    );
  });
});

// ── streamGoogleCompletion ───────────────────────────────────────────────────

describe('streamGoogleCompletion', () => {
  let savedGeminiKey: string | undefined;
  let savedGoogleKey: string | undefined;

  beforeEach(() => {
    savedGeminiKey = process.env['GEMINI_API_KEY'];
    savedGoogleKey = process.env['GOOGLE_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (savedGeminiKey === undefined) {
      delete process.env['GEMINI_API_KEY'];
    } else {
      process.env['GEMINI_API_KEY'] = savedGeminiKey;
    }
    if (savedGoogleKey === undefined) {
      delete process.env['GOOGLE_API_KEY'];
    } else {
      process.env['GOOGLE_API_KEY'] = savedGoogleKey;
    }
  });

  it('is a function', () => {
    assert.equal(typeof streamGoogleCompletion, 'function');
  });

  it('throws when neither GEMINI_API_KEY nor GOOGLE_API_KEY is set', async () => {
    await assert.rejects(
      () => streamGoogleCompletion([{ role: 'user', content: 'hello' }], { model: 'gemini-pro' }),
      (err: Error) => {
        assert.match(err.message, /GEMINI_API_KEY|GOOGLE_API_KEY/i);
        return true;
      },
    );
  });

  it('throws when model is not set', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    await assert.rejects(
      () => streamGoogleCompletion([{ role: 'user', content: 'hello' }], { model: '' }),
      (err: Error) => {
        assert.match(err.message, /model/i);
        return true;
      },
    );
  });
});
