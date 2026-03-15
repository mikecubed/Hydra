/**
 * Injectable clock abstraction for all time-dependent logic.
 *
 * Supports fake clock injection for tests and monotonicity checking
 * with configurable tolerance (FR-018 — fail closed on drift).
 */

export interface Clock {
  now(): number;
}

const DEFAULT_DRIFT_TOLERANCE_MS = 30_000;

export class SystemClock implements Clock {
  private lastTimestamp = 0;
  private readonly driftToleranceMs: number;
  private unreliable = false;

  constructor(driftToleranceMs = DEFAULT_DRIFT_TOLERANCE_MS) {
    this.driftToleranceMs = driftToleranceMs;
  }

  now(): number {
    const ts = Date.now();
    if (this.lastTimestamp > 0 && ts < this.lastTimestamp - this.driftToleranceMs) {
      this.unreliable = true;
    }
    this.lastTimestamp = ts;
    return ts;
  }

  isUnreliable(): boolean {
    return this.unreliable;
  }

  reset(): void {
    this.lastTimestamp = 0;
    this.unreliable = false;
  }
}

export class FakeClock implements Clock {
  private time: number;

  constructor(initialTime = 0) {
    this.time = initialTime;
  }

  now(): number {
    return this.time;
  }

  set(time: number): void {
    this.time = time;
  }

  advance(ms: number): void {
    this.time += ms;
  }
}
