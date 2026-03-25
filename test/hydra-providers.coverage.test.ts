/**
 * Provider contract tests for hydra-anthropic.ts, hydra-openai.ts, and hydra-google.ts.
 *
 * Covers missing credentials and one streamed success path per provider so request
 * shaping and SSE parsing regressions do not slip through untouched.
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { streamAnthropicCompletion } from '../lib/hydra-anthropic.ts';
import { streamCompletion } from '../lib/hydra-openai.ts';
import { streamGoogleCompletion } from '../lib/hydra-google.ts';

function makeSseResponse(lines: string[], headers: Record<string, string> = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${lines.join('\n')}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}

describe('streamAnthropicCompletion', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  afterEach(() => {
    mock.restoreAll();
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
  });

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    await assert.rejects(
      () =>
        streamAnthropicCompletion([{ role: 'user', content: 'hello' }], {
          model: 'claude-sonnet-4-20250514',
        }),
      /ANTHROPIC_API_KEY/i,
    );
  });

  it('parses streamed text, usage, and request body on success', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'test-key';
    const calls: Array<RequestInit | undefined> = [];
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return makeSseResponse([
        'event: message_start',
        'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
      ]);
    });
    let streamed = '';
    const result = await streamAnthropicCompletion(
      [
        { role: 'system', content: 'be precise' },
        { role: 'user', content: 'hello' },
      ],
      { model: 'claude-sonnet-4-20250514', thinkingBudget: 128 },
      (chunk) => {
        streamed += chunk;
      },
    );
    const rawBody = calls[0]?.body;
    if (typeof rawBody !== 'string') {
      assert.fail('expected fetch body to be a string');
    }
    const body = JSON.parse(rawBody);
    assert.equal(streamed, 'Hello world');
    assert.equal(result.fullResponse, 'Hello world');
    assert.deepStrictEqual(result.usage, { prompt_tokens: 11, completion_tokens: 7 });
    assert.equal(body.system, 'be precise');
    assert.equal(body.messages.length, 1);
    assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 128 });
  });
});

describe('streamCompletion (OpenAI)', () => {
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
  });

  afterEach(() => {
    mock.restoreAll();
    if (savedKey === undefined) delete process.env['OPENAI_API_KEY'];
    else process.env['OPENAI_API_KEY'] = savedKey;
  });

  it('throws when OPENAI_API_KEY is not set', async () => {
    await assert.rejects(
      () => streamCompletion([{ role: 'user', content: 'hello' }], { model: 'gpt-4' }),
      /OPENAI_API_KEY/i,
    );
  });

  it('builds the request and parses streamed text on success', async () => {
    process.env['OPENAI_API_KEY'] = 'test-key';
    const calls: Array<RequestInit | undefined> = [];
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return makeSseResponse([
        'data: {"choices":[{"delta":{"content":"Hydra"}}]}',
        'data: {"choices":[{"delta":{"content":" dispatch"}}]}',
        'data: {"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}',
        'data: [DONE]',
      ]);
    });
    let streamed = '';
    const result = await streamCompletion(
      [{ role: 'user', content: 'hello' }],
      { model: 'o3', reasoningEffort: 'high', maxTokens: 42 },
      (chunk) => {
        streamed += chunk;
      },
    );
    const rawBody = calls[0]?.body;
    if (typeof rawBody !== 'string') {
      assert.fail('expected fetch body to be a string');
    }
    const body = JSON.parse(rawBody);
    assert.equal(streamed, 'Hydra dispatch');
    assert.equal(result.fullResponse, 'Hydra dispatch');
    assert.deepStrictEqual(result.usage, {
      prompt_tokens: 3,
      completion_tokens: 5,
      total_tokens: 8,
    });
    assert.equal(body.model, 'o3');
    assert.deepStrictEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.max_completion_tokens, 42);
  });
});

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
    mock.restoreAll();
    if (savedGeminiKey === undefined) delete process.env['GEMINI_API_KEY'];
    else process.env['GEMINI_API_KEY'] = savedGeminiKey;
    if (savedGoogleKey === undefined) delete process.env['GOOGLE_API_KEY'];
    else process.env['GOOGLE_API_KEY'] = savedGoogleKey;
  });

  it('throws when neither GEMINI_API_KEY nor GOOGLE_API_KEY is set', async () => {
    await assert.rejects(
      () => streamGoogleCompletion([{ role: 'user', content: 'hello' }], { model: 'gemini-pro' }),
      /GEMINI_API_KEY|GOOGLE_API_KEY/i,
    );
  });

  it('maps assistant/system messages and parses streamed text on success', async () => {
    process.env['GEMINI_API_KEY'] = 'test-key';
    const calls: Array<RequestInit | undefined> = [];
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init);
      return makeSseResponse([
        'data: {"candidates":[{"content":{"parts":[{"text":"Gemini"},{"text":" hidden","thought":true},{"text":" output"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":6}}',
      ]);
    });
    let streamed = '';
    const result = await streamGoogleCompletion(
      [
        { role: 'system', content: 'system prompt' },
        { role: 'assistant', content: 'existing answer' },
        { role: 'user', content: 'hello' },
      ],
      { model: 'gemini-2.5-pro', maxTokens: 99, responseType: 'json' },
      (chunk) => {
        streamed += chunk;
      },
    );
    const rawBody = calls[0]?.body;
    if (typeof rawBody !== 'string') {
      assert.fail('expected fetch body to be a string');
    }
    const body = JSON.parse(rawBody);
    assert.equal(streamed, 'Gemini output');
    assert.equal(result.fullResponse, 'Gemini output');
    assert.deepStrictEqual(result.usage, { prompt_tokens: 5, completion_tokens: 6 });
    assert.equal(body.systemInstruction.parts[0].text, 'system prompt');
    assert.deepStrictEqual(body.contents[0], {
      role: 'model',
      parts: [{ text: 'existing answer' }],
    });
    assert.deepStrictEqual(body.contents[1], { role: 'user', parts: [{ text: 'hello' }] });
    assert.equal(body.generationConfig.maxOutputTokens, 99);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  });
});
