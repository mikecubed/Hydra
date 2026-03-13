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
import { recordCallStart, recordCallComplete, recordCallError } from '../hydra-metrics.ts';
import { startAgentSpan, endAgentSpan } from '../hydra-telemetry.ts';
import type { AgentDef, TokenUsage, CustomAgentDef } from '../types.ts';
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

// ── Custom CLI Agent ──────────────────────────────────────────────────────────

export async function executeCustomCliAgent(
  agentName: string,
  prompt: string,
  opts: CustomCliOpts = {},
): Promise<ExecuteResult> {
  const { cwd, timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  // Prefer registry definition (supports programmatically registered agents), fall back to config
  const def: (AgentDef & { responseParser?: string }) | CustomAgentDef | null | undefined =
    getAgent(agentName) ?? cfg.agents.customAgents.find((a) => a.name === agentName);

  if (!def || ('enabled' in def && def.enabled === false)) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom agent disabled or not found.',
      error: 'custom-cli-disabled',
      errorCategory: 'custom-cli-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const invokeConfig =
    def.invoke && 'headless' in def.invoke
      ? ((
          def.invoke as {
            headless?: { cmd: string; args: string[] };
            nonInteractive?: { cmd: string; args: string[] };
          }
        ).headless ??
        (
          def.invoke as {
            headless?: { cmd: string; args: string[] };
            nonInteractive?: { cmd: string; args: string[] };
          }
        ).nonInteractive)
      : undefined;
  if (invokeConfig?.cmd == null || invokeConfig.cmd === '' || !Array.isArray(invokeConfig.args)) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom agent has no valid invoke config.',
      error: 'custom-cli-error',
      errorCategory: 'custom-cli-error',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const vars = { prompt, cwd: cwd ?? process.cwd() };
  const args = expandInvokeArgs(invokeConfig.args, vars);
  const cmd = invokeConfig.cmd;
  assertSafeSpawnCmd(cmd, `Custom agent '${agentName}'`);
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, agentName);
  const span = await startAgentSpan(agentName, agentName, { phase: phaseLabel });

  return new Promise<ExecuteResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, args, {
      cwd: cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // spawn is typed as returning ChildProcess via the typed wrapper at top of file

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      void (async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const isUnavailable = err.code === 'ENOENT';
        const errorCategory = isUnavailable ? 'custom-cli-unavailable' : 'custom-cli-error';
        recordCallError(metricsHandle, errorCategory);
        await endAgentSpan(span, { ok: false, error: errorCategory });
        resolve({
          ok: false,
          output: '',
          stdout: '',
          stderr: err.message,
          error: errorCategory,
          errorCategory,
          exitCode: null,
          signal: null,
          durationMs,
          timedOut: false,
        });
      })();
    });

    // stdout and stderr are always defined with stdio: ['ignore', 'pipe', 'pipe']
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      stdout += d;
      if (onProgress) onProgress(Date.now() - startTime, Math.round(stdout.length / 1024));
    });
    child.stderr?.on('data', (d: string) => {
      stderr += d;
    });

    child.on('close', (code: number | null, signal: string | null) => {
      void (async () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const isFailure = (code !== 0 || Boolean(signal)) && !timedOut;
        if (isFailure) {
          recordCallError(metricsHandle, 'custom-cli-error');
          await endAgentSpan(span, { ok: false, error: 'custom-cli-error' });
          resolve({
            ok: false,
            output: '',
            stdout,
            stderr,
            error: 'custom-cli-error',
            errorCategory: 'custom-cli-error',
            exitCode: code,
            signal,
            durationMs,
            timedOut: false,
          });
          return;
        }
        // Prefer plugin parseOutput (set by registerAgent) for token/cost extraction.
        // Fall back to legacy responseParser for config-only agents not in the registry.
        let parsedOutput: string;
        let tokenUsage: TokenUsage | null = null;
        let costUsd: number | null = null;
        if ('parseOutput' in def && typeof def.parseOutput === 'function') {
          const result = (def as AgentDef).parseOutput(stdout, {
            jsonOutput: (def as AgentDef).features.jsonOutput,
          });
          parsedOutput = result.output;
          tokenUsage = result.tokenUsage ?? null;
          costUsd = result.costUsd ?? null;
        } else {
          const parser =
            ('responseParser' in def
              ? (def as { responseParser?: string }).responseParser
              : 'plaintext') ?? 'plaintext';
          parsedOutput = parseCliResponse(stdout, parser as 'plaintext' | 'json' | 'markdown');
        }
        recordCallComplete(metricsHandle, {
          output: parsedOutput,
          stdout: parsedOutput,
          tokenUsage: tokenUsage ?? undefined,
          costUsd,
        });
        await endAgentSpan(span, { ok: !timedOut });
        resolve({
          ok: !timedOut,
          output: parsedOutput,
          stdout: parsedOutput,
          stderr,
          tokenUsage,
          costUsd,
          error: timedOut ? 'timeout' : null,
          errorCategory: timedOut ? 'custom-cli-error' : undefined,
          exitCode: code,
          signal,
          durationMs,
          timedOut,
        });
      })();
    });
  });
}

// ── Custom API Agent ──────────────────────────────────────────────────────────

export async function executeCustomApiAgent(
  agentName: string,
  prompt: string,
  opts: CustomApiOpts = {},
): Promise<ExecuteResult> {
  const { timeoutMs = 3 * 60 * 1000, onProgress, phaseLabel } = opts;
  const cfg = loadHydraConfig();
  // Prefer registry definition (supports programmatically registered agents), fall back to config
  const def:
    | (AgentDef & { baseUrl?: string; model?: string; maxTokens?: number })
    | CustomAgentDef
    | null
    | undefined = getAgent(agentName) ?? cfg.agents.customAgents.find((a) => a.name === agentName);

  if (!def || ('enabled' in def && def.enabled === false)) {
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: 'Custom API agent disabled or not found.',
      error: 'custom-api-disabled',
      errorCategory: 'custom-api-disabled',
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
    };
  }

  const baseUrl = ('baseUrl' in def ? def.baseUrl : undefined) ?? 'http://localhost:11434/v1';
  const model = ('model' in def ? def.model : undefined) ?? 'default';
  const startTime = Date.now();
  const metricsHandle = recordCallStart(agentName, model);
  const span = await startAgentSpan(agentName, model, { phase: phaseLabel });
  const abortSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

  let output = '';
  try {
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'user', content: prompt },
    ];
    const maxTokens = 'maxTokens' in def ? (def as { maxTokens?: number }).maxTokens : undefined;
    const result = await streamLocalCompletion(
      messages,
      { baseUrl, model, maxTokens, signal: abortSignal },
      (chunk: string) => {
        output += chunk;
        if (onProgress)
          onProgress(Date.now() - startTime, Math.round(Buffer.byteLength(output, 'utf8') / 1024));
      },
    );

    const durationMs = Date.now() - startTime;
    if (!result.ok) {
      recordCallError(metricsHandle, result.errorCategory ?? 'unknown');
      await endAgentSpan(span, { ok: false, error: result.errorCategory });
      return {
        ok: false,
        output: '',
        stdout: '',
        stderr: result.errorCategory ?? '',
        error: result.errorCategory ?? null,
        errorCategory: result.errorCategory,
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
      errorCategory: undefined,
      exitCode: 0,
      signal: null,
      durationMs,
      timedOut: false,
    };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    const durationMs = Date.now() - startTime;
    recordCallError(metricsHandle, 'custom-cli-error');
    await endAgentSpan(span, { ok: false, error: e.message });
    return {
      ok: false,
      output: '',
      stdout: '',
      stderr: e.message,
      error: 'custom-cli-error',
      errorCategory: 'custom-cli-error',
      exitCode: null,
      signal: null,
      durationMs,
      timedOut: false,
    };
  }
}
