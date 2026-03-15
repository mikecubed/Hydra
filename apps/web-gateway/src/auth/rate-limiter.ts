/**
 * Sliding-window rate limiter per source key.
 * Configurable threshold (default 5/60s) and lockout (default 5 min).
 * Uses injected clock for testability.
 */
import type { Clock } from '../shared/clock.ts';

interface RateLimitEntry {
  attempts: number[];
  lockedUntil: number | null;
}

export interface RateLimiterConfig {
  maxAttempts: number;
  windowMs: number;
  lockoutMs: number;
}

const DEFAULT_CONFIG: RateLimiterConfig = {
  maxAttempts: 5,
  windowMs: 60_000,
  lockoutMs: 300_000,
};

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private readonly config: RateLimiterConfig;
  private readonly clock: Clock;

  constructor(clock: Clock, config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clock = clock;
  }

  /** Returns true if the source is allowed; false if rate-limited. */
  check(sourceKey: string): boolean {
    const now = this.clock.now();
    const entry = this.getOrCreate(sourceKey);

    if (entry.lockedUntil !== null) {
      if (now < entry.lockedUntil) return false;
      entry.lockedUntil = null;
      entry.attempts = [];
    }

    // Slide window
    entry.attempts = entry.attempts.filter((t) => now - t < this.config.windowMs);
    return entry.attempts.length < this.config.maxAttempts;
  }

  /** Record a failed attempt. Returns false if now locked out. */
  recordFailure(sourceKey: string): boolean {
    const now = this.clock.now();
    const entry = this.getOrCreate(sourceKey);

    entry.attempts = entry.attempts.filter((t) => now - t < this.config.windowMs);
    entry.attempts.push(now);

    if (entry.attempts.length >= this.config.maxAttempts) {
      entry.lockedUntil = now + this.config.lockoutMs;
      return false;
    }
    return true;
  }

  reset(sourceKey: string): void {
    this.entries.delete(sourceKey);
  }

  private getOrCreate(sourceKey: string): RateLimitEntry {
    let entry = this.entries.get(sourceKey);
    if (!entry) {
      entry = { attempts: [], lockedUntil: null };
      this.entries.set(sourceKey, entry);
    }
    return entry;
  }
}
