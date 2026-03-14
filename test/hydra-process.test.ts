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

  it('resetExitHandler restores default state so a new handler can be set', async () => {
    const { exit, setExitHandler, resetExitHandler } = await import('../lib/hydra-process.ts');

    // Set a custom handler and verify it works
    let capturedCode: number | undefined;
    setExitHandler((code) => {
      capturedCode = code;
    });
    exit(42);
    assert.equal(capturedCode, 42);

    // Reset, then set a different handler — proves reset clears previous state
    resetExitHandler();
    setExitHandler((code) => {
      capturedCode = (code ?? 0) + 1;
    });
    exit(5);
    assert.equal(capturedCode, 6, 'new handler after reset should receive exit code');

    resetExitHandler();
  });
});
