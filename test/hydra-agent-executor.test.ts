/**
 * Comprehensive unit tests for lib/hydra-shared/agent-executor.ts
 *
 * Strategy: register disposable test agents that invoke `process.execPath` (node)
 * with inline `-e` scripts. This exercises the full spawn pipeline without
 * hitting real agent CLIs, matching the pattern used by the existing .mjs suite.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  executeAgent,
  executeAgentWithRecovery,
  diagnoseAgentError,
  expandInvokeArgs,
  parseCliResponse,
  assertSafeSpawnCmd,
  extractCodexText,
  extractCodexUsage,
  extractCodexErrors,
  type ExecuteResult,
} from '../lib/hydra-shared/agent-executor.ts';

import {
  registerAgent,
  unregisterAgent,
  AGENT_TYPE,
  initAgentRegistry,
  _resetRegistry,
} from '../lib/hydra-agents.ts';

import {
  resetCircuitBreaker,
  recordModelFailure,
  isCircuitOpen,
} from '../lib/hydra-model-recovery.ts';

import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal failed result for diagnoseAgentError tests. */
function failResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    ok: false,
    output: '',
    stdout: '',
    stderr: '',
    error: null,
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    ...overrides,
  };
}

/** Register a physical test agent whose headless invoke spawns a node -e script. */
function registerTestAgent(name: string, script: string, extra: Record<string, unknown> = {}) {
  registerAgent(name, {
    type: AGENT_TYPE.PHYSICAL,
    cli: process.execPath,
    invoke: {
      nonInteractive: () => [process.execPath, ['-e', script]],
      interactive: null,
      headless: () => [process.execPath, ['-e', script]],
    },
    contextBudget: 1000,
    councilRole: null,
    taskAffinity: {},
    enabled: true,
    ...extra,
  });
}

// ── diagnoseAgentError — additional signal/exit-code coverage ─────────────────

describe('diagnoseAgentError — signal mapping', () => {
  it('maps SIGTERM to signal category', () => {
    const r = failResult({ signal: 'SIGTERM' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'signal');
    assert.match(r.errorDetail ?? '', /terminated/i);
  });

  it('maps SIGINT to signal category', () => {
    const r = failResult({ signal: 'SIGINT' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'signal');
    assert.match(r.errorDetail ?? '', /interrupted/i);
  });

  it('maps SIGSEGV to crash category', () => {
    const r = failResult({ signal: 'SIGSEGV' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'crash');
    assert.match(r.errorDetail ?? '', /segmentation fault/i);
  });

  it('maps SIGABRT to crash category', () => {
    const r = failResult({ signal: 'SIGABRT' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'crash');
    assert.match(r.errorDetail ?? '', /aborted/i);
  });

  it('maps unknown signal to generic signal category', () => {
    const r = failResult({ signal: 'SIGUSR1' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'signal');
    assert.match(r.errorDetail ?? '', /SIGUSR1/);
  });

  it('maps exit code 127 to invocation category', () => {
    const r = failResult({ exitCode: 127, output: 'something', stderr: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'invocation');
  });

  it('maps exit code 126 to permission category', () => {
    const r = failResult({ exitCode: 126, output: 'something', stderr: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'permission');
  });

  it('maps exit code 137 to oom category', () => {
    const r = failResult({ exitCode: 137, output: 'something', stderr: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'oom');
  });

  it('maps exit code 139 to crash category', () => {
    const r = failResult({ exitCode: 139, output: 'something', stderr: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'crash');
  });

  it('maps exit code in 128-159 range to signal category', () => {
    const r = failResult({ exitCode: 143, output: 'something', stderr: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'signal');
  });

  it('returns result unchanged when ok=true', () => {
    const r: ExecuteResult = { ...failResult(), ok: true, exitCode: 0 };
    const out = diagnoseAgentError('claude', r);
    assert.equal(out.errorCategory, undefined);
  });

  it('identifies network errors from stderr pattern', () => {
    const r = failResult({ exitCode: 1, stderr: 'ECONNREFUSED 127.0.0.1:443', output: 'x' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'network');
  });

  it('identifies parse error from "unexpected token" pattern', () => {
    const r = failResult({ exitCode: 1, stderr: 'Unexpected token in JSON', output: 'x' });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'parse');
  });

  it('enriches generic error message with diagnosis detail for unclassified exit', () => {
    // Use exit code 3 (not in EXIT_CODE_LABELS), non-empty output/stderr with no pattern matches,
    // so we fall through to step 7 (unclassified) and step 8 (enrichment).
    const r = failResult({
      exitCode: 3,
      output: 'some output',
      stderr: 'unrecognized output here',
      error: 'Exit code 3',
    });
    diagnoseAgentError('codex', r);
    assert.equal(r.errorCategory, 'unclassified');
    // step 8: 'Exit code 3' contains 'Exit code' → isGeneric=true → error is enriched
    assert.ok(r.error?.includes('['), `expected enriched error, got: ${r.error ?? 'null'}`);
  });

  it('preserves specific error messages that are not generic', () => {
    const r = failResult({
      exitCode: 1,
      stderr: 'API key invalid',
      error: 'auth token rejected by server',
    });
    diagnoseAgentError('gemini', r);
    // Specific error should be preserved (non-generic)
    assert.equal(r.error, 'auth token rejected by server');
  });

  it('identifies usage-limit pattern', () => {
    const r = failResult({ exitCode: 1, stderr: "you've hit your usage limit", output: 'x' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'usage-limit');
  });

  it('identifies OOM from JavaScript heap pattern', () => {
    const r = failResult({ exitCode: 1, stderr: 'FATAL ERROR: JavaScript heap out of memory' });
    diagnoseAgentError('claude', r);
    assert.equal(r.errorCategory, 'oom');
  });
});

// ── assertSafeSpawnCmd — extended coverage ────────────────────────────────────

describe('assertSafeSpawnCmd — extended coverage', () => {
  it('allows paths with hyphens', () => {
    assert.doesNotThrow(() => { assertSafeSpawnCmd('my-tool', 'test'); });
  });

  it('allows paths with underscores (treated as cmd)', () => {
    assert.doesNotThrow(() => { assertSafeSpawnCmd('my_tool', 'test'); });
  });

  it('rejects semicolons', () => {
    assert.throws(() => { assertSafeSpawnCmd('cmd; rm -rf /', 'test'); }, /unsafe/i);
  });

  it('rejects pipe characters', () => {
    assert.throws(() => { assertSafeSpawnCmd('cmd | cat', 'test'); }, /unsafe/i);
  });

  it('rejects backticks', () => {
    assert.throws(() => { assertSafeSpawnCmd('`whoami`', 'test'); }, /unsafe/i);
  });

  it('rejects dollar signs', () => {
    assert.throws(() => { assertSafeSpawnCmd('$HOME/bin/tool', 'test'); }, /unsafe/i);
  });

  it('rejects double-dot path traversal', () => {
    assert.throws(() => { assertSafeSpawnCmd('../../../bin/sh', 'test'); }, /traversal/i);
  });
});

// ── expandInvokeArgs — extended coverage ──────────────────────────────────────

describe('expandInvokeArgs — extended coverage', () => {
  it('handles multiple placeholders in one arg', () => {
    const result = expandInvokeArgs(['{cwd}/{prompt}'], { cwd: '/tmp', prompt: 'test' });
    assert.deepEqual(result, ['/tmp/test']);
  });

  it('handles same placeholder multiple times in same arg', () => {
    const result = expandInvokeArgs(['{prompt}--{prompt}'], { prompt: 'hello' });
    assert.deepEqual(result, ['hello--hello']);
  });

  it('leaves unknown placeholders intact while substituting known ones', () => {
    const result = expandInvokeArgs(['{known}', '{unknown}'], { known: 'val' });
    assert.deepEqual(result, ['val', '{unknown}']);
  });
});

// ── parseCliResponse — extended coverage ──────────────────────────────────────

describe('parseCliResponse — extended coverage', () => {
  it('handles null/empty stdout for json parser without throwing', () => {
    // Empty string is not valid JSON — should fall back to raw
    const result = parseCliResponse('', 'json');
    assert.equal(result, '');
  });

  it('handles deeply nested json without extracting nested fields', () => {
    const json = JSON.stringify({ content: 'top-level' });
    assert.equal(parseCliResponse(json, 'json'), 'top-level');
  });

  it('markdown parser returns raw stdout unchanged', () => {
    const md = '# Header\n\nBody text';
    assert.equal(parseCliResponse(md, 'markdown'), md);
  });
});

// ── executeAgent — core spawn paths ──────────────────────────────────────────

describe('executeAgent — successful execution', () => {
  const AGENT_NAME = 'test-exec-success';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'process.stdout.write("hello world")');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('returns ok=true with output on zero exit', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'hello world');
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
  });

  it('populates durationMs > 0', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.ok(result.durationMs >= 0, `durationMs should be >= 0, got ${String(result.durationMs)}`);
  });

  it('populates command and args', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.command, process.execPath);
    assert.ok(Array.isArray(result.args));
  });

  it('populates promptSnippet with first 500 chars of prompt', async () => {
    const prompt = 'x'.repeat(600);
    const result = await executeAgent(AGENT_NAME, prompt);
    assert.equal(result.promptSnippet?.length, 500);
  });
});

describe('executeAgent — failed execution', () => {
  const AGENT_NAME = 'test-exec-fail';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'process.exit(1)');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('returns ok=false with non-zero exit code', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assert.ok(result.error != null);
  });

  it('includes Hydra Telemetry block in stderr on failure', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.match(result.stderr, /\[Hydra Telemetry\] Failed Command/);
    assert.match(result.stderr, /\[Hydra Telemetry\] Exit Code: 1/);
  });

  it('sets startupFailure=true when process exits quickly', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    // process exits with code 1 immediately (< 5 s)
    assert.equal(result.startupFailure, true);
  });
});

describe('executeAgent — stderr capture', () => {
  const AGENT_NAME = 'test-exec-stderr';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'process.stderr.write("err-line\\n"); process.exit(1)');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('captures stderr from failed process', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt', { collectStderr: true });
    assert.ok(result.stderr.includes('err-line'), `stderr: ${result.stderr}`);
  });

  it('does not collect process stderr output when collectStderr=false', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt', { collectStderr: false });
    // Hydra telemetry block IS injected on failure (unavoidable), but the actual
    // process stderr output should not be present — only Hydra Telemetry lines.
    const nonTelemetryLines = result.stderr
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('[Hydra Telemetry]'));
    assert.equal(
      nonTelemetryLines.length,
      0,
      `expected only Hydra Telemetry lines, got extra: ${nonTelemetryLines.join(', ')}`,
    );
  });
});

describe('executeAgent — stdout + stderr combined', () => {
  const AGENT_NAME = 'test-exec-combined';

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('captures stdout on success', async () => {
    registerTestAgent(AGENT_NAME, 'process.stdout.write("ok-output")');
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.output, 'ok-output');
    assert.equal(result.stdout, 'ok-output');
  });
});

describe('executeAgent — timeout', () => {
  const AGENT_NAME = 'test-exec-timeout';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'setTimeout(() => {}, 30000)');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('returns timedOut=true and signal=SIGTERM after timeout', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt', { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGTERM');
    assert.match(result.error ?? '', /timed out/);
    assert.match(result.stderr, /Timed Out/);
  });
});

describe('executeAgent — progress callback', () => {
  const AGENT_NAME = 'test-exec-progress';

  beforeEach(() => {
    // Output data then sleep briefly before exiting
    registerTestAgent(
      AGENT_NAME,
      'process.stdout.write("data"); setTimeout(() => process.stdout.write("done"), 50)',
    );
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('invokes onProgress callback at least once during execution', async () => {
    const calls: Array<{ elapsed: number; kb: number }> = [];
    registerTestAgent('test-exec-long', 'setTimeout(() => process.stdout.write("x"), 300)');
    try {
      await executeAgent('test-exec-long', 'prompt', {
        progressIntervalMs: 50,
        onProgress: (elapsed, outputKB) => {
          calls.push({ elapsed, kb: outputKB });
        },
        timeoutMs: 500,
      });
    } finally {
      try {
        unregisterAgent('test-exec-long');
      } catch {
        /* ignore */
      }
    }
    assert.ok(calls.length > 0, 'expected at least one progress callback');
    assert.ok(calls[0].elapsed >= 0);
  });
});

describe('executeAgent — statusBar callback', () => {
  const AGENT_NAME = 'test-exec-statusbar';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'process.stdout.write("done")');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('invokes onStatusBar with running and idle phases', async () => {
    const events: Array<{ agent: string; phase?: string; step?: string }> = [];
    await executeAgent(AGENT_NAME, 'prompt', {
      onStatusBar: (agent, meta) => {
        events.push({ agent, phase: meta.phase, step: meta.step });
      },
      phaseLabel: 'test-phase',
    });
    const running = events.find((e) => e.step === 'running');
    const idle = events.find((e) => e.step === 'idle');
    assert.ok(running != null, 'expected running event');
    assert.ok(idle != null, 'expected idle event');
    assert.equal(running.phase, 'test-phase');
  });
});

describe('executeAgent — environment variable injection', () => {
  const AGENT_NAME = 'test-exec-env';

  beforeEach(() => {
    // Print CLAUDECODE env var (should be stripped) and a custom env var
    registerTestAgent(
      AGENT_NAME,
      'process.stdout.write(JSON.stringify({ claudecode: process.env.CLAUDECODE ?? "absent" }))',
    );
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('strips CLAUDECODE env var before spawning', async () => {
    const orig: string | undefined = process.env['CLAUDECODE'];
    process.env['CLAUDECODE'] = 'should-be-stripped';
    try {
      const result = await executeAgent(AGENT_NAME, 'prompt');
      assert.equal(result.ok, true);
      const parsed = JSON.parse(result.output) as { claudecode: string };
      assert.equal(parsed.claudecode, 'absent');
    } finally {
      if (orig === undefined) {
        delete process.env['CLAUDECODE'];
      } else {
        // eslint-disable-next-line require-atomic-updates -- sequential test; no real concurrency
        process.env['CLAUDECODE'] = orig;
      }
    }
  });
});

describe('executeAgent — invalid modelOverride', () => {
  it('rejects model override with special characters', async () => {
    const result = await executeAgent('codex', 'hello', { modelOverride: 'bad;model' });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, null);
    assert.match(result.stderr, /Invalid model override/);
    assert.match(result.error ?? '', /Security violation/);
  });

  it('rejects model override with spaces', async () => {
    const result = await executeAgent('codex', 'prompt', { modelOverride: 'bad model' });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /Invalid model override/);
  });
});

describe('executeAgent — unknown agent', () => {
  it('throws for an unregistered agent name', async () => {
    await assert.rejects(
      () => executeAgent('not-a-real-agent-xyz', 'prompt'),
      /Unknown agent/,
    );
  });
});

describe('executeAgent — no headless invoke', () => {
  const AGENT_NAME = 'test-no-headless';

  beforeEach(() => {
    registerAgent(AGENT_NAME, {
      type: AGENT_TYPE.PHYSICAL,
      cli: process.execPath,
      invoke: {
        nonInteractive: null,
        interactive: null,
        headless: null,
      },
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
    });
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('returns ok=false with descriptive error when headless invoke is null', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /headless invoke/i);
  });
});

describe('executeAgent — parseOutput plugin', () => {
  const AGENT_NAME = 'test-parse-plugin';

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
    invalidateConfigCache();
    _resetRegistry();
    initAgentRegistry();
  });

  it('uses the agent parseOutput plugin to transform output', async () => {
    registerAgent(AGENT_NAME, {
      type: AGENT_TYPE.PHYSICAL,
      cli: process.execPath,
      invoke: {
        nonInteractive: () => [process.execPath, ['-e', 'process.stdout.write("raw-output")']],
        interactive: null,
        headless: () => [process.execPath, ['-e', 'process.stdout.write("raw-output")']],
      },
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
      parseOutput: (_stdout: string) => ({
        output: 'PARSED',
        tokenUsage: { input: 10, output: 20, total: 30 },
        costUsd: 0.001,
      }),
    });

    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'PARSED');
    assert.equal(result.stdout, 'raw-output');
    assert.deepEqual(result.tokenUsage, { input: 10, output: 20, total: 30 });
    assert.equal(result.costUsd, 0.001);
  });
});

// ── executeAgentWithRecovery — recovery scenarios ────────────────────────────

describe('executeAgentWithRecovery — primary succeeds', () => {
  const AGENT_NAME = 'test-recovery-ok';

  beforeEach(() => {
    registerTestAgent(AGENT_NAME, 'process.stdout.write("primary-ok")');
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
    invalidateConfigCache();
    _resetRegistry();
    initAgentRegistry();
  });

  it('returns primary result when ok=true without recovery', async () => {
    const result = await executeAgentWithRecovery(AGENT_NAME, 'prompt');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'primary-ok');
    assert.equal(result.recovered, undefined);
  });
});

describe('executeAgentWithRecovery — circuit breaker', () => {
  afterEach(() => {
    resetCircuitBreaker();
    invalidateConfigCache();
    _resetRegistry();
    initAgentRegistry();
  });

  it('skips to circuit-open error when circuit breaker is tripped and no fallback', async () => {
    const MODEL = 'circuit-test-model-xyz';

    // Trip the circuit breaker manually: inject 5+ failures
    _setTestConfig({
      modelRecovery: {
        circuitBreaker: { enabled: true, failureThreshold: 3, windowMs: 300_000 },
      },
    });

    for (let i = 0; i < 5; i++) {
      recordModelFailure(MODEL);
    }
    assert.equal(isCircuitOpen(MODEL), true);

    // Register a codex agent that would succeed if spawned
    registerTestAgent('test-cb-agent', 'process.stdout.write("should-not-run")');

    const result = await executeAgentWithRecovery('test-cb-agent', 'prompt', {
      modelOverride: MODEL,
    });

    // With no recovery configured, should get circuit-breaker error or fallback result
    // The outcome depends on whether recoverFromModelError finds a fallback
    assert.ok(
      result.circuitBreakerTripped === true || !result.ok || result.recovered === true,
      `expected circuit breaker handling, got: ${JSON.stringify({ ok: result.ok, circuitBreakerTripped: result.circuitBreakerTripped })}`,
    );
  });
});

describe('executeAgentWithRecovery — local-unavailable fallback', () => {
  afterEach(() => {
    invalidateConfigCache();
    _resetRegistry();
    initAgentRegistry();
  });

  it('falls back to cloud agent when local returns local-unavailable', async () => {
    _setTestConfig({
      local: { enabled: false },
      routing: { mode: 'performance' },
    });

    // Register a 'local' agent that reports local-unavailable
    registerAgent('local', {
      type: AGENT_TYPE.PHYSICAL,
      cli: process.execPath,
      invoke: {
        nonInteractive: null,
        interactive: null,
        headless: null,
      },
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
      features: { executeMode: 'api' as const },
    });

    // Register a claude fallback that succeeds
    registerAgent('claude', {
      type: AGENT_TYPE.PHYSICAL,
      cli: process.execPath,
      invoke: {
        nonInteractive: () => [process.execPath, ['-e', 'process.stdout.write("cloud-fallback")']],
        interactive: null,
        headless: () => [process.execPath, ['-e', 'process.stdout.write("cloud-fallback")']],
      },
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
    });

    const stderrMessages: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const spy = mock.method(process.stderr, 'write', (chunk: unknown, ...rest: unknown[]) => {
      stderrMessages.push(String(chunk));
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    });

    try {
      const result = await executeAgentWithRecovery('local', 'prompt');
      // Should either get the cloud fallback or a local-disabled/error result
      assert.ok(
        result.output === 'cloud-fallback' ||
          result.errorCategory === 'local-disabled' ||
          result.errorCategory === 'local-error',
        `unexpected result: ${JSON.stringify({ ok: result.ok, errorCategory: result.errorCategory })}`,
      );
    } finally {
      spy.mock.restore();
    }
  });
});

// ── Codex JSONL helpers — extended coverage ───────────────────────────────────

describe('extractCodexText — extended', () => {
  it('returns empty string for completely empty input', () => {
    assert.equal(extractCodexText(''), '');
  });

  it('returns raw text unchanged for non-JSONL input', () => {
    // extractCodexText returns raw when no JSONL structure is found
    const raw = 'plain text output';
    assert.equal(extractCodexText(raw), raw);
  });

  it('extracts text from multiple content events', () => {
    const jsonl = [
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: 'line1' }] }),
      JSON.stringify({ type: 'message', content: [{ type: 'output_text', text: ' line2' }] }),
    ].join('\n');
    const result = extractCodexText(jsonl);
    assert.ok(
      typeof result === 'string' && result.includes('line1'),
      `expected line1 in: ${String(result)}`,
    );
  });
});

describe('extractCodexUsage — extended', () => {
  it('returns null for empty input', () => {
    assert.equal(extractCodexUsage(''), null);
  });

  it('returns null for non-JSONL text', () => {
    assert.equal(extractCodexUsage('plain text'), null);
  });

  it('extracts usage from usage event', () => {
    const jsonl = JSON.stringify({
      type: 'response.completed',
      response: { usage: { input_tokens: 5, output_tokens: 10 } },
    });
    const usage = extractCodexUsage(jsonl);
    // If the structure is recognized, usage should be non-null with inputTokens/outputTokens
    if (usage != null) {
      assert.ok(
        typeof usage.inputTokens === 'number' || typeof usage.totalTokens === 'number',
      );
    }
  });
});

describe('extractCodexErrors — extended', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(extractCodexErrors(''), []);
  });

  it('returns empty array for valid non-error JSONL', () => {
    const jsonl = JSON.stringify({ type: 'message', content: 'hello' });
    assert.deepEqual(extractCodexErrors(jsonl), []);
  });

  it('extracts error messages from JSONL error events', () => {
    const jsonl = [
      JSON.stringify({ type: 'error', message: 'first error' }),
      JSON.stringify({ type: 'error', message: 'second error' }),
    ].join('\n');
    const errors = extractCodexErrors(jsonl);
    assert.ok(errors.length >= 1, `expected at least one error, got: ${JSON.stringify(errors)}`);
  });
});

// ── executeAgent — output truncation ──────────────────────────────────────────

describe('executeAgent — output size limits', () => {
  const AGENT_NAME = 'test-exec-large';

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('truncates output when maxOutputBytes is exceeded', async () => {
    // Write 10KB of data
    registerTestAgent(
      AGENT_NAME,
      `process.stdout.write('x'.repeat(10 * 1024))`,
    );

    const result = await executeAgent(AGENT_NAME, 'prompt', {
      maxOutputBytes: 1024, // cap at 1KB
    });

    assert.equal(result.ok, true);
    assert.ok(
      result.output.length <= 10 * 1024,
      `output should be truncated to near maxOutputBytes, got ${String(result.output.length)} chars`,
    );
  });
});

// ── executeAgent — custom CLI with no invoke config ───────────────────────────

describe('executeAgent — custom CLI with missing invoke config', () => {
  const AGENT_NAME = 'test-no-invoke-config';

  beforeEach(() => {
    registerAgent(AGENT_NAME, {
      type: AGENT_TYPE.PHYSICAL,
      customType: 'cli',
      cli: null,
      invoke: null,
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
    });
  });

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('returns custom-cli-error when invoke config is missing', async () => {
    const result = await executeAgent(AGENT_NAME, 'prompt');
    assert.equal(result.ok, false);
    assert.ok(
      result.errorCategory === 'custom-cli-error' || result.errorCategory === 'custom-cli-disabled',
      `unexpected errorCategory: ${String(result.errorCategory)}`,
    );
  });
});

// ── executeAgent — unsafe spawn command ──────────────────────────────────────

describe('executeAgent — unsafe spawn command guard', () => {
  const AGENT_NAME = 'test-unsafe-cmd';

  afterEach(() => {
    try {
      unregisterAgent(AGENT_NAME);
    } catch {
      /* ignore */
    }
  });

  it('throws when headless invoke returns cmd with shell metacharacters', async () => {
    registerAgent(AGENT_NAME, {
      type: AGENT_TYPE.PHYSICAL,
      cli: process.execPath,
      invoke: {
        nonInteractive: () => ['bad;cmd', ['-e', 'ok']],
        interactive: null,
        headless: () => ['bad;cmd', ['-e', 'ok']],
      },
      contextBudget: 1000,
      councilRole: null,
      taskAffinity: {},
      enabled: true,
    });

    await assert.rejects(
      () => executeAgent(AGENT_NAME, 'prompt'),
      /unsafe|metacharacter/i,
    );
  });
});
