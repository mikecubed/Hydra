import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SystemClock, FakeClock } from '../clock.ts';

describe('FakeClock', () => {
  it('returns initial time', () => {
    const clock = new FakeClock(1000);
    assert.equal(clock.now(), 1000);
  });

  it('advances time', () => {
    const clock = new FakeClock(0);
    clock.advance(5000);
    assert.equal(clock.now(), 5000);
  });

  it('sets absolute time', () => {
    const clock = new FakeClock(0);
    clock.set(999);
    assert.equal(clock.now(), 999);
  });
});

describe('SystemClock', () => {
  it('returns approximately Date.now()', () => {
    const clock = new SystemClock();
    const before = Date.now();
    const ts = clock.now();
    const after = Date.now();
    assert.ok(ts >= before && ts <= after);
  });

  it('is not unreliable by default', () => {
    const clock = new SystemClock();
    clock.now();
    assert.equal(clock.isUnreliable(), false);
  });

  it('detects backward time jump beyond tolerance', () => {
    const clock = new SystemClock(100);
    // Simulate by calling now() with a normal time, then hack lastTimestamp
    clock.now();
    // @ts-expect-error — testing internal state
    clock.lastTimestamp = Date.now() + 200;
    clock.now();
    assert.equal(clock.isUnreliable(), true);
  });

  it('tolerates small drift within tolerance', () => {
    const clock = new SystemClock(30_000);
    clock.now();
    // @ts-expect-error — testing internal state
    clock.lastTimestamp = Date.now() + 100;
    clock.now();
    assert.equal(clock.isUnreliable(), false);
  });

  it('resets state', () => {
    const clock = new SystemClock(100);
    clock.now();
    // @ts-expect-error — testing internal state
    clock.lastTimestamp = Date.now() + 200;
    clock.now();
    assert.equal(clock.isUnreliable(), true);
    clock.reset();
    assert.equal(clock.isUnreliable(), false);
  });
});
