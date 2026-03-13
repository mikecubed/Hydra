/**
 * Agent Worker Management
 *
 * Extracted from hydra-operator.ts (rf-op01).
 * Manages the lifecycle of AgentWorker instances: start, stop, restart, and status.
 */

import type { Interface as ReadlineInterface } from 'node:readline';
import { AgentWorker } from './hydra-worker.ts';
import { resolveProject } from './hydra-config.ts';
import { setAgentActivity, drawStatusBar, setAgentExecMode } from './hydra-statusbar.ts';
import { pushActivity, annotateCompletion } from './hydra-activity.ts';
import { isChoiceActive } from './hydra-prompt-choice.ts';
import { colorAgent, SUCCESS, ERROR, DIM } from './hydra-ui.ts';
import pc from 'picocolors';

const config = resolveProject();

export const workers = new Map<string, AgentWorker>();

export function startAgentWorker(
  agent: string,
  baseUrl: string,
  { rl }: { rl?: ReadlineInterface } = {},
): AgentWorker | undefined {
  const name = agent.toLowerCase();
  if (workers.has(name) && workers.get(name)!.status !== 'stopped') {
    return workers.get(name);
  }

  const worker = new AgentWorker(name, {
    baseUrl,
    projectRoot: config.projectRoot,
  });

  // Wire worker events to status bar
  worker.on('task:start', ({ agent: a, taskId: _taskId, title }) => {
    setAgentActivity(a, 'working', title ?? 'Working', { taskTitle: title });
    drawStatusBar();
  });

  worker.on(
    'task:complete',
    ({ agent: a, taskId, title: taskTitle, status, durationMs, outputSummary }) => {
      // Record activity annotation for all completions
      pushActivity(
        status === 'error' ? 'error' : 'completion',
        annotateCompletion({
          agent: a,
          taskId,
          title: taskTitle ?? '',
          durationMs,
          outputSummary,
          status,
        }),
        { agent: a, taskId, durationMs },
      );

      // Skip success notification for failed tasks — task:error handler covers those
      if (status === 'error') return;

      const elapsed = durationMs ? `${String(Math.round(durationMs / 1000))}s` : '';
      const shortTitle = taskTitle ? ` (${String(taskTitle).slice(0, 40)})` : '';
      setAgentActivity(a, 'idle', `Done ${String(taskId)}${elapsed ? ` (${elapsed})` : ''}`);
      drawStatusBar();

      // Show inline notification with sparkle
      const icon = SUCCESS('\u2713');
      const sparkle = '\u2728'; // ✨
      const msg = `  ${icon} ${sparkle} ${colorAgent(a)} completed ${pc.white(taskId)}${shortTitle ? DIM(shortTitle) : ''}${elapsed ? ` ${DIM(`in ${elapsed}`)}` : ''}`;

      // Brief flash effect: bold → normal
      if (process.stdout.isTTY) {
        process.stdout.write(`\r\x1b[2K${pc.bold(msg)}\n`);
        setTimeout(() => {
          process.stdout.write(`\x1b[1A\r\x1b[2K${msg}\n`);
          if (rl && !isChoiceActive()) {
            rl.prompt(true);
          }
        }, 100);
      } else {
        process.stdout.write(`\r\x1b[2K${msg}\n`);
        if (rl && !isChoiceActive()) {
          rl.prompt(true);
        }
      }
    },
  );

  worker.on('task:error', ({ agent: a, taskId, title: taskTitle, error }) => {
    pushActivity(
      'error',
      annotateCompletion({
        agent: a,
        taskId,
        title: taskTitle ?? '',
        status: 'error',
        outputSummary: error,
      }),
      { agent: a, taskId },
    );

    setAgentActivity(a, 'error', `Error: ${String((error ?? '').slice(0, 30))}`);
    drawStatusBar();

    const shortTitle = taskTitle ? ` (${String(taskTitle).slice(0, 40)})` : '';
    const msg = `  ${ERROR('\u2717')} ${colorAgent(a)} error on ${pc.white(taskId ?? '?')}${shortTitle ? DIM(shortTitle) : ''}: ${DIM((error ?? '').slice(0, 60))}`;
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    if (rl && !isChoiceActive()) {
      rl.prompt(true);
    }
  });

  worker.on('worker:idle', ({ agent: a }) => {
    setAgentActivity(a, 'idle', 'Awaiting next task');
    drawStatusBar();
  });

  worker.on('worker:stop', ({ agent: a, reason: _reason }) => {
    setAgentExecMode(a, null);
    setAgentActivity(a, 'inactive', 'Stopped');
    drawStatusBar();
  });

  setAgentExecMode(name, 'worker');
  worker.start();
  workers.set(name, worker);

  console.log(
    `  ${SUCCESS('\u2713')} ${colorAgent(name)} worker started ${DIM(`(${worker.permissionMode})`)}`,
  );
  return worker;
}

export function stopAgentWorker(agent: string): void {
  const name = agent.toLowerCase();
  const worker = workers.get(name);
  if (!worker) return;
  worker.stop();
  setAgentExecMode(name, null);
}

export function stopAllWorkers(): void {
  for (const [name, worker] of workers) {
    worker.kill();
    setAgentExecMode(name, null);
  }
  workers.clear();
}

export function _getWorkerStatus(agent: string): {
  agent: string;
  status: string;
  currentTask: { taskId: string; title: string; startedAt: number } | null;
  uptime: number;
  permissionMode: string;
} | null {
  const worker = workers.get(agent.toLowerCase());
  if (!worker) return null;
  return {
    agent: worker.agent,
    status: worker.status,
    currentTask: worker.currentTask,
    uptime: worker.uptime,
    permissionMode: worker.permissionMode,
  };
}

export function startAgentWorkers(
  agentNames: string[],
  baseUrl: string,
  opts: { rl?: ReadlineInterface } = {},
): void {
  for (const agent of agentNames) {
    startAgentWorker(agent, baseUrl, opts);
  }
}
