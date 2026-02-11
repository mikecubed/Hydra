/**
 * hydra-rate-limiter.mjs — Token bucket rate limiter for API providers
 *
 * Provides per-provider RPS ceilings and a system-wide concurrency counter.
 * Zero Hydra imports — sits at the bottom of the import tree.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Token Bucket
// ---------------------------------------------------------------------------

class TokenBucket {
  /**
   * @param {number} capacity    Max tokens (burst limit)
   * @param {number} refillRate  Tokens per second
   */
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this._lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this._lastRefill = now;
  }

  /**
   * Try to consume tokens. Returns true if available, false otherwise.
   */
  tryConsume(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /**
   * Wait until tokens are available, then consume.
   */
  async waitForTokens(n = 1) {
    while (!this.tryConsume(n)) {
      // Estimate wait time
      const deficit = n - this.tokens;
      const waitMs = Math.max(50, Math.ceil((deficit / this.refillRate) * 1000));
      await sleep(Math.min(waitMs, 5000));
    }
  }

  /**
   * Current available tokens (after refill).
   */
  available() {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ---------------------------------------------------------------------------
// Per-provider limiters
// ---------------------------------------------------------------------------

const _limiters = new Map();

const DEFAULT_LIMITS = {
  openai: 60,       // 60 req/min
  anthropic: 50,    // 50 req/min
  google: 300,      // 300 req/min
};

/**
 * Initialize rate limiters from config.
 * @param {Object} rpsConfig  { openai: 60, anthropic: 50, google: 300 }
 */
export function initRateLimiters(rpsConfig = {}) {
  const limits = { ...DEFAULT_LIMITS, ...rpsConfig };
  for (const [provider, rps] of Object.entries(limits)) {
    const perSecond = rps / 60;
    _limiters.set(provider, new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond));
  }
}

function _getLimiter(provider) {
  if (!_limiters.has(provider)) {
    const rps = DEFAULT_LIMITS[provider] || 60;
    const perSecond = rps / 60;
    _limiters.set(provider, new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond));
  }
  return _limiters.get(provider);
}

/**
 * Acquire a rate limit token for a provider. Waits if necessary.
 * @param {string} provider  'openai' | 'anthropic' | 'google'
 */
export async function acquireRateLimit(provider) {
  const limiter = _getLimiter(provider);
  await limiter.waitForTokens(1);
}

/**
 * Try to acquire without waiting. Returns false if rate limited.
 */
export function tryAcquireRateLimit(provider) {
  return _getLimiter(provider).tryConsume(1);
}

/**
 * Get current rate limit stats for all providers.
 */
export function getRateLimitStats() {
  const stats = {};
  for (const [provider, limiter] of _limiters) {
    stats[provider] = {
      available: limiter.available(),
      capacity: limiter.capacity,
      refillRate: limiter.refillRate,
    };
  }
  return stats;
}

/**
 * Reset a specific provider or all limiters.
 */
export function resetRateLimiter(provider) {
  if (provider) {
    const limiter = _limiters.get(provider);
    if (limiter) limiter.tokens = limiter.capacity;
  } else {
    for (const limiter of _limiters.values()) {
      limiter.tokens = limiter.capacity;
    }
  }
}

// ---------------------------------------------------------------------------
// System-wide concurrency counter
// ---------------------------------------------------------------------------

let _activeCount = 0;
let _maxInFlight = 3;

export function initConcurrency(maxInFlight = 3) {
  _maxInFlight = maxInFlight;
}

/**
 * Wait until a concurrency slot is available, then claim it.
 * Returns a release function.
 */
export async function acquireConcurrencySlot() {
  while (_activeCount >= _maxInFlight) {
    await sleep(250);
  }
  _activeCount++;
  let released = false;
  return function release() {
    if (!released) {
      released = true;
      _activeCount--;
    }
  };
}

/**
 * Try to claim a concurrency slot without waiting.
 * Returns release function or null if no slot available.
 */
export function tryAcquireConcurrencySlot() {
  if (_activeCount >= _maxInFlight) return null;
  _activeCount++;
  let released = false;
  return function release() {
    if (!released) {
      released = true;
      _activeCount--;
    }
  };
}

export function getConcurrencyStats() {
  return {
    active: _activeCount,
    maxInFlight: _maxInFlight,
    utilization: _maxInFlight > 0 ? _activeCount / _maxInFlight : 0,
  };
}

// For testing
export { TokenBucket };
