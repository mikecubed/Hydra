/**
 * Hydra Rate Limits — Proactive rate limit awareness.
 *
 * Tracks API request rates (RPM), token throughput (TPM), and daily request
 * counts (RPD) per provider. Captures real remaining-capacity from response
 * headers when available, falls back to estimated tracking otherwise.
 *
 * Lightweight: no timers, no polling. State updated passively on each request.
 * Sliding windows pruned lazily on access.
 */

import { loadHydraConfig } from './hydra-config.ts';
import { getProviderEWMA } from './hydra-latency-tracker.ts';
import { getRateLimits as getModelRateLimits } from './hydra-model-profiles.ts';

// ── Types ────────────────────────────────────────────────────────────────────

/** Supported provider names. */
export type Provider = 'openai' | 'anthropic' | 'google';

interface TokenTimestamp {
  ts: number;
  tokens: number;
}

interface DailyCounter {
  date: string | null;
  count: number;
}

interface HeaderCapacity {
  remainingRequests?: number | null;
  remainingTokens?: number | null;
  remainingInputTokens?: number | null;
  remainingOutputTokens?: number | null;
  resetAt?: string | null;
  ts: number;
}

interface RateLimits {
  rpm?: number;
  tpm?: number;
  itpm?: number;
  otpm?: number;
  rpd?: number;
}

interface RemainingCapacity {
  rpm: number | null;
  tpm: number | null;
  rpd: number | null;
  pctRpm: number | null;
  pctTpm: number | null;
  pctRpd: number | null;
}

interface ProviderCandidate {
  provider: string;
  model: string;
  available: boolean;
}

// ── Sliding Window State ────────────────────────────────────────────────────

// RPM: array of request timestamps (ms) within the last 60s
const _requestTimestamps: Partial<Record<string, number[]>> = {
  openai: [],
  anthropic: [],
  google: [],
};

// TPM: array of { ts, tokens } within the last 60s
const _tokenTimestamps: Partial<Record<string, TokenTimestamp[]>> = {
  openai: [],
  anthropic: [],
  google: [],
};

// RPD: daily request counter per provider
const _dailyRequests: Partial<Record<string, DailyCounter>> = {
  openai: { date: null, count: 0 },
  anthropic: { date: null, count: 0 },
  google: { date: null, count: 0 },
};

// Real remaining capacity from provider response headers
const _headerCapacity: Record<string, HeaderCapacity | null> = {
  openai: null,
  anthropic: null,
  google: null,
};

const WINDOW_MS = 60_000; // 60-second sliding window
const HEADER_TTL_MS = 60_000; // Trust header data for 60 seconds

// ── Helpers ─────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function pruneWindow(arr: number[]): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

function pruneTokenWindow(arr: TokenTimestamp[]): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (arr.length > 0 && arr[0].ts < cutoff) arr.shift();
}

function getProviderTier(provider: string): number | string {
  const cfg = loadHydraConfig() as Record<string, unknown>;
  const providers = cfg['providers'] as Record<string, Record<string, unknown>> | undefined;
  const providerCfg = providers?.[provider] ?? {};
  const defaults: Partial<Record<string, number | string>> = {
    openai: 1,
    anthropic: 1,
    google: 'free',
  };
  return (providerCfg['tier'] as number | string | undefined) ?? defaults[provider] ?? 1;
}

function getEffectiveLimits(provider: string, model?: string): RateLimits | null {
  const tier = getProviderTier(provider);
  if (model != null && model !== '') {
    const limits = getModelRateLimits(model, tier as number);
    if (limits) return limits as RateLimits;
  }
  return null;
}

// ── Recording ───────────────────────────────────────────────────────────────

interface UsageRecord {
  prompt_tokens?: number;
  completion_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export function recordApiRequest(
  provider: string,
  _model: string,
  usage: UsageRecord | null,
): void {
  const timestamps = _requestTimestamps[provider];
  if (!timestamps) return;

  const now = Date.now();

  // RPM: add timestamp
  timestamps.push(now);
  pruneWindow(timestamps);

  // TPM: add token count
  const totalTokens =
    (usage?.prompt_tokens ?? usage?.inputTokens ?? 0) +
    (usage?.completion_tokens ?? usage?.outputTokens ?? 0);
  if (totalTokens > 0) {
    const tt = _tokenTimestamps[provider];
    if (tt) {
      tt.push({ ts: now, tokens: totalTokens });
      pruneTokenWindow(tt);
    }
  }

  // RPD: increment daily counter
  const d = today();
  const daily = _dailyRequests[provider];
  if (daily) {
    if (daily.date !== d) {
      daily.date = d;
      daily.count = 0;
    }
    daily.count++;
  }
}

/** Update remaining capacity from provider response headers. */
export function updateFromHeaders(provider: string, headers: Record<string, unknown>): void {
  if (!Object.prototype.hasOwnProperty.call(_headerCapacity, provider)) return;

  // Only store if we got at least one meaningful value
  const hasData = Object.values(headers).some(
    (v) => v != null && v !== '' && !Number.isNaN(Number(v)),
  );
  if (!hasData) return;

  _headerCapacity[provider] = { ...(headers as Partial<HeaderCapacity>), ts: Date.now() };
}

// ── Querying ────────────────────────────────────────────────────────────────

interface CanMakeRequestResult {
  allowed: boolean;
  reason: string;
  remaining: RemainingCapacity;
}

function checkRpmExhausted(limits: RateLimits, remaining: RemainingCapacity): string | null {
  if (limits.rpm != null && limits.rpm !== 0 && remaining.rpm != null && remaining.rpm <= 0) {
    return `RPM exhausted (${String(limits.rpm)}/min)`;
  }
  return null;
}

function checkTpmExhausted(
  limits: RateLimits,
  remaining: RemainingCapacity,
  estimatedTokens: number,
): string | null {
  const tpmLimit = limits.tpm ?? limits.itpm;
  if (tpmLimit != null && tpmLimit !== 0 && remaining.tpm != null) {
    if (remaining.tpm <= 0) {
      return `TPM exhausted (${String(tpmLimit)}/min)`;
    }
    if (estimatedTokens > 0 && remaining.tpm < estimatedTokens) {
      return `insufficient TPM (need ~${String(estimatedTokens)}, have ${String(remaining.tpm)})`;
    }
  }
  return null;
}

function checkRpdExhausted(limits: RateLimits, remaining: RemainingCapacity): string | null {
  if (limits.rpd != null && limits.rpd !== 0 && remaining.rpd != null && remaining.rpd <= 0) {
    return `RPD exhausted (${String(limits.rpd)}/day)`;
  }
  return null;
}

function checkRpmWarning(limits: RateLimits, remaining: RemainingCapacity): string | null {
  const RPM_WARN_PCT = 0.1;
  if (
    limits.rpm != null &&
    limits.rpm !== 0 &&
    remaining.rpm != null &&
    remaining.rpm < limits.rpm * RPM_WARN_PCT
  ) {
    return `RPM low (${String(remaining.rpm)} remaining)`;
  }
  return null;
}

export function canMakeRequest(
  provider: string,
  model: string,
  estimatedTokens = 0,
): CanMakeRequestResult {
  const limits = getEffectiveLimits(provider, model);
  const remaining = getRemainingCapacity(provider, model);

  if (limits == null) {
    return { allowed: true, reason: 'no limit data', remaining };
  }

  const rpmErr = checkRpmExhausted(limits, remaining);
  if (rpmErr != null) return { allowed: false, reason: rpmErr, remaining };

  const tpmErr = checkTpmExhausted(limits, remaining, estimatedTokens);
  if (tpmErr != null) return { allowed: false, reason: tpmErr, remaining };

  const rpdErr = checkRpdExhausted(limits, remaining);
  if (rpdErr != null) return { allowed: false, reason: rpdErr, remaining };

  const rpmWarn = checkRpmWarning(limits, remaining);
  if (rpmWarn != null) return { allowed: true, reason: rpmWarn, remaining };

  return { allowed: true, reason: 'ok', remaining };
}

function computeRpmCapacity(
  provider: string,
  limits: RateLimits | null,
  headers: HeaderCapacity | null,
  headersFresh: boolean,
): { rpm: number | null; pctRpm: number | null } {
  if (headersFresh && headers?.remainingRequests != null) {
    const rpm = headers.remainingRequests;
    const pctRpm = computePctOfLimit(rpm, limits?.rpm);
    return { rpm, pctRpm };
  }
  if (limits?.rpm != null && limits.rpm !== 0) {
    pruneWindow(_requestTimestamps[provider] ?? []);
    const used = (_requestTimestamps[provider] ?? []).length;
    const rpm = Math.max(0, limits.rpm - used);
    return { rpm, pctRpm: Math.round((rpm / limits.rpm) * 100) };
  }
  return { rpm: null, pctRpm: null };
}

function computePctOfLimit(value: number, limit: number | null | undefined): number | null {
  if (limit == null || limit === 0) return null;
  return Math.round((value / limit) * 100);
}

function computeTpmCapacity(
  provider: string,
  limits: RateLimits | null,
  headers: HeaderCapacity | null,
  headersFresh: boolean,
): { tpm: number | null; pctTpm: number | null } {
  const tpmLimit = limits?.tpm ?? limits?.itpm;
  if (headersFresh && headers != null) {
    const headerTpm = headers.remainingTokens ?? headers.remainingInputTokens;
    if (headerTpm != null) {
      return { tpm: headerTpm, pctTpm: computePctOfLimit(headerTpm, tpmLimit) };
    }
  }
  if (tpmLimit != null && tpmLimit !== 0) {
    pruneTokenWindow(_tokenTimestamps[provider] ?? []);
    const usedTokens = (_tokenTimestamps[provider] ?? []).reduce((sum, e) => sum + e.tokens, 0);
    const tpm = Math.max(0, tpmLimit - usedTokens);
    return { tpm, pctTpm: computePctOfLimit(tpm, tpmLimit) };
  }
  return { tpm: null, pctTpm: null };
}

function computeRpdCapacity(
  provider: string,
  limits: RateLimits | null,
): { rpd: number | null; pctRpd: number | null } {
  if (limits?.rpd != null && limits.rpd !== 0) {
    const d = today();
    const daily = _dailyRequests[provider];
    const used = daily?.date === d ? daily.count : 0;
    const rpd = Math.max(0, limits.rpd - used);
    return { rpd, pctRpd: Math.round((rpd / limits.rpd) * 100) };
  }
  return { rpd: null, pctRpd: null };
}

export function getRemainingCapacity(provider: string, model?: string): RemainingCapacity {
  const limits = model != null && model !== '' ? getEffectiveLimits(provider, model) : null;
  const headers = _headerCapacity[provider] ?? null;
  const headersFresh = headers != null && Date.now() - headers.ts < HEADER_TTL_MS;

  const { rpm, pctRpm } = computeRpmCapacity(provider, limits, headers, headersFresh);
  const { tpm, pctTpm } = computeTpmCapacity(provider, limits, headers, headersFresh);
  const { rpd, pctRpd } = computeRpdCapacity(provider, limits);

  return { rpm, tpm, rpd, pctRpm, pctTpm, pctRpd };
}

export function getHealthiestProvider(candidates: ProviderCandidate[]): ProviderCandidate[] {
  if (candidates.length <= 1) return candidates;

  return [...candidates].sort((a, b) => {
    const capA = getRemainingCapacity(a.provider, a.model);
    const capB = getRemainingCapacity(b.provider, b.model);

    // Score: weighted average of capacity + latency (higher = healthier)
    const scoreA = computeHealthScore(capA, a.provider);
    const scoreB = computeHealthScore(capB, b.provider);

    return scoreB - scoreA; // descending (healthiest first)
  });
}

function computeHealthScore(cap: RemainingCapacity, provider: string): number {
  // Weight RPD higher (most critical constraint, especially for Google free tier)
  let score = 0;
  let weight = 0;
  if (cap.pctRpm != null) {
    score += cap.pctRpm * 1;
    weight += 1;
  }
  if (cap.pctTpm != null) {
    score += cap.pctTpm * 1;
    weight += 1;
  }
  if (cap.pctRpd != null) {
    score += cap.pctRpd * 2;
    weight += 2;
  } // double weight for RPD

  // Factor in latency via PeakEWMA (lower latency → higher score)
  if (provider !== '') {
    const ewma = getProviderEWMA(provider);
    const latencyMs = ewma.get();
    if (latencyMs > 0) {
      // Map latency to a 0-100 score: <500ms → 100, >10s → 0, linear between
      const latencyScore = Math.max(0, Math.min(100, 100 - ((latencyMs - 500) / 9500) * 100));
      score += latencyScore * 1;
      weight += 1;
    }
  }

  if (weight === 0) return 50; // no data → neutral score
  return score / weight;
}

// ── Display ─────────────────────────────────────────────────────────────────

/** Get a formatted rate limit summary for all providers (for :usage command). */
interface RateLimitSummaryEntry {
  provider: string;
  summary: string;
}

export function getRateLimitSummary(): RateLimitSummaryEntry[] {
  const results: RateLimitSummaryEntry[] = [];

  for (const provider of ['openai', 'anthropic', 'google']) {
    const tier = getProviderTier(provider);
    const cap = getRemainingCapacity(provider);
    const parts = [];

    if (cap.rpm != null)
      parts.push(
        `RPM: ${String(cap.rpm)} left${cap.pctRpm == null ? '' : ` (${String(cap.pctRpm)}%)`}`,
      );
    if (cap.tpm != null)
      parts.push(
        `TPM: ${fmtTokens(cap.tpm)} left${cap.pctTpm == null ? '' : ` (${String(cap.pctTpm)}%)`}`,
      );
    if (cap.rpd != null)
      parts.push(
        `RPD: ${String(cap.rpd)} left${cap.pctRpd == null ? '' : ` (${String(cap.pctRpd)}%)`}`,
      );

    if (parts.length === 0) parts.push('no tracking data');

    results.push({
      provider,
      summary: `Tier ${String(tier)} — ${parts.join(' | ')}`,
    });
  }

  return results;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

// ── RPD Persistence ─────────────────────────────────────────────────────────
// Load/save daily request counts alongside provider-usage.json

interface PersistedRpdState {
  rpd?: Record<string, { date: string; count: number } | null>;
}

export function loadRpdState(data: PersistedRpdState | null | undefined): void {
  if (!data?.rpd) return;
  for (const [provider, state] of Object.entries(data.rpd)) {
    const daily = _dailyRequests[provider];
    if (daily && state?.date != null && state.date !== '' && state.count !== 0) {
      daily.date = state.date;
      daily.count = state.count;
    }
  }
}

export function getRpdState(): Record<string, { date: string; count: number }> {
  const out: Record<string, { date: string; count: number }> = {};
  for (const [provider, state] of Object.entries(_dailyRequests)) {
    if (state?.date != null && state.date !== '') {
      out[provider] = { date: state.date, count: state.count };
    }
  }
  return out;
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function _resetState(): void {
  for (const p of ['openai', 'anthropic', 'google']) {
    _requestTimestamps[p] = [];
    _tokenTimestamps[p] = [];
    _dailyRequests[p] = { date: null, count: 0 };
    _headerCapacity[p] = null;
  }
}

// ── Token Bucket Rate Limiter ───────────────────────────────────────────────
// Pre-request enforcement: blocks until tokens are available.
// Merged from hydra-rate-limiter.mjs to consolidate rate limiting in one module.

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class TokenBucket {
  capacity: number;
  tokens: number;
  refillRate: number;
  private _lastRefill: number;

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this._lastRefill = Date.now();
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this._lastRefill = now;
  }

  tryConsume(n = 1): boolean {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async waitForTokens(n = 1): Promise<void> {
    while (!this.tryConsume(n)) {
      const deficit = n - this.tokens;
      const waitMs = Math.max(50, Math.ceil((deficit / this.refillRate) * 1000));
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential: polling loop; must sleep and re-check token availability until the bucket refills
      await sleep(Math.min(waitMs, 5000));
    }
  }

  available(): number {
    this._refill();
    return Math.floor(this.tokens);
  }
}

// ── Per-Provider Limiters ───────────────────────────────────────────────────

const _limiters = new Map<string, TokenBucket>();

const DEFAULT_BUCKET_LIMITS: Record<string, number> = {
  openai: 60,
  anthropic: 50,
  google: 300,
};

export function initRateLimiters(rpsConfig: Record<string, number> = {}): void {
  const limits = { ...DEFAULT_BUCKET_LIMITS, ...rpsConfig };
  for (const [provider, rps] of Object.entries(limits)) {
    const perSecond = rps / 60;
    _limiters.set(provider, new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond));
  }
}

function _getLimiter(provider: string): TokenBucket {
  let limiter = _limiters.get(provider);
  if (limiter == null) {
    const rps = DEFAULT_BUCKET_LIMITS[provider] ?? 60;
    const perSecond = rps / 60;
    limiter = new TokenBucket(Math.max(1, Math.ceil(rps / 6)), perSecond);
    _limiters.set(provider, limiter);
  }
  return limiter;
}

/** Acquire a rate limit token for a provider. Waits if necessary. */
export async function acquireRateLimit(provider: string): Promise<void> {
  const limiter = _getLimiter(provider);
  await limiter.waitForTokens(1);
}

export function tryAcquireRateLimit(provider: string): boolean {
  return _getLimiter(provider).tryConsume(1);
}

interface RateLimitStats {
  available: number;
  capacity: number;
  refillRate: number;
}

export function getRateLimitStats(): Record<string, RateLimitStats> {
  const stats: Record<string, RateLimitStats> = {};
  for (const [provider, limiter] of _limiters) {
    stats[provider] = {
      available: limiter.available(),
      capacity: limiter.capacity,
      refillRate: limiter.refillRate,
    };
  }
  return stats;
}

export function resetRateLimiter(provider?: string): void {
  if (provider != null && provider !== '') {
    const limiter = _limiters.get(provider);
    if (limiter) limiter.tokens = limiter.capacity;
  } else {
    for (const limiter of _limiters.values()) {
      limiter.tokens = limiter.capacity;
    }
  }
}

// ── System-Wide Concurrency ─────────────────────────────────────────────────

let _activeCount = 0;
let _maxInFlight = 3;

export function initConcurrency(maxInFlight = 3): void {
  _maxInFlight = maxInFlight;
}

export async function acquireConcurrencySlot(): Promise<() => void> {
  while (_activeCount >= _maxInFlight) {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: polling loop; must sleep and re-check the active-count until a concurrency slot becomes available
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

export function tryAcquireConcurrencySlot(): (() => void) | null {
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

export function getConcurrencyStats(): {
  active: number;
  maxInFlight: number;
  utilization: number;
} {
  return {
    active: _activeCount,
    maxInFlight: _maxInFlight,
    utilization: _maxInFlight > 0 ? _activeCount / _maxInFlight : 0,
  };
}
