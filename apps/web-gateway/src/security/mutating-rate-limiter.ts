/**
 * Mutating rate limiter — sliding-window per source on mutating endpoints
 * and WS session creation. Separate from login rate limiter. (FR-025)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RateLimiter, type RateLimiterConfig } from '../auth/rate-limiter.ts';
import type { Clock } from '../shared/clock.ts';
import { createError } from '../shared/errors.ts';

const DEFAULT_MUTATING_LIMITS: Partial<RateLimiterConfig> = {
  maxAttempts: 30,
  windowMs: 60_000,
  lockoutMs: 60_000,
};

export function createMutatingRateLimiter(clock: Clock, config: Partial<RateLimiterConfig> = {}) {
  const limiter = new RateLimiter(clock, { ...DEFAULT_MUTATING_LIMITS, ...config });
  const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  return function mutatingRateLimiter(
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void {
    const method = req.method?.toUpperCase() ?? 'GET';
    if (SAFE_METHODS.has(method)) {
      next();
      return;
    }

    const sourceKey = req.socket.remoteAddress ?? 'unknown';
    if (!limiter.check(sourceKey)) {
      const err = createError('RATE_LIMITED');
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: err.code, message: err.message }));
      return;
    }
    limiter.recordFailure(sourceKey); // count all mutating requests
    next();
  };
}
