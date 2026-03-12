/**
 * Hydra Agent Worker - Headless background agent process manager.
 *
 * Spawns agent CLIs as non-interactive background processes with scoped
 * auto-permissions. Workers run the claim->execute->report loop autonomously,
 * emitting progress events for status bar integration.
 *
 * Usage:
 *   const worker = new AgentWorker('claude', { baseUrl, projectRoot });
 *   worker.on('task:complete', ({ agent, taskId }) => ...);
 *   worker.start();
 */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { getAgent } from './hydra-agents.ts';
import { request, short } from './hydra-utils.ts';
import { loadHydraConfig } from './hydra-config.ts';
import {
  detectModelError,
  recoverFromModelError,
  detectCodexError,
  detectUsageLimitError,
  formatResetTime,
} from './hydra-model-recovery.ts';
import { executeAgent } from './hydra-shared/agent-executor.ts';

// ── Global Concurrency ──────────────────────────────────────────────────────

let activeTaskCount = 0;
let globalMaxInFlight = 3;

/**
 * Get current worker concurrency stats.
 * @returns {{ active: number, maxInFlight: number, utilization: number }}
 */
export function getWorkerConcurrencyStats(): {
  active: number;
  maxInFlight: number;
  utilization: number;
} {
  return {
    active: activeTaskCount,
    maxInFlight: globalMaxInFlight,
    utilization: globalMaxInFlight > 0 ? activeTaskCount / globalMaxInFlight : 0,
  };
}

// ── Default Configuration ───────────────────────────────────────────────────

interface WorkerNextAction {
  action: string;
  handoff?: {
    id?: string;
    summary?: string;
    nextStep?: string;
    tasks?: string[];
  };
  task?: Record<string, unknown>;
}

interface WorkerConfig {
  permissionMode: string;
  pollIntervalMs: number;
  maxOutputBufferKB: number;
  autoChain: boolean;
  heartbeatIntervalMs?: number;
  concurrency?: {
    adaptivePolling?: boolean;
    maxInFlight?: number;
  };
  [key: string]: unknown;
}

const DEFAULTS: WorkerConfig = {
  permissionMode: 'auto-edit',
  pollIntervalMs: 1500,
  maxOutputBufferKB: 8,
  autoChain: true,
};

function getWorkerConfig(): WorkerConfig {
  try {
    const cfg = loadHydraConfig();
    return { ...DEFAULTS, ...(cfg.workers as Partial<WorkerConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

// ── AgentWorker Class ───────────────────────────────────────────────────────

export class AgentWorker extends EventEmitter {
  agent: string;
  baseUrl: string;
  projectRoot: string;
  permissionMode: string;
  autoChain: boolean;
  basePollIntervalMs: number;
  pollIntervalMs: number;
  maxOutputBytes: number;
  adaptivePolling: boolean;
  _status: string;
  _currentTask: { taskId: string; title: string; startedAt: number } | null;
  _stopped: boolean;
  _childProcess: ChildProcess | null;
  _loopPromise: Promise<void> | null;
  _startedAt: number | null;
  _failedTasks: Set<string>;
  _outputBuffer: string;

  /**
   * @param {string} agent - Agent name (gemini, codex, claude)
   * @param {object} opts
   * @param {string} opts.baseUrl - Daemon URL
   * @param {string} opts.projectRoot - Project working directory
   * @param {string} [opts.permissionMode] - 'auto-edit' or 'full-auto'
   * @param {boolean} [opts.autoChain] - Auto-loop to next task on completion
   */
  constructor(
    agent: string,
    {
      baseUrl,
      projectRoot,
      permissionMode,
      autoChain,
    }: {
      baseUrl?: string;
      projectRoot?: string;
      permissionMode?: string;
      autoChain?: boolean;
    } = {},
  ) {
    super();
    this.agent = agent.toLowerCase();
    this.baseUrl = baseUrl ?? '';
    this.projectRoot = projectRoot ?? '';

    const workerCfg = getWorkerConfig();
    this.permissionMode = permissionMode ?? workerCfg.permissionMode;
    this.autoChain = autoChain ?? workerCfg.autoChain;
    this.basePollIntervalMs = workerCfg.pollIntervalMs;
    this.pollIntervalMs = workerCfg.pollIntervalMs;
    this.maxOutputBytes = workerCfg.maxOutputBufferKB * 1024;
    this.adaptivePolling = workerCfg.concurrency?.adaptivePolling !== false;

    // Update global concurrency limit from config
    const maxFromCfg = workerCfg.concurrency?.maxInFlight;
    if (maxFromCfg != null && maxFromCfg > 0) globalMaxInFlight = maxFromCfg;

    this._status = 'stopped'; // 'idle' | 'working' | 'stopped' | 'error'
    this._currentTask = null; // { taskId, title, startedAt }
    this._stopped = false;
    this._childProcess = null;
    this._loopPromise = null;
    this._startedAt = null;
    this._failedTasks = new Set(); // taskIds that failed — skip if re-assigned
    this._outputBuffer = '';
  }

  get status(): string {
    return this._status;
  }

  get currentTask(): { taskId: string; title: string; startedAt: number } | null {
    return this._currentTask;
  }

  get uptime(): number {
    return this._startedAt == null ? 0 : Date.now() - this._startedAt;
  }

  /**
   * Start the work loop. Polls daemon for tasks, executes, reports, repeats.
   */
  start(): void {
    if (this._status === 'working' || this._status === 'idle') return;

    this._stopped = false;
    this._status = 'idle';
    this._startedAt = Date.now();
    this.emit('worker:start', { agent: this.agent });

    this._loopPromise = this._workLoop().catch((err: unknown) => {
      this._status = 'error';
      this.emit('worker:stop', { agent: this.agent, reason: (err as Error).message });
    });
  }

  /**
   * Graceful shutdown: finish current task, then exit loop.
   */
  stop(): void {
    this._stopped = true;
    if (this._status === 'idle') {
      this._status = 'stopped';
      this.emit('worker:stop', { agent: this.agent, reason: 'stopped' });
    }
    // If working, the loop will finish current task then exit
  }

  /**
   * Immediate kill: abort current process and exit.
   */
  kill(): void {
    this._stopped = true;
    if (this._childProcess) {
      try {
        this._childProcess.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      this._childProcess = null;
    }
    this._status = 'stopped';
    this._currentTask = null;
    this.emit('worker:stop', { agent: this.agent, reason: 'killed' });
  }

  /**
   * Update the permission mode at runtime.
   */
  setPermissionMode(mode: string): void {
    this.permissionMode = mode;
  }

  // ── Internal Work Loop ──────────────────────────────────────────────────

  async _workLoop(): Promise<void> {
    while (!this._stopped) {
      try {
        // Concurrency gate: wait if too many tasks running globally
        while (activeTaskCount >= globalMaxInFlight) {
          // eslint-disable-next-line no-await-in-loop -- concurrency gate
          await this._sleep(500);
        }

        // eslint-disable-next-line no-await-in-loop -- sequential task polling
        const next = await this._pollNext();

        if (!next || next.action === 'idle') {
          this._status = 'idle';
          this._currentTask = null;
          this.emit('worker:idle', { agent: this.agent });

          // Adaptive polling: slow down when mostly utilized, speed up when idle
          if (this.adaptivePolling) {
            const utilization = globalMaxInFlight > 0 ? activeTaskCount / globalMaxInFlight : 0;
            if (utilization > 0.8) {
              this.pollIntervalMs = Math.min(
                this.basePollIntervalMs * 3,
                this.pollIntervalMs * 1.5,
              );
            } else if (utilization < 0.3) {
              this.pollIntervalMs = Math.max(
                this.basePollIntervalMs * 0.5,
                this.pollIntervalMs * 0.8,
              );
            }
          }

          // eslint-disable-next-line no-await-in-loop -- sequential worker loop
          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // We have work to do
        let prompt: string, taskId: string, title: string;

        if (next.action === 'pickup_handoff') {
          // Acknowledge the handoff
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential worker loop
            await request('POST', this.baseUrl, '/handoff/ack', {
              handoffId: next.handoff?.id,
              agent: this.agent,
            });
          } catch {
            /* non-critical */
          }

          prompt = next.handoff?.summary ?? next.handoff?.nextStep ?? 'Continue assigned work.';
          taskId = next.handoff?.tasks?.[0] ?? next.handoff?.id ?? 'unknown';
          title = short(prompt, 80);
        } else if (
          next.action === 'claim_owned_task' ||
          next.action === 'claim_unassigned_task' ||
          next.action === 'continue_task'
        ) {
          const task = next.task;
          taskId = (task?.['id'] as string | undefined) ?? 'unknown';
          title = (task?.['title'] as string | undefined) ?? 'Untitled task';

          // Claim the task
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential worker loop
            await request('POST', this.baseUrl, '/task/claim', {
              taskId,
              agent: this.agent,
            });
          } catch {
            /* may already be claimed */
          }

          prompt = this._buildTaskPrompt(task ?? null);
        } else {
          // Unknown action — sleep and retry
          // eslint-disable-next-line no-await-in-loop -- sequential worker loop
          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // Skip tasks that already failed on this worker (prevent infinite retry)
        if (this._failedTasks.has(taskId)) {
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential worker loop
            await request('POST', this.baseUrl, '/task/update', {
              taskId,
              status: 'blocked',
              notes: `Worker ${this.agent}: task previously failed, marking blocked to prevent retry loop.`,
            });
          } catch {
            /* daemon may be down */
          }
          // eslint-disable-next-line no-await-in-loop -- sequential worker: blocked task backoff
          await this._sleep(this.pollIntervalMs);
          continue;
        }

        // Execute
        this._status = 'working';
        activeTaskCount++;
        this.emit('task:start', { agent: this.agent, taskId, title });

        // Heartbeat interval: send periodic pings to daemon during execution
        const workerCfg = getWorkerConfig();
        const hbIntervalMs = workerCfg.heartbeatIntervalMs ?? 30_000;
        const hbInterval = setInterval(() => {
          fetch(`${this.baseUrl}/task/${taskId}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent: this.agent,
              outputBytes: this._outputBuffer.length,
              phase: 'executing',
            }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {}); // fire-and-forget
        }, hbIntervalMs);

        let result;
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential retry after model error
          result = await this._executeAgent(prompt);
        } finally {
          clearInterval(hbInterval);
        }

        // ── Error recovery (headless auto-fallback) ─────────────────
        if (!result.ok) {
          // 1. Check for account-level usage limits FIRST — no retry possible
          const usageCheck = detectUsageLimitError(
            this.agent,
            result as unknown as Record<string, unknown>,
          );
          if (usageCheck.isUsageLimit) {
            const resetMsg =
              usageCheck.resetInSeconds != null && usageCheck.resetInSeconds !== 0
                ? ` (resets in ${formatResetTime(usageCheck.resetInSeconds)})`
                : '';
            this.emit('task:progress', {
              agent: this.agent,
              taskId,
              output: `[usage-limit] ${usageCheck.errorMessage}${resetMsg}`,
            });
            // Annotate result so the error report is informative
            result.errorCategory = 'usage-limit';
            result.errorDetail = usageCheck.errorMessage;
            // 2. Check for Codex-specific errors (auth/sandbox/invocation)
            // — these should NOT be retried with a different model
          } else {
            const codexCheck = detectCodexError(
              this.agent,
              result as unknown as Record<string, unknown>,
            );
            if (codexCheck.isCodexError) {
              const codexCat = typeof codexCheck.category === 'string' ? codexCheck.category : '';
              const codexMsg =
                typeof codexCheck.errorMessage === 'string' ? codexCheck.errorMessage : '';
              this.emit('task:progress', {
                agent: this.agent,
                taskId,
                output: `[${codexCat}] ${codexMsg}`,
              });
              // Don't attempt model fallback — this is an env/config issue
            } else {
              // Model error → try fallback model
              const modelCheck = detectModelError(
                this.agent,
                result as unknown as Record<string, unknown>,
              );
              if (modelCheck.isModelError) {
                // eslint-disable-next-line no-await-in-loop -- sequential model error recovery
                const recovery = (await recoverFromModelError(
                  this.agent,
                  modelCheck.failedModel ?? '',
                )) as { recovered: boolean; newModel: string | null };
                if (recovery.recovered) {
                  this.emit('task:progress', {
                    agent: this.agent,
                    taskId,
                    output: `Model recovery: ${modelCheck.failedModel ?? ''} → ${recovery.newModel ?? ''}`,
                  });
                  // eslint-disable-next-line no-await-in-loop -- sequential retry after recovery
                  result = await this._executeAgent(prompt);
                  result.recovered = true;
                  result.originalModel = modelCheck.failedModel ?? undefined;
                  result.newModel = recovery.newModel ?? undefined;
                }
              }
            }
          }
        }

        const durationMs = Date.now() - this._currentTask.startedAt;
        const outputSummary = short(result.output, 200);

        // Report result to daemon (include structured error info for telemetry)
        const errorInfo = result.ok
          ? undefined
          : {
              exitCode: result.exitCode,
              signal: result.signal ?? null,
              stderr: short(result.stderr, 500),
              error: result.error,
              errorCategory: result.errorCategory ?? null,
              errorDetail: result.errorDetail ?? null,
              errorContext: result.errorContext ?? null,
            };
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential worker loop
          await request('POST', this.baseUrl, '/task/result', {
            taskId,
            agent: this.agent,
            status: result.ok ? 'done' : 'error',
            output: short(result.output, 2000),
            durationMs,
            ...(errorInfo && { errorInfo }),
          });
        } catch {
          // Fallback: try task/update if /task/result doesn't exist
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential worker loop fallback
            await request('POST', this.baseUrl, '/task/update', {
              taskId,
              status: result.ok ? 'done' : 'blocked',
              notes: result.ok
                ? `Worker output: ${outputSummary}`
                : `Worker error: ${result.error ?? outputSummary}`,
            });
          } catch {
            /* daemon may be down */
          }
        }

        activeTaskCount = Math.max(0, activeTaskCount - 1);
        this._currentTask = null;
        this._status = 'idle';
        this.emit('task:complete', {
          agent: this.agent,
          taskId,
          title,
          status: result.ok ? 'done' : 'error',
          durationMs,
          outputSummary,
        });

        if (result.error != null && result.error !== '') {
          this._failedTasks.add(taskId);
          this.emit('task:error', {
            agent: this.agent,
            taskId,
            title,
            error:
              result.errorCategory != null && result.errorCategory !== ''
                ? `[${result.errorCategory}] ${result.errorDetail ?? result.error}`
                : result.error,
            exitCode: result.exitCode,
            signal: result.signal ?? null,
            errorCategory: result.errorCategory ?? null,
            errorDetail: result.errorDetail ?? null,
            errorContext: result.errorContext ?? null,
            stderr: short(result.stderr, 300),
          });

          // If this is a usage limit (e.g. ChatGPT Codex quota exhausted),
          // stop the worker — no point processing more tasks until it resets.
          const usageCheck = detectUsageLimitError(
            this.agent,
            result as unknown as Record<string, unknown>,
          );
          if (usageCheck.isUsageLimit) {
            const resetLabel =
              usageCheck.resetInSeconds != null && usageCheck.resetInSeconds !== 0
                ? ` (resets in ${formatResetTime(usageCheck.resetInSeconds)})`
                : '';
            this.emit('task:progress', {
              agent: this.agent,
              taskId,
              output: `${this.agent} usage limit hit${resetLabel} — stopping worker`,
            });
            this.stop();
            break;
          }

          // Backoff after task failure before polling for next work
          // eslint-disable-next-line no-await-in-loop -- failure backoff
          await this._sleep(Math.min(this.pollIntervalMs * 3, 8_000));
        }

        // Auto-chain: immediately loop for next task (no delay)
        if (!this.autoChain) {
          // If not auto-chaining, wait for explicit restart
          this._stopped = true;
        }
      } catch (err: unknown) {
        if (this._status === 'working') activeTaskCount = Math.max(0, activeTaskCount - 1);
        this._status = 'error';
        this.emit('task:error', {
          agent: this.agent,
          taskId: this._currentTask?.taskId ?? 'unknown',
          title: this._currentTask?.title ?? '',
          error: (err as Error).message,
        });
        this._currentTask = null;

        // Backoff on errors
        // eslint-disable-next-line no-await-in-loop -- sequential error backoff
        await this._sleep(Math.min(this.pollIntervalMs * 4, 10_000));
        this._status = 'idle';
      }
    }

    this._status = 'stopped';
    this._currentTask = null;
  }

  /**
   * Poll daemon for next available work.
   */
  async _pollNext(): Promise<WorkerNextAction | null> {
    try {
      const data = await request(
        'GET',
        this.baseUrl,
        `/next?agent=${encodeURIComponent(this.agent)}`,
      );
      return (data as { next?: WorkerNextAction }).next ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Build a prompt string from a task object.
   * If the task has a preferredAgent that's a virtual agent, use its rolePrompt.
   */
  _buildTaskPrompt(task: Record<string, unknown> | null): string {
    if (task == null) return 'Continue assigned work.';

    // Use virtual agent's rolePrompt if task specifies one
    let rolePrompt = '';
    if (task['preferredAgent'] != null) {
      const preferred = getAgent(task['preferredAgent'] as string);
      if (preferred?.rolePrompt != null && preferred.rolePrompt !== '') {
        rolePrompt = preferred.rolePrompt;
      }
    }
    if (rolePrompt === '') {
      const agentConfig = getAgent(this.agent);
      rolePrompt = agentConfig?.rolePrompt ?? '';
    }

    const title = typeof task['title'] === 'string' ? task['title'] : 'Untitled';
    const parts = [`Task: ${title}`];
    if (task['notes'] != null) {
      const notes =
        typeof task['notes'] === 'string' ? task['notes'] : JSON.stringify(task['notes']);
      parts.push(`Notes: ${notes}`);
    }
    if (task['done'] != null) {
      const done = typeof task['done'] === 'string' ? task['done'] : JSON.stringify(task['done']);
      parts.push(`Definition of Done: ${done}`);
    }
    if (rolePrompt !== '') parts.push('', rolePrompt);
    parts.push('', 'Execute this task. Report exactly what you changed.');

    return parts.join('\n');
  }

  /**
   * Execute the agent CLI as a headless subprocess.
   * Resolves virtual agents to their physical CLI backend.
   * Returns { ok, output, error, tokenUsage }.
   */
  async _executeAgent(prompt: string): Promise<Awaited<ReturnType<typeof executeAgent>>> {
    const result = await executeAgent(this.agent, prompt, {
      cwd: this.projectRoot,
      permissionMode: this.permissionMode,
      maxOutputBytes: this.maxOutputBytes,
      onProgress: (_elapsed: number, outputKB: number, status?: string) => {
        this.emit('task:progress', {
          agent: this.agent,
          taskId: this._currentTask?.taskId,
          output: status ?? `${String(outputKB)}KB received`,
        });
      },
    });

    return result;
  }

  _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const id = setTimeout(resolve, ms);
      // Don't block process exit
      id.unref();
    });
  }
}
