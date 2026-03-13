import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  _resetState,
  acquireRateLimit,
  getHealthiestProvider,
  getRateLimitStats,
  getRemainingCapacity,
  initRateLimiters,
  resetRateLimiter,
  TokenBucket,
  tryAcquireRateLimit,
} from '../lib/hydra-rate-limits.ts';
import {
  createStreamingPipeline,
  getProviderEWMA,
  headerCaptureMiddleware,
  rateLimitMiddleware,
  usageTrackingMiddleware,
} from '../lib/hydra-streaming-middleware.ts';

type ChunkHandler = ((chunk: string) => void) | null;
type TestCtx = {
  provider: string;
  model: string;
  messages: unknown[];
  cfg: Record<string, unknown> & { model?: string };
  onChunk: ChunkHandler;
  latencyMs: number;
};
type TestLayer = (ctx: TestCtx, next: () => Promise<unknown>) => Promise<unknown>;

// Characterization note for rf-cy02:
// Cycle A existed because hydra-rate-limits.ts reached into
// hydra-streaming-middleware.ts for getProviderEWMA(), while the middleware
// depended on hydra-rate-limits.ts for request tracking. These tests lock down
// the public behavior now that the shared latency tracker lives in its own module.

describe('streaming cycle safety net', () => {
  beforeEach(() => {
    _resetState();
    initRateLimiters({ openai: 600, anthropic: 600, google: 600 });
    resetRateLimiter();
    getProviderEWMA('openai').reset();
    getProviderEWMA('anthropic').reset();
    getProviderEWMA('google').reset();
  });

  it('holds a token bucket at zero until the refill interval restores capacity', async () => {
    const bucket = new TokenBucket(1, 10);

    assert.ok(bucket.tryConsume(1));
    assert.equal(bucket.available(), 0);
    assert.equal(bucket.tryConsume(1), false);

    await delay(120);

    assert.ok(bucket.available() >= 1);
  });

  it('applies backpressure to concurrent waiters when the token bucket is empty', async () => {
    const bucket = new TokenBucket(1, 20);
    const completions: number[] = [];

    assert.ok(bucket.tryConsume(1));

    const start = Date.now();
    await Promise.all([
      bucket.waitForTokens(1).then(() => {
        completions.push(Date.now() - start);
      }),
      bucket.waitForTokens(1).then(() => {
        completions.push(Date.now() - start);
      }),
    ]);

    completions.sort((left, right) => left - right);

    assert.equal(completions.length, 2);
    assert.ok(
      completions[0] >= 40,
      `first waiter resolved too quickly: ${String(completions[0])}ms`,
    );
    assert.ok(
      completions[1] - completions[0] >= 25,
      `waiters should resolve in separate refill windows: ${JSON.stringify(completions)}`,
    );
    assert.equal(bucket.available(), 0);
  });

  it('refills a drained provider limiter before letting another request through', async () => {
    const stats = getRateLimitStats();
    const capacity = stats['openai'].capacity;

    for (let index = 0; index < capacity; index++) {
      assert.ok(tryAcquireRateLimit('openai'));
    }

    assert.equal(getRateLimitStats()['openai'].available, 0);
    assert.equal(tryAcquireRateLimit('openai'), false);

    const start = Date.now();
    await acquireRateLimit('openai');
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 70, `expected refill backpressure, got ${String(elapsed)}ms`);
    assert.ok(getRateLimitStats()['openai'].available >= 0);
  });

  it('passes streaming context into middleware and preserves transformed chunks', async () => {
    const seen: Partial<TestCtx> = {};
    const chunks: string[] = [];
    const messages = [{ role: 'user', content: 'ping' }];
    const cfg = { model: 'o4-mini', temperature: 0.1 };

    const transformLayer: TestLayer = async (ctx, next) => {
      seen.provider = ctx.provider;
      seen.model = ctx.model;
      seen.messages = ctx.messages;
      seen.cfg = ctx.cfg;
      seen.latencyMs = ctx.latencyMs;

      const forward = ctx.onChunk;
      ctx.onChunk =
        forward == null
          ? null
          : (chunk) => {
              forward(chunk.toUpperCase());
            };
      return next();
    };

    const pipeline = createStreamingPipeline(
      'openai',
      (streamMessages, streamCfg, onChunk) => {
        onChunk?.('hello');
        return Promise.resolve({
          streamMessages,
          streamCfg,
          hasOnChunk: typeof onChunk === 'function',
        });
      },
      { layers: [transformLayer] },
    );

    const result = (await pipeline(messages, cfg, (chunk) => {
      chunks.push(chunk);
    })) as {
      streamMessages: unknown[];
      streamCfg: Record<string, unknown>;
      hasOnChunk: boolean;
    };

    assert.deepEqual(seen, {
      provider: 'openai',
      model: 'o4-mini',
      messages,
      cfg,
      latencyMs: 0,
    });
    assert.deepEqual(result.streamMessages, messages);
    assert.deepEqual(result.streamCfg, cfg);
    assert.equal(result.hasOnChunk, true);
    assert.deepEqual(chunks, ['HELLO']);
  });

  it('rethrows stream errors after middleware observes them', async () => {
    const order: string[] = [];

    const observingLayer: TestLayer = async (_ctx, next) => {
      order.push('before');
      try {
        return await next();
      } catch (err: unknown) {
        order.push('caught');
        (err as Error & { observedByLayer?: boolean }).observedByLayer = true;
        throw err;
      } finally {
        order.push('finally');
      }
    };

    const pipeline = createStreamingPipeline(
      'openai',
      () => {
        order.push('core');
        return Promise.reject(new Error('stream exploded'));
      },
      { layers: [observingLayer] },
    );

    await assert.rejects(
      () => pipeline([], { model: 'o4-mini' }, null),
      (error: unknown) => {
        assert.equal((error as Error).message, 'stream exploded');
        assert.equal((error as Error & { observedByLayer?: boolean }).observedByLayer, true);
        return true;
      },
    );

    assert.deepEqual(order, ['before', 'core', 'caught', 'finally']);
  });

  it('applies rate limiting before invoking a streaming core function', async () => {
    const capacity = getRateLimitStats()['openai'].capacity;
    for (let index = 0; index < capacity; index++) {
      assert.ok(tryAcquireRateLimit('openai'));
    }

    let coreStartedAt = 0;
    const start = Date.now();
    const pipeline = createStreamingPipeline(
      'openai',
      (_messages, _cfg, onChunk) => {
        coreStartedAt = Date.now();
        onChunk?.('ok');
        return Promise.resolve({ ok: true });
      },
      { layers: [rateLimitMiddleware] },
    );

    const chunks: string[] = [];
    const result = await pipeline([], { model: 'o4-mini' }, (chunk) => {
      chunks.push(chunk);
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(chunks, ['ok']);
    assert.ok(
      coreStartedAt - start >= 70,
      `expected rate limit delay, got ${String(coreStartedAt - start)}ms`,
    );
  });

  it('syncs streaming usage and header data back into rate limit state', async () => {
    const pipeline = createStreamingPipeline(
      'openai',
      () =>
        Promise.resolve({
          usage: { prompt_tokens: 11, completion_tokens: 7 },
          rateLimits: { remainingRequests: 7, remainingTokens: 900 },
        }),
      { layers: [headerCaptureMiddleware, usageTrackingMiddleware] },
    );

    await pipeline([], { model: 'o4-mini' }, null);

    const remaining = getRemainingCapacity('openai', 'o4-mini');
    assert.equal(remaining.rpm, 7);
    assert.equal(remaining.tpm, 900);
  });

  it('lets rate-limit health scoring reuse middleware latency trackers across the cycle', () => {
    getProviderEWMA('openai').observe(500);
    getProviderEWMA('anthropic').observe(5_000);

    const ranked = getHealthiestProvider([
      { provider: 'openai', model: 'o4-mini', available: true },
      { provider: 'anthropic', model: 'claude-sonnet-4-6', available: true },
    ]);

    assert.equal(ranked[0].provider, 'openai');
  });
});
