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

// ── Local Agent Helpers ──────────────────────────────────────────────────────

function makeLocalDisabledResult(): ExecuteResult {
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

async function executeLocalStream(
  prompt: string,
  baseUrl: string,
  model: string,
  maxTokens: number | undefined,
  startTime: number,
  metricsHandle: ReturnType<typeof recordCallStart>,
  span: Awaited<ReturnType<typeof startAgentSpan>>,
  onProgress?: ProgressCallback,
): Promise<ExecuteResult> {
  let output = '';
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'user', content: prompt },
  ];
  const result = await streamLocalCompletion(
    messages,
    { baseUrl, model, maxTokens },
    (chunk: string) => {
      output += chunk;
      if (onProgress) {
        onProgress(Date.now() - startTime, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
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
}

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
  if (!cfg.local.enabled) return makeLocalDisabledResult();

  const baseUrl = cfg.local.baseUrl;
  const model = modelOverride ?? cfg.local.model;
  const startTime = Date.now();
  const metricsHandle = recordCallStart('local', model);
  const span = await startAgentSpan('local', model, { phase: phaseLabel });
  const maxTokens = (cfg.local as unknown as Record<string, unknown>)['maxTokens'] as
    | number
    | undefined;

  try {
    return await executeLocalStream(
      prompt, baseUrl, model, maxTokens, startTime, metricsHandle, span, onProgress,
    );
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

// ── Agent Process Helpers ──────────────────────────────────────────────────

interface SpawnCtx {
  agent: string;
  cmd: string;
  args: string[];
  prompt: string;
  startTime: number;
  metricsHandle: ReturnType<typeof recordCallStart>;
  spanPromise: Promise<Awaited<ReturnType<typeof startAgentSpan>>>;
  hubCleanup: () => void;
}

interface ParsedAgentOutput {
  output: string;
  tokenUsage: TokenUsage | null;
  costUsd: number | null;
  jsonlErrors: string[];
}

function setupHubSession(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts,
): { cleanup: () => void } {
  let sessId: string | null = null;
  if (opts.hubCwd != null && opts.hubCwd !== '') {
    try {
      sessId = hubRegister({
        agent: opts.hubAgent ?? `${agent}-forge`,
        cwd: opts.hubCwd,
        project: opts.hubProject ?? path.basename(opts.hubCwd),
        focus: prompt.slice(0, 100),
      });
    } catch {
      /* hub is non-critical */
    }
  }
  const cleanup = () => {
    if (sessId != null) {
      try {
        hubDeregister(sessId);
      } catch {
        /* non-critical */
      }
      sessId = null;
    }
  };
  return { cleanup };
}

function parseAgentOutput(rawOutput: string, agent: string): ParsedAgentOutput {
  let output = rawOutput;
  let tokenUsage: TokenUsage | null = null;
  let costUsd: number | null = null;
  let jsonlErrors: string[] = [];

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
  if (_agentDef?.features.jsonOutput === true) {
    try {
      jsonlErrors = extractCodexErrors(rawOutput);
    } catch {
      /* ignore */
    }
  }

  return { output, tokenUsage, costUsd, jsonlErrors };
}

function buildFailureTelemetry(
  cmd: string,
  args: string[],
  code: number | null,
  signal: string | null,
  elapsedMs: number,
  timedOut: boolean,
  jsonlErrorCount: number,
): string {
  const fullCmd = `${cmd} ${args.join(' ')}`;
  let t = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Exit Code: ${String(code)}\n[Hydra Telemetry] Signal: ${signal ?? 'null'}\n[Hydra Telemetry] Duration: ${String(elapsedMs)}ms`;
  if (elapsedMs < 5000 && !timedOut)
    t += ` (startup failure suspected — exited before doing real work)`;
  if (jsonlErrorCount > 0) t += `\n[Hydra Telemetry] JSONL Errors: ${String(jsonlErrorCount)}`;
  if (timedOut) t += `\n[Hydra Telemetry] Status: Timed Out`;
  return t;
}

function buildErrorDescription(
  code: number | null,
  signal: string | null,
  timedOut: boolean,
  jsonlErrors: string[],
): string {
  const parts: string[] = [];
  if (signal != null) parts.push(`Signal ${signal}`);
  if (code !== null && code !== 0) parts.push(`Exit code ${String(code)}`);
  if (jsonlErrors.length > 0) parts.push(`JSONL errors: ${jsonlErrors.join('; ')}`);
  if (parts.length === 0) parts.push('Process terminated abnormally');
  if (timedOut) parts.push('(timed out)');
  return parts.join(', ');
}

function buildAgentCloseResult(
  agent: string,
  rawOutput: string,
  stderrInput: string,
  code: number | null,
  signal: string | null,
  timedOut: boolean,
  elapsedMs: number,
  cmd: string,
  args: string[],
  prompt: string,
): ExecuteResult {
  const parsed = parseAgentOutput(rawOutput, agent);
  const hasJsonlErrors = parsed.jsonlErrors.length > 0;
  const isOk = code === 0 && signal == null && !hasJsonlErrors;

  let stderr = stderrInput;
  if (!isOk) {
    const telemetry = buildFailureTelemetry(
      cmd, args, code, signal, elapsedMs, timedOut, parsed.jsonlErrors.length,
    );
    stderr = `${stderrInput}\n\n${telemetry}`.trim();
  }

  return {
    ok: isOk,
    output: parsed.output,
    stdout: rawOutput,
    stderr,
    error: isOk ? null : buildErrorDescription(code, signal, timedOut, parsed.jsonlErrors),
    exitCode: code,
    signal: signal ?? null,
    durationMs: elapsedMs,
    timedOut,
    startupFailure: !isOk && elapsedMs < 5000 && !timedOut,
    tokenUsage: parsed.tokenUsage,
    costUsd: parsed.costUsd,
    command: cmd,
    args,
    promptSnippet: prompt.slice(0, 500),
  };
}

function buildAgentSpawnErrorResult(
  err: Error,
  stdoutChunks: string[],
  stderrChunks: string[],
  startTime: number,
  cmd: string,
  args: string[],
  prompt: string,
): ExecuteResult {
  const output = stdoutChunks.join('');
  const fullCmd = `${cmd} ${args.join(' ')}`;
  const telemetry = `[Hydra Telemetry] Failed Command: ${fullCmd}\n[Hydra Telemetry] Spawn Error: ${err.message}`;
  const stderr = `${stderrChunks.join('')}\n\n${telemetry}`.trim();
  return {
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
}

function finalizeSpawnResult(ctx: SpawnCtx, result: ExecuteResult): void {
  if (result.ok) {
    recordCallComplete(ctx.metricsHandle, {
      output: result.stdout ?? '',
      stderr: result.stderr,
      tokenUsage: result.tokenUsage ?? undefined,
      costUsd: result.costUsd,
    });
  } else {
    diagnoseAgentError(ctx.agent, result);
    recordCallError(ctx.metricsHandle, result.error);
  }
  ctx.spanPromise
    .then((span) => endAgentSpan(span, { ok: result.ok, error: result.error ?? undefined }))
    .catch(() => {});
  ctx.hubCleanup();
}

function appendBufferedChunk(
  chunk: string,
  chunks: string[],
  bytesRef: { value: number },
  maxBytes: number,
): void {
  bytesRef.value += Buffer.byteLength(chunk);
  chunks.push(chunk);
  while (bytesRef.value > maxBytes && chunks.length > 1) {
    const dropped = chunks.shift() ?? '';
    bytesRef.value -= Buffer.byteLength(dropped);
  }
  if (chunks.length === 1 && bytesRef.value > maxBytes) {
    const buf = Buffer.from(chunks[0], 'utf8');
    let truncated = buf.subarray(0, maxBytes).toString('utf8');
    while (Buffer.byteLength(truncated, 'utf8') > maxBytes && truncated.length > 0) {
      truncated = truncated.slice(0, -1);
    }
    chunks[0] = truncated;
    bytesRef.value = Buffer.byteLength(truncated, 'utf8');
  }
}

async function handleNoHeadlessInvoke(
  agent: string,
  metricsHandle: ReturnType<typeof recordCallStart>,
  spanPromise: Promise<Awaited<ReturnType<typeof startAgentSpan>>>,
  hubCleanup: () => void,
): Promise<ExecuteResult> {
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
  hubCleanup();
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

function isInvalidModelOverride(modelOverride: string | undefined): boolean {
  return modelOverride != null && modelOverride !== '' && !/^[a-zA-Z0-9-.:]+$/.test(modelOverride);
}

function buildHeadlessOpts(
  effectiveModel: string,
  agent: string,
  opts: ExecuteAgentOpts,
  agentDef: ReturnType<typeof getAgent>,
): HeadlessOpts {
  return {
    model: effectiveModel === '' ? undefined : effectiveModel,
    permissionMode: (opts.permissionMode ?? 'auto-edit') as PermissionMode,
    jsonOutput: agentDef?.features.jsonOutput,
    reasoningEffort: agentDef?.features.reasoningEffort === true
      ? (opts.reasoningEffort ?? getReasoningEffort(agent) ?? undefined)
      : undefined,
    cwd: opts.cwd,
    stdinPrompt: (opts.useStdin ?? true) && agentDef?.features.stdinPrompt,
  };
}

interface AgentSpawnParams {
  agent: string;
  cmd: string;
  args: string[];
  prompt: string;
  metricsHandle: ReturnType<typeof recordCallStart>;
  spanPromise: Promise<Awaited<ReturnType<typeof startAgentSpan>>>;
  hubCleanup: () => void;
  agentDef: NonNullable<ReturnType<typeof getAgent>>;
}

function setupSpawnTimeout(
  child: ChildProcess,
  timeoutMs: number,
): { timedOutRef: { value: boolean }; timer: ReturnType<typeof setTimeout> } {
  const timedOutRef = { value: false };
  const timer = setTimeout(() => {
    timedOutRef.value = true;
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  return { timedOutRef, timer };
}

function setupSpawnProgress(
  intervalMs: number,
  onProgress: ProgressCallback | undefined,
  startTime: number,
  bytesRef: { value: number },
): ReturnType<typeof setInterval> | null {
  if (intervalMs <= 0 || !onProgress) return null;
  return setInterval(() => {
    onProgress(Date.now() - startTime, Math.round(bytesRef.value / 1024));
  }, intervalMs);
}

interface SpawnDefaults {
  useStdin: boolean;
  collectStderr: boolean;
  maxOutputBytes: number;
  maxStderrBytes: number;
  timeoutMs: number;
  progressIntervalMs: number;
}

function resolveSpawnDefaults(opts: ExecuteAgentOpts): SpawnDefaults {
  return {
    useStdin: opts.useStdin ?? true,
    collectStderr: opts.collectStderr ?? true,
    maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    maxStderrBytes: opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    progressIntervalMs: opts.progressIntervalMs ?? 0,
  };
}

function spawnAgentProcess(p: AgentSpawnParams, opts: ExecuteAgentOpts): Promise<ExecuteResult> {
  const sd = resolveSpawnDefaults(opts);
  return new Promise<ExecuteResult>((resolve) => {
    const ctx: SpawnCtx = {
      agent: p.agent, cmd: p.cmd, args: p.args, prompt: p.prompt,
      startTime: Date.now(), metricsHandle: p.metricsHandle,
      spanPromise: p.spanPromise, hubCleanup: p.hubCleanup,
    };
    const useStdinForPrompt = sd.useStdin && p.agentDef.features.stdinPrompt;
    const stdoutChunks: string[] = [];
    const stdoutBytes = { value: 0 };
    const stderrChunks: string[] = [];
    let stderrBytes = 0;

    const childEnv = { ...process.env };
    delete childEnv['CLAUDECODE'];
    const child = spawn(p.cmd, p.args, {
      cwd: opts.cwd,
      env: childEnv,
      windowsHide: true,
      stdio: [useStdinForPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (useStdinForPrompt && child.stdin != null) {
      child.stdin.write(p.prompt);
      child.stdin.end();
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      appendBufferedChunk(d, stdoutChunks, stdoutBytes, sd.maxOutputBytes);
    });

    if (sd.collectStderr) {
      child.stderr?.on('data', (d: string) => {
        stderrBytes += Buffer.byteLength(d);
        stderrChunks.push(d);
        while (stderrBytes > sd.maxStderrBytes && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift() ?? '';
          stderrBytes -= Buffer.byteLength(dropped);
        }
      });
    }

    const { timedOutRef, timer } = setupSpawnTimeout(child, sd.timeoutMs);
    const progressTimer = setupSpawnProgress(
      sd.progressIntervalMs, opts.onProgress, ctx.startTime, stdoutBytes,
    );
    if (opts.onStatusBar) {
      opts.onStatusBar(p.agent, { phase: opts.phaseLabel ?? 'executing', step: 'running' });
    }

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      const result = buildAgentSpawnErrorResult(
        err, stdoutChunks, stderrChunks, ctx.startTime, p.cmd, p.args, p.prompt,
      );
      finalizeSpawnResult(ctx, result);
      resolve(result);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      if (progressTimer) clearInterval(progressTimer);
      if (opts.onStatusBar) {
        opts.onStatusBar(p.agent, { phase: opts.phaseLabel ?? 'done', step: 'idle' });
      }
      const result = buildAgentCloseResult(
        p.agent, stdoutChunks.join(''), stderrChunks.join(''),
        code, signal, timedOutRef.value, Date.now() - ctx.startTime, p.cmd, p.args, p.prompt,
      );
      finalizeSpawnResult(ctx, result);
      resolve(result);
    });
  });
}

/** Execute an agent CLI as a headless subprocess. */
export async function executeAgent(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts = {},
): Promise<ExecuteResult> {
  const agentDef = getAgent(agent);
  if (!agentDef) {
    throw new Error(`Unknown agent: "${agent}"`);
  }

  const { cleanup: _hubCleanup } = setupHubSession(agent, prompt, opts);

  // API-mode agents (local + any custom api-type)
  if (agentDef.features.executeMode === 'api') {
    if (agentDef.customType === 'api') {
      try { return await executeCustomApiAgent(agent, prompt, opts); } finally { _hubCleanup(); }
    }
    try { return await executeLocalAgent(prompt, opts); } finally { _hubCleanup(); }
  }

  // Custom CLI agents
  if (agentDef.customType === 'cli') {
    try { return await executeCustomCliAgent(agent, prompt, opts); } finally { _hubCleanup(); }
  }

  // Gemini direct API (bypasses broken CLI)
  if (agentDef.name === 'gemini') {
    const effectiveModel = opts.modelOverride ?? getActiveModel(agent) ?? 'unknown';
    const geminiOpts: GeminiDirectOpts = { ...opts, modelOverride: effectiveModel };
    try { return await executeGeminiDirect(prompt, geminiOpts); } finally { _hubCleanup(); }
  }

  // Standard CLI agent — resolve headless invoke
  const headlessInvoke = agentDef.invoke?.headless ?? null;
  const { modelOverride, phaseLabel } = opts;

  if (isInvalidModelOverride(modelOverride)) {
    _hubCleanup();
    return {
      ok: false,
      output: '',
      stderr: `Invalid model override format: "${String(modelOverride)}"`,
      error: 'Security violation: invalid model format',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const effectiveModel = modelOverride ?? getActiveModel(agent) ?? 'unknown';
  const spanPromise = startAgentSpan(agent, effectiveModel, {
    phase: phaseLabel,
    taskType: opts.taskType,
  });
  const metricsHandle = recordCallStart(agent, effectiveModel);

  if (!headlessInvoke) {
    return handleNoHeadlessInvoke(agent, metricsHandle, spanPromise, _hubCleanup);
  }

  const invokeResult = headlessInvoke(prompt, buildHeadlessOpts(effectiveModel, agent, opts, agentDef));
  const _cmd = invokeResult[0];
  const _args = invokeResult[1];
  assertSafeSpawnCmd(_cmd, `Agent '${agent}'`);

  return spawnAgentProcess(
    { agent, cmd: _cmd, args: _args, prompt, metricsHandle, spanPromise, hubCleanup: _hubCleanup, agentDef },
    opts,
  );
}

// ── Recovery Helpers ─────────────────────────────────────────────────────────

async function handleCircuitBreakerTripped(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts,
  currentModel: string,
): Promise<ExecuteResult> {
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
    return retryResult;
  }
  return {
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
}

async function handleLocalFallback(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts,
  result: ExecuteResult,
  cfg: ReturnType<typeof loadHydraConfig>,
): Promise<ExecuteResult | null> {
  if (result.errorCategory === 'local-unavailable') {
    const fallback = cfg.routing.mode === 'economy' ? 'codex' : 'claude';
    process.stderr.write(`[local] server unreachable — falling back to ${fallback}\n`);
    return executeAgent(fallback, prompt, { ...opts, _localFallback: true });
  }
  if (result.errorCategory === 'custom-cli-unavailable') {
    process.stderr.write(`[${agent}] CLI not found on PATH — falling back to claude\n`);
    return executeAgent('claude', prompt, { ...opts, _customFallback: true });
  }
  return null;
}

function handleUsageLimitDetected(
  agent: string,
  result: ExecuteResult,
  usageCheck: { isUsageLimit: boolean; errorMessage: string; resetInSeconds: number | null },
  verification: { verified: boolean | 'unknown' },
): ExecuteResult | null {
  if (verification.verified === true) {
    const resetLabel = formatResetTime(usageCheck.resetInSeconds);
    result.usageLimited = true;
    result.usageLimitConfirmed = true;
    result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
    result.usageLimitDetail = usageCheck.errorMessage;
    result.error = `${agent} usage limit confirmed by API (resets in ${resetLabel})`;
    return result;
  }
  if (verification.verified === 'unknown' && result.errorCategory === 'codex-jsonl-error') {
    const resetLabel = formatResetTime(usageCheck.resetInSeconds);
    result.usageLimited = true;
    result.usageLimitConfirmed = true;
    result.usageLimitStructured = true;
    result.resetInSeconds = usageCheck.resetInSeconds ?? undefined;
    result.usageLimitDetail = usageCheck.errorMessage;
    result.error = `${agent} usage limit (structured JSONL — resets in ${resetLabel})`;
    return result;
  }
  result.usageLimitFalsePositive = true;
  result.usageLimitPattern = usageCheck.errorMessage;
  if (verification.verified === 'unknown') {
    result.usageLimitUnverifiable = true;
  }
  return null;
}

async function handleRateLimitRetry(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts,
  result: ExecuteResult,
  rateCheck: { retryAfterMs: number | null },
  cfg: ReturnType<typeof loadHydraConfig>,
): Promise<ExecuteResult> {
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
      return retryResult;
    }
    const recheck = detectRateLimitError(
      agent,
      retryResult as unknown as Record<string, unknown>,
    );
    if (!recheck.isRateLimit) {
      retryResult.rateLimitRetries = attempt;
      return retryResult;
    }
  }

  result.rateLimitExhausted = true;
  result.rateLimitRetries = maxRetries;
  return result;
}

async function handleModelErrorRecovery(
  agent: string,
  prompt: string,
  opts: ExecuteAgentOpts,
  detection: { isModelError: boolean; failedModel: string | null },
): Promise<ExecuteResult | null> {
  if (detection.failedModel != null && detection.failedModel !== '') {
    recordModelFailure(detection.failedModel);
  }

  const recovery = (await recoverFromModelError(agent, detection.failedModel ?? '', {
    rl: opts.rl as object | undefined,
  })) as { recovered: boolean; newModel: string | null };

  if (!recovery.recovered) return null;

  const retryResult = await executeAgent(agent, prompt, {
    ...opts,
    modelOverride: recovery.newModel ?? undefined,
  });
  retryResult.recovered = true;
  retryResult.originalModel = detection.failedModel ?? undefined;
  retryResult.newModel = recovery.newModel ?? undefined;
  return retryResult;
}

function shouldTripCircuitBreaker(currentModel: string | null): currentModel is string {
  return currentModel != null && currentModel !== '' && isCircuitOpen(currentModel);
}

function makeFinalSpanAttrs(
  result: ExecuteResult | undefined,
): { ok: boolean; error?: string } {
  return { ok: result?.ok ?? false, error: result?.error ?? undefined };
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
    if (shouldTripCircuitBreaker(currentModel)) {
      finalResult = await handleCircuitBreakerTripped(agent, prompt, opts, currentModel);
      return finalResult;
    }

    const result = await executeAgent(agent, prompt, opts);
    if (result.ok || !isModelRecoveryEnabled()) {
      finalResult = result;
      return result;
    }

    // Local-unavailable / custom-cli-unavailable: transparent cloud fallback
    const fallbackResult = await handleLocalFallback(agent, prompt, opts, result, cfg);
    if (fallbackResult) {
      finalResult = fallbackResult;
      return fallbackResult;
    }

    // Check usage limits
    const usageCheck = detectUsageLimitError(
      agent,
      result as unknown as Record<string, unknown>,
    ) as { isUsageLimit: boolean; errorMessage: string; resetInSeconds: number | null };
    if (usageCheck.isUsageLimit) {
      const verification = (await verifyAgentQuota(agent, {
        hintText: usageCheck.errorMessage,
      })) as { verified: boolean | 'unknown' };
      const usageResult = handleUsageLimitDetected(agent, result, usageCheck, verification);
      if (usageResult) {
        finalResult = usageResult;
        return usageResult;
      }
    }

    // Rate limit retry with exponential backoff
    const rateCheck = detectRateLimitError(
      agent,
      result as unknown as Record<string, unknown>,
    ) as { isRateLimit: boolean; retryAfterMs: number | null };
    if (rateCheck.isRateLimit) {
      finalResult = await handleRateLimitRetry(agent, prompt, opts, result, rateCheck, cfg);
      return finalResult;
    }

    // Model error → fallback
    const detection = detectModelError(
      agent,
      result as unknown as Record<string, unknown>,
    ) as { isModelError: boolean; failedModel: string | null };
    if (!detection.isModelError) {
      finalResult = result;
      return result;
    }

    const modelResult = await handleModelErrorRecovery(agent, prompt, opts, detection);
    if (modelResult) {
      finalResult = modelResult;
      return modelResult;
    }

    result.modelError = detection;
    finalResult = result;
    return result;
  } finally {
    await endPipelineSpan(recoverySpan, makeFinalSpanAttrs(finalResult));
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
