/**
 * Compile-time and runtime tests for IContextProvider contract.
 *
 * Verifies that the contextProvider export from hydra-context.ts
 * satisfies the IContextProvider interface defined in types.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IContextProvider } from '../lib/types.ts';
import { contextProvider, buildAgentContext } from '../lib/hydra-context.ts';

// ── Compile-time assignability check ─────────────────────────────────────────
const _typeCheck: IContextProvider = contextProvider;
void _typeCheck; // suppress unused-variable warning

// ── Runtime tests ────────────────────────────────────────────────────────────

describe('IContextProvider — contextProvider export', () => {
  it('exports an object with a buildAgentContext method', () => {
    assert.ok(contextProvider, 'contextProvider should be truthy');
    assert.equal(typeof contextProvider.buildAgentContext, 'function');
  });

  it('contextProvider.buildAgentContext is the same function as the named export', () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    assert.strictEqual(contextProvider.buildAgentContext, buildAgentContext);
  });

  it('buildAgentContext returns a string when called with no arguments', () => {
    const result = contextProvider.buildAgentContext();
    assert.equal(typeof result, 'string');
  });
});
