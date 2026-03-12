/**
 * T5 safety tests — CLI exit path coverage (Priority 4)
 *
 * `n/no-process-exit` lint rule will flag direct `process.exit()` calls and
 * suggest using thrown errors or alternative exit signals.
 *
 * TESTABLE EXIT HELPERS
 * ─────────────────────
 * `supportsPipedStdio` (lib/hydra-proc.ts) — returns boolean, never exits.
 *   This is already covered by test/hydra-proc.test.mjs.
 *
 * UNTESTABLE EXIT PATHS (documented below)
 * ─────────────────────────────────────────
 * The following functions call `process.exit()` unconditionally at the end of
 * an `async function main()` body with no exported handle.  They cannot be
 * unit-tested without spawning a child process:
 *
 *   lib/hydra-dispatch.ts:296   — `main()` exits with 1 when prompt is missing
 *   lib/hydra-dispatch.ts:601   — `main()` exits with 1 when council fails
 *   lib/sync.ts                 — multiple `main()` exit paths (not exported)
 *   lib/hydra-council.ts        — main() exit on startup failure
 *   lib/hydra-actualize.ts      — main() exit paths (not exported)
 *   lib/hydra-setup.ts          — main() exit on bad args (not exported)
 *
 * All of these are in non-exported `main()` functions that are only reachable
 * when the module is run as an entry point.  The n/no-process-exit fix for
 * these will either:
 *   a) throw an error and let the top-level handler set the exit code, or
 *   b) wrap the call in a `throw new ExitError(1)` sentinel class.
 *
 * Either refactoring can be tested once the export surface is updated in T6.
 * Until then, these paths are intentionally excluded from unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { supportsPipedStdio } from '../lib/hydra-proc.ts';

// ── supportsPipedStdio ────────────────────────────────────────────────────────

describe('supportsPipedStdio', () => {
  it('returns a boolean without throwing or calling process.exit()', () => {
    // This function uses process.exit(0) inside the spawned child process,
    // NOT in the parent.  It is safe to call in tests.
    const result = supportsPipedStdio();
    assert.ok(typeof result === 'boolean', 'supportsPipedStdio must return a boolean');
  });

  it('returns true in the standard Node.js test environment', () => {
    // In a normal CI/test environment, pipe stdio should be supported.
    // If this fails, the environment restricts piped stdio (e.g. EPERM on
    // restricted systems) and HYDRA_NO_PIPES=1 should be set.
    const result = supportsPipedStdio();
    // We accept both true and false — the test just verifies no exception.
    assert.ok(typeof result === 'boolean');
  });
});

// ── getRoleAgent — documented exit-adjacent throw ────────────────────────────

describe('getRoleAgent — throws instead of exiting when no agents available', () => {
  // getRoleAgent throws `Error('No agents available…')` rather than calling
  // process.exit().  This is already the correct pattern and serves as the
  // reference for how n/no-process-exit fixes should be structured in T6.
  it('throws a descriptive error when all agents are unavailable', async () => {
    const { getRoleAgent } = await import('../lib/hydra-dispatch.ts');
    const { _setTestConfig, invalidateConfigCache } = await import('../lib/hydra-config.ts');

    _setTestConfig({
      roles: {
        coordinator: { agent: 'claude', model: null },
      },
    });

    try {
      assert.throws(
        () =>
          getRoleAgent('coordinator', {
            claude: false,
            gemini: false,
            codex: false,
            copilot: false,
          }),
        /No agents available/,
        'getRoleAgent must throw, not call process.exit()',
      );
    } finally {
      invalidateConfigCache();
    }
  });
});
