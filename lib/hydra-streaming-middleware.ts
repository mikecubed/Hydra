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
import { PeakEWMA, getLatencyEstimates, getProviderEWMA } from './hydra-latency-tracker.ts';
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

interface ErrorWithStatus {
  status?: number;
  isRateLimit?: boolean;
}

function isErrorWithStatus(err: unknown): err is ErrorWithStatus {
  return typeof err === 'object' && err !== null;
}

interface RetryConfig {
  rateLimits?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

interface ProviderResult {
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  rateLimits?: Record<string, unknown>;
}

function asProviderResult(val: unknown): ProviderResult {
  if (typeof val === 'object' && val != null) return val as ProviderResult;
  return {};
}

interface TelemetrySpan {
  _noop?: boolean;
  recordException?: (err: unknown) => void;
  setStatus?: (status: { code: number; message?: string }) => void;
  end?: () => void;
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
  if (ctx.model !== '' && isCircuitOpen(ctx.model)) {
    const err = new Error(`Circuit breaker open for model ${ctx.model}`);
    (err as Error & { circuitBreakerOpen: boolean }).circuitBreakerOpen = true;
    throw err;
  }

  try {
    const result = await next();
    return result;
  } catch (err: unknown) {
    const errObj = isErrorWithStatus(err) ? err : null;
    if (ctx.model !== '' && errObj?.status != null && errObj.status >= 500) {
      recordModelFailure(ctx.model);
    }
    throw err;
  }
}

async function retryMiddleware(ctx: MiddlewareCtx, next: () => Promise<unknown>): Promise<unknown> {
  const cfg = loadHydraConfig() as unknown as RetryConfig;
  const maxRetries = cfg.rateLimits?.maxRetries ?? 3;
  const baseDelayMs = cfg.rateLimits?.baseDelayMs ?? 5000;
  const maxDelayMs = cfg.rateLimits?.maxDelayMs ?? 60000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: retry loop; each attempt only runs if the previous one threw a 429
      return await next();
    } catch (err: unknown) {
      lastErr = err;
      const errObj = isErrorWithStatus(err) ? err : null;
      const is429 = errObj?.status === 429 || errObj?.isRateLimit === true;
      if (!is429 || attempt >= maxRetries) throw err;

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitter = delay * 0.1 * Math.random();
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: retry loop; must sleep before attempting the next request
      await new Promise<void>((r) => {
        setTimeout(r, delay + jitter);
      });

      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: retry loop; must acquire a rate-limit token before the next attempt
      await acquireRateLimit(ctx.provider);
    }
  }
  throw lastErr;
}

async function usageTrackingMiddleware(
  ctx: MiddlewareCtx,
  next: () => Promise<unknown>,
): Promise<unknown> {
  const result = asProviderResult(await next());

  if (result.usage != null) {
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
  const result = asProviderResult(await next());

  if (result.rateLimits != null) {
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
    const result = asProviderResult(await next());
    await endProviderSpan(span, result.usage ?? null, Date.now() - start);
    return result;
  } catch (err: unknown) {
    const s = span as unknown as TelemetrySpan;
    if (s._noop !== true) {
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
    const errObj = isErrorWithStatus(err) ? err : null;
    if (errObj?.status !== 429 && errObj?.isRateLimit !== true) {
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
  PeakEWMA,
  getLatencyEstimates,
  getProviderEWMA,
};
