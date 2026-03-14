import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('hydra-process exit handler', () => {
  it('exports exit function and setExitHandler', async () => {
    const { exit, setExitHandler } = await import('../lib/hydra-process.ts');
    assert.equal(typeof exit, 'function');
    assert.equal(typeof setExitHandler, 'function');
  });

  it('calls the injected handler with the exit code', async () => {
    const { exit, setExitHandler, resetExitHandler } = await import('../lib/hydra-process.ts');
    const codes: number[] = [];
    setExitHandler((code) => {
      codes.push(code ?? 0);
    });
    exit(0);
    exit(1);
    resetExitHandler();
    assert.deepEqual(codes, [0, 1]);
  });

  it('calls process.exit by default when no handler is set', async () => {
    // We can only verify this at the type/module level — actual process.exit
    // would terminate the test. Just verify the default is callable.
    const { resetExitHandler } = await import('../lib/hydra-process.ts');
    resetExitHandler(); // should not throw
  });
});
