import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('hydra-local', () => {
  it('exports streamLocalCompletion', async () => {
    const mod = await import('../lib/hydra-local.mjs');
    assert.strictEqual(typeof mod.streamLocalCompletion, 'function');
  });

  it('returns local-unavailable on ECONNREFUSED', async () => {
    const { streamLocalCompletion } = await import('../lib/hydra-local.mjs');
    // Port 19999 is almost certainly unused
    const result = await streamLocalCompletion(
      [{ role: 'user', content: 'hello' }],
      { model: 'test', baseUrl: 'http://localhost:19999/v1' }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCategory, 'local-unavailable');
    assert.strictEqual(result.output, '');
  });
});
