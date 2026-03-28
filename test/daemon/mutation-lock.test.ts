import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configMutex } from '../../lib/daemon/mutation-lock.ts';

describe('mutation-lock', () => {
  it('second acquire waits until first releases', async () => {
    const order: string[] = [];

    const release1 = await configMutex.acquire();
    order.push('acquired-1');

    const second = configMutex.acquire().then((release2) => {
      order.push('acquired-2');
      release2();
    });

    // Second hasn't acquired yet because first hasn't released
    await new Promise((r) => {
      setTimeout(r, 20);
    });
    assert.deepStrictEqual(order, ['acquired-1']);

    release1();
    await second;
    assert.deepStrictEqual(order, ['acquired-1', 'acquired-2']);
  });

  it('release allows next caller to proceed', async () => {
    const release = await configMutex.acquire();
    let secondAcquired = false;

    const p = configMutex.acquire().then((r) => {
      secondAcquired = true;
      r();
    });

    await new Promise((r) => {
      setTimeout(r, 10);
    });
    assert.equal(secondAcquired, false, 'second should not yet have acquired');

    release();
    await p;
    assert.equal(secondAcquired, true, 'second should have acquired after release');
  });

  it('no deadlock in a loop of 10 acquire/release cycles', async () => {
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const release = await configMutex.acquire();
      results.push(i);
      release();
    }
    assert.equal(results.length, 10);
    assert.deepStrictEqual(results, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
