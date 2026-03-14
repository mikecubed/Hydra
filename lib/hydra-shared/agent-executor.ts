/**
 * Shared Agent Executor — Unified executeAgent() with all options from both pipelines.
 *
 * Features adopted from evolve:
 *   - Stderr capture (32KB buffer)
 *   - Stdin piping (avoids Windows 8191-char limit)
 *   - Progress ticking (elapsed + KB every N seconds)
 *   - Status bar integration
 *   - Configurable output buffer size (default 128KB)
 *
 * Features from nightly:
 *   - Simple agent dispatch (claude/codex)
 *   - Timeout + kill
 */

// @ts-expect-error cross-spawn has no type declarations
import _spawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
const spawn = _spawn as (cmd: string, args: string[], opts?: SpawnOptions) => ChildProcess;
import path from 'node:path';
import { getActiveModel, getReasoningEffort, getAgent } from '../hydra-agents.ts';
import {
  detectModelError,
  recoverFromModelError,
  isModelRecoveryEnabled,
  detectUsageLimitError,
  formatResetTime,
  detectRateLimitError,
  calculateBackoff,
  isCircuitOpen,
  recordModelFailure,
  verifyAgentQuota,
} from '../hydra-model-recovery.ts';
import { loadHydraConfig } from '../hydra-config.ts';
import {
  startAgentSpan,
  endAgentSpan,
  startPipelineSpan,
  endPipelineSpan,
} from '../hydra-telemetry.ts';
import { recordCallStart, recordCallComplete, recordCallError } from '../hydra-metrics.ts';
import { streamLocalCompletion } from '../hydra-local.ts';
import {
  registerSession as hubRegister,
  deregisterSession as hubDeregister,
} from '../hydra-hub.ts';
import {
  extractCodexText,
  extractCodexUsage,
  extractCodexErrors as _extractCodexErrors,
} from './codex-helpers.ts';
import type {
  TokenUsage,
  PermissionMode,
  HeadlessOpts,
  ExecuteResult,
  ProgressCallback,
  StatusBarCallback,
} from '../types.ts';
import { diagnoseAgentError } from './error-diagnosis.ts';
export { diagnoseAgentError } from './error-diagnosis.ts';
import { executeGeminiDirect } from './gemini-executor.ts';
import type { GeminiDirectOpts } from './gemini-executor.ts';
import {
  assertSafeSpawnCmd,
  executeCustomCliAgent,
  executeCustomApiAgent,
} from './execute-custom-agents.ts';
export { expandInvokeArgs, parseCliResponse, assertSafeSpawnCmd } from './execute-custom-agents.ts';

export type { ExecuteResult } from '../types.ts';

/** Options for executeAgent() */
export interface ExecuteAgentOpts {
  cwd?: string;
  timeoutMs?: number;
  modelOverride?: string;
  reasoningEffort?: string;
  collectStderr?: boolean;
  useStdin?: boolean;
  progressIntervalMs?: number;
  onProgress?: ProgressCallback;
  onStatusBar?: StatusBarCallback;
  maxOutputBytes?: number;
  maxStderrBytes?: number;
  phaseLabel?: string;
  permissionMode?: string;
  taskType?: string;
  hubCwd?: string;
  hubAgent?: string;
  hubProject?: string;
  rl?: unknown;
  _localFallback?: boolean;
  _customFallback?: boolean;
}

/** Options for local/custom agent execution */
interface LocalAgentOpts {
  timeoutMs?: number;
  onProgress?: ProgressCallback;
  onStatusBar?: StatusBarCallback;
  phaseLabel?: string;
  modelOverride?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 128 * 1024;

// Map Hydra internal permission modes to Claude CLI --permission-mode values
const CLAUDE_PERM_MAP: Record<string, string> = {
  'auto-edit': 'acceptEdits',
  plan: 'plan',
  'full-auto': 'bypassPermissions',
  default: 'default',
};
function _resolveClaudePerm(mode: string): string {
  return CLAUDE_PERM_MAP[mode] === '' ? mode : CLAUDE_PERM_MAP[mode]; // pass through if already a valid CLI value
}
void _resolveClaudePerm; // retain for future use

// ── Codex JSONL Helpers ────────────────────────────────────────────────────
// Re-exported from codex-helpers.mjs for backward compatibility with any
// external callers that import directly from agent-executor.ts.
export { extractCodexText, extractCodexUsage };
export { _extractCodexErrors as extractCodexErrors };

// Internal alias used by diagnoseAgentError below.
const extractCodexErrors = _extractCodexErrors;

// ── Local Agent (OpenAI-compat HTTP) ─────────────────────────────────────────

async function executeLocalAgent(
  prompt: string,
  opts: LocalAgentOpts = {},
): Promise<ExecuteResult> {
  const {
    timeoutMs: _timeoutMs = 3 * 60 * 1000,
    onProgress,
    onStatusBar: _onStatusBar,
    phaseLabel,
    modelOverride,
  } = opts;
  void _timeoutMs;
  void _onStatusBar; // reserved for future use

  const cfg = loadHydraConfig();
  if (!cfg.local.enabled) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Local agent not enabled. Set config.local.enabled = true.',
      error: 'local-disabled',
      errorCategory: 'local-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const baseUrl = cfg.local.baseUrl;
  const model = modelOverride ?? cfg.local.model;
  const startTime = Date.now();
  const metricsHandle = recordCallStart('local', model);
  const span = await startAgentSpan('local', model, { phase: phaseLabel });

  let output = '';
  try {
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'user', content: prompt },
    ];
    const result = await streamLocalCompletion(
      messages,
      {
        baseUrl,
        model,
        maxTokens: (cfg.local as unknown as Record<string, unknown>)['maxTokens'] as
          | number
          | undefined,
      },
      (chunk: string) => {
        output += chunk;
        if (onProgress) {
          const elapsed = Date.now() - startTime;
          onProgress(elapsed, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
        }
      },
    );

    const durationMs = Date.now() - startTime;

    if (!result.ok) {
      recordCallError(metricsHandle, result.errorCategory);
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return {
        ok: false,
        output: '',
        stdout: '',
        stderr: result.errorCategory ?? 'local-unavailable',
        error: result.errorCategory ?? 'local-unavailable',
        errorCategory: result.errorCategory ?? 'local-unavailable',
        exitCode: null,
        signal: null,
        durationMs,
        timedOut: false,
      };
    }

    recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
    await endAgentSpan(span, { ok: true });
    return {
      ok: true,
      output: result.output,
      stdout: result.output,
      stderr: '',
      error: null,
      exitCode: 0,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, e.message);
    await endAgentSpan(span, { ok: false, error: e.message });
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: e.message,
      error: e.message,
      errorCategory: 'local-error',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  }
}

/** Execute an agent CLI as a headless subprocess. */
export async function executeAgent(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts = {},
): Promise<ExecuteResult> {
  // Validate agent before any side-effects to prevent hub session leaks
  const agentDef = getAgent(agent);
  if (!agentDef) {
    throw new Error(`Unknown agent: "${agent}"`);
  }

  // Hub registration (opt-in via opts.hubCwd)
  let _hubSessId: string | null = null;
  if (opts.hubCwd != null && opts.hubCwd !== '') {
    try {
      _hubSessId = hubRegister({
        agent: opts.hubAgent ?? `${agent}-forge`,
        cwd: opts.hubCwd,
        project: opts.hubProject ?? path.basename(opts.hubCwd),
        focus: prompt.slice(0, 100),
      });
    } catch {
      /* hub is non-critical */
    }
  }

  const _hubCleanup = () => {
    if (_hubSessId != null) {
      try {
        hubDeregister(_hubSessId);
      } catch {
        /* non-critical */
      }
      _hubSessId = null;
    }
  };

  // API-mode agents (local + any custom api-type): call endpoint directly
  if (agentDef.features.executeMode === 'api') {
    // Custom API agents registered via config
    if (agentDef.customType === 'api') {
      try {
        return await executeCustomApiAgent(agent, prompt, opts);
      } finally {
        _hubCleanup();
      }
    }
    // Built-in local agent
    try {
      return await executeLocalAgent(prompt, opts);
    } finally {
      _hubCleanup();
    }
  }

  // Custom CLI agents
  if (agentDef.customType === 'cli') {
    try {
      return await executeCustomCliAgent(agent, prompt, opts);
    } finally {
      _hubCleanup();
    }
  }

  // Route Gemini to executeGeminiDirect via a local sentinel. The sentinel
  // avoids mutating the shared registry definition on every call.
  // When the Gemini CLI bug is fixed, delete this block and the sentinel check below.
  type GeminiSentinel = ['__gemini_direct__', { prompt: string; opts: GeminiDirectOpts }];
  type HeadlessInvokeFn = ((prompt: string, opts?: HeadlessOpts) => [string, string[]]) | null;
  const headlessInvoke: HeadlessInvokeFn | ((p: string, o: HeadlessOpts) => GeminiSentinel) =
    agentDef.name === 'gemini'
      ? (p: string, o: HeadlessOpts): GeminiSentinel => [
          '__gemini_direct__',
          { prompt: p, opts: o as GeminiDirectOpts },
        ]
      : (agentDef.invoke?.headless ?? null);

  const {
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelOverride,
    reasoningEffort: effortOverride,
    collectStderr = true,
    useStdin = true,
    progressIntervalMs = 0,
    onProgress,
    onStatusBar,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    phaseLabel,
    permissionMode,
  } = opts;

  if (modelOverride != null && modelOverride !== '' && !/^[a-zA-Z0-9-.:]+$/.test(modelOverride)) {
    _hubCleanup();
    return {
      ok: false,
      output: '',
      stderr: `Invalid model override format: "${modelOverride}"`,
      error: 'Security violation: invalid model format',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const effectiveModel = modelOverride ?? getActiveModel(agent) ?? 'unknown';

  // OTel tracing
  const spanPromise = startAgentSpan(agent, effectiveModel, {
    phase: phaseLabel,
    taskType: opts.taskType,
  });

  // Metrics recording
  const metricsHandle = recordCallStart(agent, effectiveModel);

  // Resolve headless invocation before the spawn Promise
  if (!headlessInvoke) {
    const error = new Error(`Agent "${agent}" has no headless invoke method`);
    try {
      const span = await spanPromise;
      await endAgentSpan(span, { error: error.message });
    } catch {
      /* best-effort */
    }
    try {
      recordCallError(metricsHandle, error);
    } catch {
      /* best-effort */
    }
    _hubCleanup();
    return {
      ok: false,
      output: '',
      stderr: error.message,
      error: error.message,
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }
  const invokeResult = headlessInvoke(prompt, {
    model: effectiveModel === '' ? undefined : effectiveModel,
    permissionMode: (permissionMode ?? 'auto-edit') as PermissionMode,
    jsonOutput: agentDef.features.jsonOutput,
    reasoningEffort: agentDef.features.reasoningEffort
      ? (effortOverride ?? getReasoningEffort(agent) ?? undefined)
      : undefined,
    cwd,
    stdinPrompt: useStdin && agentDef.features.stdinPrompt,
  });

  // Gemini sentinel: headlessInvoke returns this marker for Gemini
  if (invokeResult[0] === '__gemini_direct__') {
    const sentinelData = invokeResult[1] as { prompt: string; opts: GeminiDirectOpts };
    const geminiOpts: GeminiDirectOpts = {
      ...sentinelData.opts,
      modelOverride: sentinelData.opts.model,
    };
    try {
      return await executeGeminiDirect(sentinelData.prompt, geminiOpts);
    } finally {
      _hubCleanup();
    }
  }

  const _headlessCmd = invokeResult[0];
  const _headlessArgs = invokeResult[1] as string[];
  assertSafeSpawnCmd(_headlessCmd, `Agent '${agent}'`);

  return new Promise<ExecuteResult>((resolve) => {
    const cmd = _headlessCmd;
    const args = _headlessArgs;
    const useStdinForPrompt = useStdin && agentDef.features.stdinPrompt;

    const stdoutChunks: string[] = [];
    let stdoutBytes = 0;
    const stderrChunks: string[] = [];
    let stderrBytes = 0;

    const stdinMode = useStdinForPrompt ? 'pipe' : 'ignore';

    // Strip CLAUDECODE env var so nested Claude sessions don't get blocked
    const childEnv = { ...process.env };
    delete childEnv['CLAUDECODE'];

    const child = spawn(cmd, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      stdio: [stdinMode, 'pipe', 'pipe'],
    });

    if (useStdinForPrompt && child.stdin != null) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    // stdout and stderr are always defined with stdio: [..., 'pipe', 'pipe']
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (d: string) => {
      stdoutBytes += Buffer.byteLength(d);
      stdoutChunks.push(d);
      // Drop oldest chunks while over the limit (requires ≥2 chunks to avoid
      // discarding all context — handled separately for single-chunk overflow).
      while (stdoutBytes > maxOutputBytes && stdoutChunks.length > 1) {
        const dropped = stdoutChunks.shift() ?? '';
        stdoutBytes -= Buffer.byteLength(dropped);
      }
      // Single-chunk overflow: hard-truncate to keep exactly maxOutputBytes.
      if (stdoutChunks.length === 1 && stdoutBytes > maxOutputBytes) {
        stdoutChunks[0] = stdoutChunks[0].slice(0, maxOutputBytes);
        stdoutBytes = maxOutputBytes;
      }
    });

    if (collectStderr) {
      child.stderr?.on('data', (d: string) => {
        stderrBytes += Buffer.byteLength(d);
        stderrChunks.push(d);
        while (stderrBytes > maxStderrBytes && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift() ?? '';
          stderrBytes -= Buffer.byteLength(dropped);
        }
      });
    }

    const startTime = Date.now();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    let progressTimer = null;
    if (progressIntervalMs > 0 && onProgress) {
      progressTimer = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const outputKB = Math.round(stdoutBytes / 1024);
        onProgress(elapsed, outputKB);
      }, progressIntervalMs);
    }

    if (onStatusBar) {
      onStatusBar(agent, { phase: phaseLabel ?? 'executing', step: 'running' });
    }

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      const output = stdoutChunks.join('');
      let stderr = stderrChunks.join('');

      // Add telemetry to stderr on spawn error
      const fullCmd = `${cmd} ${args.join(' ')}`;
      const telemetry = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Spawn Error: ${err.message}`;
      stderr = `${stderr}\n\n${telemetry}`.trim();

      const result: ExecuteResult = {
        ok: false,
        output,
        stdout: output,
        stderr,
        error: `Spawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startTime,
        timedOut: false,
        command: cmd,
        args,
        promptSnippet: prompt.slice(0, 500),
      };
      diagnoseAgentError(agent, result);
      recordCallError(metricsHandle, result.error);
      spanPromise
        .then((span) => endAgentSpan(span, { ok: false, error: result.error ?? undefined }))
        .catch(() => {});
      _hubCleanup();
      resolve(result);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (onStatusBar) {
        onStatusBar(agent, { phase: phaseLabel ?? 'done', step: 'idle' });
      }
      const rawOutput = stdoutChunks.join('');
      let stderr = stderrChunks.join('');

      let output = rawOutput;
      let tokenUsage: TokenUsage | null = null;
      let jsonlErrors: string[] = [];

      // Agent-specific output parsing via plugin interface
      let costUsd: number | null = null;
      {
        const _agentDef = getAgent(agent);
        if (_agentDef) {
          try {
            const parsed = _agentDef.parseOutput(rawOutput, {
              jsonOutput: _agentDef.features.jsonOutput,
            });
            output = parsed.output;
            tokenUsage = parsed.tokenUsage;
            costUsd = parsed.costUsd ?? null;
          } catch {
            /* use raw */
          }
        }
        // JSONL error extraction for agents with JSON output
        if (_agentDef?.features.jsonOutput === true) {
          try {
            jsonlErrors = extractCodexErrors(rawOutput);
          } catch {
            /* ignore */
          }
        }
      }

      const hasJsonlErrors = jsonlErrors.length > 0;
      const isOk = code === 0 && signal == null && !hasJsonlErrors;
      const elapsedMs = Date.now() - startTime;

      if (!isOk) {
        const fullCmd = `${cmd} ${args.join(' ')}`;
        let telemetry = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Exit Code: ${String(code)}\n[Hydra Telemetry] Signal: ${signal ?? 'null'}\n[Hydra Telemetry] Duration: ${String(elapsedMs)}ms`;
        if (elapsedMs < 5000 && !timedOut)
          telemetry += ` (startup failure suspected — exited before doing real work)`;
        if (hasJsonlErrors)
          telemetry += `\n[Hydra Telemetry] JSONL Errors: ${String(jsonlErrors.length)}`;
        if (timedOut) telemetry += `\n[Hydra Telemetry] Status: Timed Out`;
        stderr = `${stderr}\n\n${telemetry}`.trim();
      }

      let error: string | null = null;
      if (!isOk) {
        const parts: string[] = [];
        if (signal != null) parts.push(`Signal ${signal}`);
        if (code !== null && code !== 0) parts.push(`Exit code ${String(code)}`);
        if (hasJsonlErrors) parts.push(`JSONL errors: ${jsonlErrors.join('; ')}`);
        if (parts.length === 0) parts.push('Process terminated abnormally');
        if (timedOut) parts.push('(timed out)');
        error = parts.join(', ');
      }

      const result: ExecuteResult = {
        ok: isOk,
        output,
        stdout: rawOutput,
        stderr,
        error,
        exitCode: code,
        signal: signal ?? null,
        durationMs: elapsedMs,
        timedOut,
        startupFailure: !isOk && elapsedMs < 5000 && !timedOut,
        tokenUsage,
        costUsd,
        command: cmd,
        args,
        promptSnippet: prompt.slice(0, 500),
      };

      if (result.ok) {
        recordCallComplete(metricsHandle, {
          output: rawOutput,
          stderr,
          tokenUsage: tokenUsage ?? undefined,
          costUsd,
        });
      } else {
        diagnoseAgentError(agent, result);
        recordCallError(metricsHandle, result.error);
      }

      spanPromise
        .then((span) => endAgentSpan(span, { ok: result.ok, error: result.error ?? undefined }))
        .catch(() => {});
      _hubCleanup();
      resolve(result);
    });
  });
}

/** Execute an agent with automatic model-error recovery. */
export async function executeAgentWithRecovery(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts = {},
): Promise<ExecuteResult> {
  const cfg = loadHydraConfig();
  const currentModel = opts.modelOverride ?? null;
  const recoverySpan = await startPipelineSpan('agent-recovery', { 'gen_ai.agent.name': agent });

  let finalResult: ExecuteResult | undefined;
  try {
    // Circuit breaker: skip directly to fallback if model is tripped
    if (currentModel != null && currentModel !== '' && isCircuitOpen(currentModel)) {
      const recovery = (await recoverFromModelError(agent, currentModel, {
        rl: opts.rl as object | undefined,
      })) as { recovered: boolean; newModel: string | null };
      if (recovery.recovered) {
        const retryResult = await executeAgent(agent, prompt, {
          ...opts,
          modelOverride: recovery.newModel ?? undefined,
        });
        retryResult.recovered = true;
        retryResult.originalModel = currentModel;
        retryResult.newModel = recovery.newModel ?? undefined;
        retryResult.circuitBreakerTripped = true;
        finalResult = retryResult;
        return retryResult;
      }
      finalResult = {
        ok: false,
        output: '',
        stdout: '',
        stderr: '',
        error: 'Circuit breaker open, no fallback available',
        exitCode: null,
        signal: null,
        durationMs: 0,
        timedOut: false,
        circuitBreakerTripped: true,
      };
      return finalResult;
    }

    const result = await executeAgent(agent, prompt, opts);

    if (result.ok || !isModelRecoveryEnabled()) {
      finalResult = result;
      return result;
    }

    // Local-unavailable: transparent cloud fallback, no circuit breaker
    if (result.errorCategory === 'local-unavailable') {
      const fallbackCfg = loadHydraConfig();
      const fallback = fallbackCfg.routing.mode === 'economy' ? 'codex' : 'claude';
      process.stderr.write(`[local] server unreachable — falling back to ${fallback}\n`);
      finalResult = await executeAgent(fallback, prompt, { ...opts, _localFallback: true });
      return finalResult;
    }

    // Custom-CLI-unavailable: binary not found on PATH — fall back to cloud agent
    if (result.errorCategory === 'custom-cli-unavailable') {
      const fallback = 'claude';
      process.stderr.write(`[${agent}] CLI not found on PATH — falling back to ${fallback}\n`);
      finalResult = await executeAgent(fallback, prompt, { ...opts, _customFallback: true });
      return finalResult;
    }

    // Check usage limits — verify with API before committing to disable.
    // Pattern matching alone can produce false positives (e.g. Codex echoing
    // documentation that mentions "usage_limit_reached"). A quick GET /models
    // call tells us whether the account is actually quota-exhausted.
    const usageCheck = detectUsageLimitError(
      agent,
      result as unknown as Record<string, unknown>,
    ) as { isUsageLimit: boolean; errorMessage: string; resetInSeconds: number | null };
    if (usageCheck.isUsageLimit) {
      const verification = (await verifyAgentQuota(agent, {
        hintText: usageCheck.errorMessage,
      })) as { verified: boolean | 'unknown' };
      if (verification.verified === true) {
        // API confirmed quota exhausted — hard-disable the agent.
        const resetLabel = formatResetTime(usageCheck.resetInSeconds);
        result.usageLimited = true;
        result.usageLimitConfirmed = true;
        result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
        result.usageLimitDetail = usageCheck.errorMessage;
        result.error = `${agent} usage limit confirmed by API (resets in ${resetLabel})`;
        finalResult = result;
        return result;
      } else if (
        verification.verified === 'unknown' &&
        result.errorCategory === 'codex-jsonl-error'
      ) {
        // Structured JSONL event from the Codex CLI itself — authoritative, not a
        // text pattern match on arbitrary output. Trust it even without API key.
        const resetLabel = formatResetTime(usageCheck.resetInSeconds);
        result.usageLimited = true;
        result.usageLimitConfirmed = true;
        result.usageLimitStructured = true; // from JSONL, not pattern match
        result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
        result.usageLimitDetail = usageCheck.errorMessage;
        result.error = `${agent} usage limit (structured JSONL — resets in ${resetLabel})`;
        finalResult = result;
        return result;
      } else {
        // verified === false (API says account active) OR verified === 'unknown'
        // without a structured error source — cannot confirm quota exhaustion.
        // Fall through to rate-limit handling (may be a false positive).
        result.usageLimitFalsePositive = true;
        result.usageLimitPattern = usageCheck.errorMessage;
        if (verification.verified === 'unknown') {
          result.usageLimitUnverifiable = true; // callers can log/surface this
        }
      }
    }

    // Rate limit retry with exponential backoff
    const rateCheck = detectRateLimitError(agent, result as unknown as Record<string, unknown>) as {
      isRateLimit: boolean;
      retryAfterMs: number | null;
    };
    if (rateCheck.isRateLimit) {
      const rlCfg = (cfg.rateLimits ?? {}) as Record<string, number>;
      const maxRetries = rlCfg['maxRetries'] ?? 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const delayMs = calculateBackoff(attempt, {
          baseDelayMs: rlCfg['baseDelayMs'] as number | undefined,
          maxDelayMs: rlCfg['maxDelayMs'] as number | undefined,
          retryAfterMs: rateCheck.retryAfterMs ?? undefined,
        });
        // sequential: each iteration depends on previous result (rate-limit retry)
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((r) => {
          setTimeout(r, delayMs);
        });
        // eslint-disable-next-line no-await-in-loop
        const retryResult = await executeAgent(agent, prompt, opts);
        if (retryResult.ok) {
          retryResult.rateLimitRetries = attempt;
          finalResult = retryResult;
          return retryResult;
        }
        // Check if still rate limited
        const recheck = detectRateLimitError(
          agent,
          retryResult as unknown as Record<string, unknown>,
        );
        if (!recheck.isRateLimit) {
          retryResult.rateLimitRetries = attempt;
          finalResult = retryResult;
          return retryResult;
        }
      }
      result.rateLimitExhausted = true;
      result.rateLimitRetries = maxRetries;
      finalResult = result;
      return result;
    }

    // Model error → fallback
    const detection = detectModelError(agent, result as unknown as Record<string, unknown>) as {
      isModelError: boolean;
      failedModel: string | null;
    };
    if (!detection.isModelError) {
      finalResult = result;
      return result;
    }

    // Record failure for circuit breaker
    if (detection.failedModel != null && detection.failedModel !== '') {
      recordModelFailure(detection.failedModel);
    }

    const recovery = (await recoverFromModelError(agent, detection.failedModel ?? '', {
      rl: opts.rl as object | undefined,
    })) as { recovered: boolean; newModel: string | null };

    if (!recovery.recovered) {
      result.modelError = detection;
      finalResult = result;
      return result;
    }

    // Retry with the new model
    const retryResult = await executeAgent(agent, prompt, {
      ...opts,
      modelOverride: recovery.newModel ?? undefined,
    });

    retryResult.recovered = true;
    retryResult.originalModel = detection.failedModel ?? undefined;
    retryResult.newModel = recovery.newModel ?? undefined;
    finalResult = retryResult;
    return retryResult;
  } finally {
    await endPipelineSpan(recoverySpan, {
      ok: finalResult?.ok ?? false,
      error: finalResult?.error ?? undefined,
    });
  }
}

// ── IAgentExecutor interface & DefaultAgentExecutor ───────────────────────────

/**
 * Interface for agent execution, enabling dependency injection and testability.
 * Consumers should depend on this interface rather than importing the free functions directly.
 */
export interface IAgentExecutor {
  executeAgent(agent: string, prompt: string, opts?: ExecuteAgentOpts): Promise<ExecuteResult>;
  executeAgentWithRecovery(
    agent: string,
    prompt: string,
    opts?: ExecuteAgentOpts,
  ): Promise<ExecuteResult>;
}

/**
 * Default implementation of IAgentExecutor that delegates to the module-level
 * executeAgent / executeAgentWithRecovery functions.
 */
export class DefaultAgentExecutor implements IAgentExecutor {
  executeAgent(agent: string, prompt: string, opts?: ExecuteAgentOpts): Promise<ExecuteResult> {
    return executeAgent(agent, prompt, opts);
  }

  executeAgentWithRecovery(
    agent: string,
    prompt: string,
    opts?: ExecuteAgentOpts,
  ): Promise<ExecuteResult> {
    return executeAgentWithRecovery(agent, prompt, opts);
  }
}
