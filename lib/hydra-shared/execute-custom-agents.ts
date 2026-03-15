/**
 * Custom agent execution — CLI and API agent spawning.
 *
 * Extracted from agent-executor.ts. Handles execution of user-defined agents
 * registered via config (type: 'cli') or the agents wizard (type: 'api').
 */

// @ts-expect-error cross-spawn has no type declarations
import _spawn from 'cross-spawn';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
const spawn = _spawn as (cmd: string, args: string[], opts?: SpawnOptions) => ChildProcess;
import { getAgent } from '../hydra-agents.ts';
import { loadHydraConfig } from '../hydra-config.ts';
import { streamLocalCompletion } from '../hydra-local.ts';
import { metricsRecorder } from '../hydra-metrics.ts';
import { startAgentSpan, endAgentSpan } from '../hydra-telemetry.ts';
import type { AgentDef, TokenUsage, CustomAgentDef, IMetricsRecorder } from '../types.ts';
import type { ExecuteResult, ProgressCallback } from '../types.ts';

/** Options for custom CLI agent execution */
interface CustomCliOpts {
  cwd?: string;
  timeoutMs?: number;
  onProgress?: ProgressCallback;
  phaseLabel?: string;
}

/** Options for custom API agent execution */
interface CustomApiOpts {
  timeoutMs?: number;
  onProgress?: ProgressCallback;
  phaseLabel?: string;
}

/**
 * Expand {placeholder} tokens in an args array.
 * Unknown placeholders are left intact.
 */
export function expandInvokeArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((arg: string) =>
    arg.replace(/\{(\w+)\}/g, (match: string, key: string) => (key in vars ? vars[key] : match)),
  );
}

/**
 * Validate a command name before passing to spawn() as defence-in-depth.
 * Rejects shell metacharacters and path traversal. spawn() uses shell:false,
 * but we still guard against arbitrary executable injection from user config.
 */
export function assertSafeSpawnCmd(cmd: string, context: string): void {
  if (/[;&|`$<>()\n\r\0]/.test(cmd)) {
    throw new Error(`${context}: cmd contains unsafe characters and cannot be spawned.`);
  }
  if (cmd.includes('..')) {
    throw new Error(`${context}: cmd contains path traversal (..) and cannot be spawned.`);
  }
}

/**
 * Parse CLI stdout based on the agent's responseParser setting.
 */
export function parseCliResponse(
  stdout: string,
  parser: 'plaintext' | 'json' | 'markdown',
): string {
  if (parser === 'json') {
    try {
      const data = JSON.parse(stdout) as Record<string, string | undefined>;
      return data['content'] ?? data['text'] ?? data['message'] ?? data['output'] ?? stdout;
    } catch {
      return stdout;
    }
  }
  return stdout; // plaintext and markdown both return raw stdout
}

// ── Shared Helpers ────────────────────────────────────────────────────────────

type MetricsHandle = string;
type AgentSpan = Awaited<ReturnType<typeof startAgentSpan>>;

interface CliSpawnState {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface ParsedCliOutput {
  parsedOutput: string;
  tokenUsage: TokenUsage | null;
  costUsd: number | null;
}

interface ApiAgentConfig {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

function makeCustomAgentErrorResult(
  errorCategory: string,
  extra?: Partial<ExecuteResult>,
): ExecuteResult {
  return {
    ok: false,
    output: '',
    stdout: '',
    stderr: '',
    error: errorCategory,
    errorCategory,
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    ...extra,
  };
}

function resolveCustomAgentDef(agentName: string): AgentDef | CustomAgentDef | null {
  const cfg = loadHydraConfig();
  const def = getAgent(agentName) ?? cfg.agents.customAgents.find((a) => a.name === agentName);
  if (!def) return null;
  if ('enabled' in def && def.enabled === false) return null;
  return def;
}

// ── Custom CLI Agent ──────────────────────────────────────────────────────────

function resolveCliInvokeConfig(
  def: AgentDef | CustomAgentDef,
): { cmd: string; args: string[] } | undefined {
  if (!def.invoke || !('headless' in def.invoke)) return undefined;
  type InvokeShape = {
    headless?: { cmd: string; args: string[] };
    nonInteractive?: { cmd: string; args: string[] };
  };
  const invoke = def.invoke as InvokeShape;
  return invoke.headless ?? invoke.nonInteractive;
}

function parseCustomCliOutput(stdout: string, def: AgentDef | CustomAgentDef): ParsedCliOutput {
  if ('parseOutput' in def && typeof def.parseOutput === 'function') {
    const result = def.parseOutput(stdout, { jsonOutput: def.features.jsonOutput });
    return {
      parsedOutput: result.output,
      tokenUsage: result.tokenUsage ?? null,
      costUsd: result.costUsd ?? null,
    };
  }
  const parser =
    ('responseParser' in def ? (def as { responseParser?: string }).responseParser : 'plaintext') ??
    'plaintext';
  return {
    parsedOutput: parseCliResponse(stdout, parser as 'plaintext' | 'json' | 'markdown'),
    tokenUsage: null,
    costUsd: null,
  };
}

async function handleCliSpawnError(
  err: NodeJS.ErrnoException,
  state: CliSpawnState,
  startTime: number,
  metricsHandle: MetricsHandle,
  span: AgentSpan,
  metrics: IMetricsRecorder = metricsRecorder,
): Promise<ExecuteResult> {
  if (state.timer) clearTimeout(state.timer);
  const durationMs = Date.now() - startTime;
  const errorCategory = err.code === 'ENOENT' ? 'custom-cli-unavailable' : 'custom-cli-error';
  metrics.recordCallError(metricsHandle, errorCategory);
  await endAgentSpan(span, { ok: false, error: errorCategory });
  return makeCustomAgentErrorResult(errorCategory, { stderr: err.message, durationMs });
}

async function handleCliClose(
  code: number | null,
  signal: string | null,
  state: CliSpawnState,
  startTime: number,
  metricsHandle: MetricsHandle,
  span: AgentSpan,
  def: AgentDef | CustomAgentDef,
  metrics: IMetricsRecorder = metricsRecorder,
): Promise<ExecuteResult> {
  if (state.timer) clearTimeout(state.timer);
  const durationMs = Date.now() - startTime;
  const isFailure = (code !== 0 || Boolean(signal)) && !state.timedOut;

  if (isFailure) {
    metrics.recordCallError(metricsHandle, 'custom-cli-error');
    await endAgentSpan(span, { ok: false, error: 'custom-cli-error' });
    return {
      ok: false,
      output: '',
      stdout: state.stdout,
      stderr: state.stderr,
      error: 'custom-cli-error',
      errorCategory: 'custom-cli-error',
      exitCode: code,
      signal,
      durationMs,
      timedOut: false,
    };
  }

  const { parsedOutput, tokenUsage, costUsd } = parseCustomCliOutput(state.stdout, def);
  metrics.recordCallComplete(metricsHandle, {
    output: parsedOutput,
    stdout: parsedOutput,
    tokenUsage: tokenUsage ?? undefined,
    costUsd,
  });
  await endAgentSpan(span, { ok: !state.timedOut });
  return {
    ok: !state.timedOut,
    output: parsedOutput,
    stdout: parsedOutput,
    stderr: state.stderr,
    tokenUsage,
    costUsd,
    error: state.timedOut ? 'timeout' : null,
    errorCategory: state.timedOut ? 'custom-cli-error' : undefined,
    exitCode: code,
    signal,
    durationMs,
    timedOut: state.timedOut,
  };
}

export async function executeCustomCliAgent(
  agentName: string,
  prompt: string,
  opts: CustomCliOpts = {},
  metrics: IMetricsRecorder = metricsRecorder,
): Promise<ExecuteResult> {
  const { cwd, timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const def = resolveCustomAgentDef(agentName);

  if (!def) {
    return makeCustomAgentErrorResult('custom-cli-disabled', {
      stderr: 'Custom agent disabled or not found.',
    });
  }

  const invokeConfig = resolveCliInvokeConfig(def);
  if (invokeConfig?.cmd == null || invokeConfig.cmd === '' || !Array.isArray(invokeConfig.args)) {
    return makeCustomAgentErrorResult('custom-cli-error', {
      stderr: 'Custom agent has no valid invoke config.',
    });
  }

  const vars = { prompt, cwd: cwd ?? process.cwd() };
  const args = expandInvokeArgs(invokeConfig.args, vars);
  const cmd = invokeConfig.cmd;
  assertSafeSpawnCmd(cmd, `Custom agent '${agentName}'`);
  const startTime = Date.now();
  // rf-cs03: complex lifecycle — handle passed to event-driven spawn callbacks
  const metricsHandle = metrics.recordCallStart(agentName, agentName);
  const span = await startAgentSpan(agentName, agentName, { phase: phaseLabel });

  return new Promise<ExecuteResult>((resolve) => {
    const state: CliSpawnState = {
      stdout: '',
      stderr: '',
      timedOut: false,
      settled: false,
      timer: undefined,
    };
    const child = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (timeoutMs > 0) {
      state.timer = setTimeout(() => {
        state.timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (state.settled) return;
      state.settled = true;
      void handleCliSpawnError(err, state, startTime, metricsHandle, span, metrics).then(resolve);
    });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      state.stdout += d;
      if (onProgress) onProgress(Date.now() - startTime, Math.round(state.stdout.length / 1024));
    });
    child.stderr?.on('data', (d: string) => {
      state.stderr += d;
    });

    child.on('close', (code: number | null, signal: string | null) => {
      if (state.settled) return;
      state.settled = true;
      void handleCliClose(code, signal, state, startTime, metricsHandle, span, def, metrics).then(
        resolve,
      );
    });
  });
}

// ── Custom API Agent ──────────────────────────────────────────────────────────

function buildApiRequestConfig(def: AgentDef | CustomAgentDef, timeoutMs: number): ApiAgentConfig {
  const baseUrl =
    ('baseUrl' in def ? (def as { baseUrl?: string }).baseUrl : undefined) ??
    'http://localhost:11434/v1';
  const model = ('model' in def ? (def as { model?: string }).model : undefined) ?? 'default';
  const maxTokens = 'maxTokens' in def ? (def as { maxTokens?: number }).maxTokens : undefined;
  const abortSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  return { baseUrl, model, maxTokens, abortSignal };
}

async function executeApiStream(
  prompt: string,
  apiConfig: ApiAgentConfig,
  startTime: number,
  metricsHandle: MetricsHandle,
  span: AgentSpan,
  onProgress?: ProgressCallback,
  metrics: IMetricsRecorder = metricsRecorder,
): Promise<ExecuteResult> {
  let output = '';
  const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'user', content: prompt },
  ];

  const result = await streamLocalCompletion(
    messages,
    {
      baseUrl: apiConfig.baseUrl,
      model: apiConfig.model,
      maxTokens: apiConfig.maxTokens,
      signal: apiConfig.abortSignal,
    },
    (chunk: string) => {
      output += chunk;
      if (onProgress) {
        onProgress(Date.now() - startTime, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
      }
    },
  );

  const durationMs = Date.now() - startTime;
  if (!result.ok) {
    metrics.recordCallError(metricsHandle, result.errorCategory ?? 'unknown');
    await endAgentSpan(span, { ok: false, error: result.errorCategory });
    return makeCustomAgentErrorResult(result.errorCategory ?? 'unknown', {
      stderr: result.errorCategory ?? '',
      error: result.errorCategory ?? null,
      durationMs,
    });
  }

  metrics.recordCallComplete(metricsHandle, { output: result.output, stdout: result.output });
  await endAgentSpan(span, { ok: true });
  return {
    ok: true,
    output: result.output,
    stdout: result.output,
    stderr: '',
    error: null,
    errorCategory: undefined,
    exitCode: 0,
    signal: null,
    durationMs,
    timedOut: false,
  };
}

export async function executeCustomApiAgent(
  agentName: string,
  prompt: string,
  opts: CustomApiOpts = {},
  metrics: IMetricsRecorder = metricsRecorder,
): Promise<ExecuteResult> {
  const { timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const def = resolveCustomAgentDef(agentName);

  if (!def) {
    return makeCustomAgentErrorResult('custom-api-disabled', {
      stderr: 'Custom API agent disabled or not found.',
    });
  }

  const apiConfig = buildApiRequestConfig(def, timeoutMs);
  const startTime = Date.now();
  // rf-cs03: complex lifecycle — handle passed to executeApiStream helper
  const metricsHandle = metrics.recordCallStart(agentName, apiConfig.model);
  const span = await startAgentSpan(agentName, apiConfig.model, { phase: phaseLabel });

  try {
    return await executeApiStream(
      prompt,
      apiConfig,
      startTime,
      metricsHandle,
      span,
      onProgress,
      metrics,
    );
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    const durationMs = Date.now() - startTime;
    metrics.recordCallError(metricsHandle, 'custom-cli-error');
    await endAgentSpan(span, { ok: false, error: e.message });
    return makeCustomAgentErrorResult('custom-cli-error', { stderr: e.message, durationMs });
  }
}
