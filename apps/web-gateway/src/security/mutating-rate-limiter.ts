/**
 * Mutating rate limiter — sliding-window per source on mutating endpoints
 * and WS session creation. Separate from login rate limiter. (FR-025)
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { RateLimiter, type RateLimiterConfig } from '../auth/rate-limiter.ts';
import type { Clock } from '../shared/clock.ts';
import { createError } from '../shared/errors.ts';
import type { GatewayEnv } from '../shared/types.ts';

const DEFAULT_MUTATING_LIMITS: Partial<RateLimiterConfig> = {
  maxAttempts: 30,
  windowMs: 60_000,
  lockoutMs: 60_000,
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createMutatingRateLimiter(
  clock: Clock,
  config: Partial<RateLimiterConfig> = {},
): MiddlewareHandler<GatewayEnv> {
  const limiter = new RateLimiter(clock, { ...DEFAULT_MUTATING_LIMITS, ...config });

  return createMiddleware<GatewayEnv>(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- fallback when middleware absent
    const sourceKey = c.get('sourceKey') ?? 'unknown';
    if (!limiter.check(sourceKey)) {
      const err = createError('RATE_LIMITED');
      return c.json({ code: err.code, message: err.message }, 429);
    }
    limiter.recordAttempt(sourceKey);
    await next();
    // eslint-disable-next-line no-useless-return
    return;
  });
}
