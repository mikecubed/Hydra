/**
 * Hydra Streaming Middleware — Composable middleware pipeline for provider API calls.
 *
 * Inspired by Helicone's Tower middleware architecture: each concern (rate limiting,
 * circuit breaking, retry, usage tracking, telemetry) is an independent layer that
 * wraps the core streaming call in an onion-style pipeline.
 */

import { acquireRateLimit, recordApiRequest, updateFromHeaders } from './hydra-rate-limits.ts';
import { recordProviderUsage } from './hydra-provider-usage.ts';
import { isCircuitOpen, recordModelFailure } from './hydra-model-recovery.ts';
import { loadHydraConfig } from './hydra-config.ts';
import { startProviderSpan, endProviderSpan } from './hydra-telemetry.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface MiddlewareCtx {
  provider: string;
  model: string;
  messages: unknown[];
  cfg: Record<string, unknown> & { model?: string };
  onChunk: ((chunk: string) => void) | null;
  latencyMs: number;
}

// ---------------------------------------------------------------------------
// PeakEWMA — Exponentially Weighted Moving Average for latency tracking
// ---------------------------------------------------------------------------

/**
 * Tracks latency using an exponentially weighted moving average.
 */
export class PeakEWMA {
  private readonly _decayMs: number;
  private _ewma: number;
  private _lastTs: number;
  private _count: number;

  constructor(decayMs: number = 10000) {
    this._decayMs = decayMs;
    this._ewma = 0;
    this._lastTs = 0;
    this._count = 0;
  }

  observe(latencyMs: number): void {
    const now = Date.now();
    if (this._count === 0) {
      this._ewma = latencyMs;
      this._lastTs = now;
      this._count = 1;
      return;
    }

    const elapsed = now - this._lastTs;
    const weight = Math.exp(-elapsed / this._decayMs);
    this._ewma = weight * this._ewma + (1 - weight) * latencyMs;
    this._lastTs = now;
    this._count++;
  }

  get(): number {
    if (this._count === 0) return 0;
    const elapsed = Date.now() - this._lastTs;
    const weight = Math.exp(-elapsed / this._decayMs);
    return this._ewma * weight;
  }

  get count(): number {
    return this._count;
  }

  reset(): void {
    this._ewma = 0;
    this._lastTs = 0;
    this._count = 0;
  }
}

// Per-provider PeakEWMA instances for health scoring
const providerLatency = new Map<string, PeakEWMA>();

/**
 * Get the PeakEWMA tracker for a provider. Creates one if needed.
 */
export function getProviderEWMA(provider: string): PeakEWMA {
  if (!providerLatency.has(provider)) {
    providerLatency.set(provider, new PeakEWMA());
  }
  return providerLatency.get(provider)!;
}

/**
 * Get estimated latency for all tracked providers.
 */
export function getLatencyEstimates(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [provider, ewma] of providerLatency) {
    out[provider] = ewma.get();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Middleware layers
// ---------------------------------------------------------------------------

function rateLimitMiddleware(ctx: MiddlewareCtx, next: () => Promise<unknown>): Promise<unknown> {
  return acquireRateLimit(ctx.provider).then(() => next());
}

async function circuitBreakerMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  if (ctx.model && isCircuitOpen(ctx.model)) {
    const err = new Error(`Circuit breaker open for model ${ctx.model}`);
    (err as Error & { circuitBreakerOpen: boolean }).circuitBreakerOpen = true;
    throw err;
  }

  try {
    const result = await next();
    return result;
  } catch (err: unknown) {
    if (ctx.model && (err as any).status && (err as any).status >= 500) {
      recordModelFailure(ctx.model);
    }
    throw err;
  }
}

async function retryMiddleware(ctx: MiddlewareCtx, next: () => Promise<unknown>): Promise<unknown> {
  const cfg = loadHydraConfig() as any;
  const maxRetries = cfg.rateLimits?.maxRetries ?? 3;
  const baseDelayMs = cfg.rateLimits?.baseDelayMs ?? 5000;
  const maxDelayMs = cfg.rateLimits?.maxDelayMs ?? 60000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await next();
    } catch (err: unknown) {
      lastErr = err;
      const is429 = (err as any).status === 429 || (err as any).isRateLimit;
      if (!is429 || attempt >= maxRetries) throw err;

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = delay * 0.1 * Math.random();
      await new Promise<void>((r) => {
        setTimeout(r, delay + jitter);
      });

      await acquireRateLimit(ctx.provider);
    }
  }
  throw lastErr;
}

async function usageTrackingMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const result = (await next()) as any;

  if (result.usage) {
    recordProviderUsage(ctx.provider, {
      inputTokens: result.usage.prompt_tokens ?? 0,
      outputTokens: result.usage.completion_tokens ?? 0,
      model: ctx.model,
    });
    recordApiRequest(ctx.provider, ctx.model, result.usage);
  }

  return result;
}

async function headerCaptureMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const result = (await next()) as any;

  if (result.rateLimits) {
    updateFromHeaders(ctx.provider, result.rateLimits);
  }

  return result;
}

async function telemetryMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const span = await startProviderSpan(ctx.provider, ctx.model);
  const start = Date.now();
  try {
    const result = (await next()) as any;
    await endProviderSpan(span, result.usage, Date.now() - start);
    return result;
  } catch (err: unknown) {
    const s = span as any;
    if (!s._noop) {
      s.recordException?.(err);
      s.setStatus?.({ code: 2, message: (err as Error).message });
      s.end?.();
    }
    throw err;
  }
}

async function latencyMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const start = Date.now();
  try {
    const result = await next();
    const latencyMs = Date.now() - start;
    getProviderEWMA(ctx.provider).observe(latencyMs);
    ctx.latencyMs = latencyMs;
    return result;
  } catch (err: unknown) {
    if ((err as any).status !== 429 && !(err as any).isRateLimit) {
      const latencyMs = Date.now() - start;
      getProviderEWMA(ctx.provider).observe(latencyMs);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Pipeline composition
// ---------------------------------------------------------------------------

function compose(
  layers: Array<(ctx: MiddlewareCtx, next: () => Promise<unknown>) => Promise<unknown>>,
  core: (ctx: MiddlewareCtx) => Promise<unknown>,
): (ctx: MiddlewareCtx) => Promise<unknown> {
  let fn = core;
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const next = fn;
    fn = (ctx) => layer(ctx, () => next(ctx));
  }
  return fn;
}

const DEFAULT_LAYERS: Array<
  (ctx: MiddlewareCtx, next: () => Promise<unknown>) => Promise<unknown>
> = [
  latencyMiddleware,
  retryMiddleware,
  rateLimitMiddleware,
  circuitBreakerMiddleware,
  telemetryMiddleware,
  headerCaptureMiddleware,
  usageTrackingMiddleware,
];

/**
 * Create a streaming pipeline that wraps a core provider function with middleware.
 */
export function createStreamingPipeline(
  provider: string,
  coreFn: (
    messages: unknown[],
    cfg: Record<string, unknown>,
    onChunk: ((chunk: string) => void) | null,
  ) => Promise<unknown>,
  opts: {
    layers?: Array<(ctx: MiddlewareCtx, next: () => Promise<unknown>) => Promise<unknown>>;
  } = {},
) {
  const layers = opts.layers ?? DEFAULT_LAYERS;

  const composed = compose(layers, (ctx) => coreFn(ctx.messages, ctx.cfg, ctx.onChunk));

  return async function pipelinedStream(
    messages: unknown[],
    cfg: Record<string, unknown> & { model?: string },
    onChunk: ((chunk: string) => void) | null,
  ): Promise<unknown> {
    const ctx: MiddlewareCtx = {
      provider,
      model: cfg.model ?? '',
      messages,
      cfg,
      onChunk,
      latencyMs: 0,
    };
    return composed(ctx);
  };
}

export {
  rateLimitMiddleware,
  circuitBreakerMiddleware,
  retryMiddleware,
  usageTrackingMiddleware,
  headerCaptureMiddleware,
  latencyMiddleware,
  telemetryMiddleware,
  DEFAULT_LAYERS,
  compose,
};
