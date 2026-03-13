/**
 * Shared latency tracking for streaming middleware and provider health scoring.
 */

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

const providerLatency = new Map<string, PeakEWMA>();

/**
 * Get the PeakEWMA tracker for a provider. Creates one if needed.
 */
export function getProviderEWMA(provider: string): PeakEWMA {
  let tracker = providerLatency.get(provider);
  if (!tracker) {
    tracker = new PeakEWMA();
    providerLatency.set(provider, tracker);
  }
  return tracker;
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
