#!/usr/bin/env node
/**
 * Orchestrator daemon for Gemini + Codex + Claude coordination.
 * Runs a local HTTP server that reads/writes the shared sync state.
 *
 * Graceful shutdown: On Unix, SIGINT/SIGTERM trigger a clean exit. On Windows,
 * process signals are not delivered the same way; use the HTTP /stop (or
 * orchestrator-client stop) endpoint for a Windows-safe graceful shutdown.
 */

import './hydra-env.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import {
  getAgent,
  AGENT_NAMES,
  classifyTask,
  getModelSummary,
  listAgents,
} from './hydra-agents.ts';
import { registerBuiltInSubAgents } from './hydra-sub-agents.ts';
import { syncHydraMd } from './hydra-sync-md.ts';
import {
  nextId,
  parseList,
  getCurrentBranch as _getCurrentBranch,
  ensureKnownStatus,
  ensureKnownAgent,
  detectCycle,
  autoUnblock,
  buildPrompt as _buildPrompt,
  getSummary,
  suggestNext,
} from './daemon/task-helpers.ts';
import { hydraSplash, label as uiLabel, divider, SUCCESS, DIM } from './hydra-ui.ts';
import { resolveProject, loadHydraConfig } from './hydra-config.ts';
import {
  readEvents,
  readArchive,
  archiveState,
  truncateEventsFile,
  createSnapshot,
  cleanOldSnapshots,
  checkIdempotency,
} from './daemon/archive.ts';
import { createTaskWorktree, mergeTaskWorktree, cleanupTaskWorktree } from './daemon/worktree.ts';
import { getMetricsSummary, persistMetrics, loadPersistedMetrics } from './hydra-metrics.ts';
import { checkUsage } from './hydra-usage.ts';
import { resolveVerificationPlan } from './hydra-verification.ts';
import { handleReadRoute } from './daemon/read-routes.ts';
import { handleWriteRoute } from './daemon/write-routes.ts';
import {
  nowIso,
  toSessionId,
  getEventSeq,
  ensureCoordFiles,
  readState,
  writeState,
  appendSyncLog,
  appendEvent,
  replayEvents,
} from './daemon/state.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  HydraStateShape,
  TaskEntry,
  WriteRouteCtx,
  UsageCheckResult,
  ModelSummaryEntry,
  AgentDef,
} from './types.ts';
import pc from 'picocolors';

const config = resolveProject();

const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const STATUS_PATH = config.statusPath;

const DEFAULT_HOST = process.env['AI_ORCH_HOST'] ?? '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env['AI_ORCH_PORT'] ?? '4173', 10);
const ORCH_TOKEN = process.env['AI_ORCH_TOKEN'] ?? '';

function getCurrentBranch() {
  return _getCurrentBranch(config.projectRoot);
}

function buildPrompt(agent: string, state: HydraStateShape) {
  return _buildPrompt(agent, state, config.projectRoot, config.projectName);
}

function parseArgs(argv: string[]) {
  const [command = 'start', ...rest] = argv.slice(2);
  const options: Record<string, string> = {};

  for (const token of rest) {
    if (token.includes('=')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key !== '') {
        options[key] = rawValue.join('=').trim();
      }
    }
  }

  return { command, options };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  statusCode: number,
  message: string,
  details: unknown = null,
) {
  sendJson(res, statusCode, {
    ok: false,
    error: message,
    details,
  });
}

function isAuthorized(req: IncomingMessage) {
  if (ORCH_TOKEN === '') {
    return true;
  }
  return req.headers['x-ai-orch-token'] === ORCH_TOKEN;
}

async function readJsonBody(req: IncomingMessage) {
  const chunks = [];
  let size = 0;
  const maxSize = 1024 * 1024;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxSize) {
      throw new Error('Payload too large.');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function requestJson(method: string, url: string, body: unknown = null) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (ORCH_TOKEN !== '') {
    headers['x-ai-orch-token'] = ORCH_TOKEN;
  }
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => ({}));
  return { response, payload };
}

function printHelp() {
  console.log(`
Hydra Orchestrator Daemon

Usage:
  node orchestrator-daemon.mjs start [host=127.0.0.1] [port=4173]
  node orchestrator-daemon.mjs status [url=http://127.0.0.1:4173]
  node orchestrator-daemon.mjs stop [url=http://127.0.0.1:4173]

Environment:
  AI_ORCH_HOST   Host bind (default: 127.0.0.1)
  AI_ORCH_PORT   Port bind (default: 4173)
  AI_ORCH_TOKEN  Optional API token for write endpoints
  HYDRA_PROJECT  Override target project directory
`);
}

async function commandStatus(options: Record<string, string>) {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('GET', `${url}/health`);
    if (!response.ok) {
      console.error(
        `Daemon status check failed (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error(`Daemon not reachable at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function commandStop(options: Record<string, string>) {
  const url = options['url'] ?? `http://${DEFAULT_HOST}:${String(DEFAULT_PORT)}`;
  try {
    const { response, payload } = await requestJson('POST', `${url}/shutdown`);
    if (!response.ok) {
      console.error(
        `Failed to stop daemon (${String(response.status)}): ${((payload as Record<string, unknown>)['error'] as string | null | undefined) ?? 'unknown error'}`,
      );
      process.exitCode = 1;
      return;
    }
    console.log('Stop signal sent to orchestrator daemon.');
  } catch (err) {
    console.error(`Unable to reach daemon at ${url}: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function startDaemon(options: Record<string, string>) {
  ensureCoordFiles();

  // Register built-in virtual sub-agents
  try {
    registerBuiltInSubAgents();
  } catch {
    /* sub-agents optional */
  }

  // Sync HYDRA.md → agent instruction files (silent)
  try {
    syncHydraMd(config.projectRoot);
  } catch {
    /* non-critical */
  }

  const host = options['host'] ?? DEFAULT_HOST;
  const port = Number.parseInt(options['port'] ?? String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`Invalid port: ${options['port']}`);
    process.exitCode = 1;
    return;
  }

  let isShuttingDown = false;
  const startedAt = nowIso();
  let lastEventAt = nowIso();
  let eventCount = 0;
  let writeQueue: Promise<unknown> = Promise.resolve();
  const sseClients = new Set<ServerResponse>();

  function broadcastEvent(event: unknown) {
    if (sseClients.size === 0) return;
    const data = JSON.stringify(event);
    for (const client of sseClients) {
      try {
        client.write(`data: ${data}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function writeStatus(extra: Record<string, unknown> = {}) {
    const state = readState();
    const payload = {
      service: 'hydra-orchestrator',
      project: config.projectName,
      projectRoot: config.projectRoot,
      running: !isShuttingDown,
      pid: process.pid,
      host,
      port,
      startedAt,
      updatedAt: nowIso(),
      uptimeSec: Math.floor(process.uptime()),
      stateUpdatedAt: state.updatedAt,
      activeSessionId: state.activeSession?.id ?? null,
      eventsRecorded: eventCount,
      lastEventAt,
      ...extra,
    };
    fs.writeFileSync(STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  function enqueueMutation<T>(
    label: string,
    mutator: (state: HydraStateShape) => T,
    detail: Record<string, unknown> = {},
  ) {
    const mutation = writeQueue.then(() => {
      const state = readState();
      const result = mutator(state);
      writeState(state);
      appendSyncLog(`[orch] ${label}`);
      const at = nowIso();
      const event = {
        id: `${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
        seq: getEventSeq() + 1,
        at,
        type: 'mutation',
        payload: { label, ...detail },
      };
      appendEvent('mutation', { label, ...detail }, event.id);
      broadcastEvent(event);
      lastEventAt = at;
      eventCount += 1;
      writeStatus();
      return result;
    });
    // Prevent queue poisoning: failed mutations must not block subsequent ones
    writeQueue = mutation.catch(() => {});
    return mutation;
  }

  function runVerification(taskId: string, plan: Record<string, unknown>) {
    if (plan['enabled'] !== true || plan['command'] == null || plan['command'] === '') {
      return;
    }

    appendEvent('verification_start', { taskId, command: plan['command'], source: plan['source'] });

    function handleVerificationResult(error: Error | null, stdout: string, stderr: string) {
      if (error) {
        const snippet = ([stderr, stdout, error.message] as string[]).find((s) => s !== '') ?? '';
        const snippetSliced = snippet.slice(0, 500);
        void enqueueMutation(
          `verify:fail id=${taskId}`,
          (state: HydraStateShape) => {
            const task = state.tasks.find((t: TaskEntry) => t.id === taskId);
            if (task) {
              task.status = 'blocked';
              const note = `[AUTO-VERIFY FAILED] ${String(plan['command'])}:\n${snippetSliced}`;
              task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
              task.updatedAt = nowIso();
            }
          },
          { event: 'verify', taskId, passed: false, command: plan['command'] },
        );
        appendEvent('verification_complete', {
          taskId,
          passed: false,
          command: plan['command'],
          snippet: snippetSliced,
        });
        return;
      }

      void enqueueMutation(
        `verify:pass id=${taskId}`,
        (state) => {
          const task = state.tasks.find((t) => t.id === taskId);
          if (task) {
            const note = `[AUTO-VERIFY PASSED] ${String(plan['command'])} completed cleanly.`;
            task.notes = task.notes === '' ? note : `${task.notes}\n${note}`;
            task.updatedAt = nowIso();
          }
        },
        { event: 'verify', taskId, passed: true, command: plan['command'] },
      );
      appendEvent('verification_complete', { taskId, passed: true, command: plan['command'] });
    }

    // Prefer exec (captures stdout/stderr) when possible, but fall back to a
    // no-pipes spawn mode for restricted sandboxes that forbid stdio pipes.
    try {
      exec(
        plan['command'] as string,
        { cwd: config.projectRoot, timeout: plan['timeoutMs'] as number, encoding: 'utf8' },
        handleVerificationResult,
      );
      return;
    } catch {
      // Fall through to spawn-based implementation below.
    }

    // No-pipes fallback: redirect stdout/stderr to temp files and read them at the end.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-verify-'));
    const stdoutPath = path.join(tmpDir, 'stdout.txt');
    const stderrPath = path.join(tmpDir, 'stderr.txt');

    let stdoutFd: number | null = null;
    let stderrFd: number | null = null;
    try {
      stdoutFd = fs.openSync(stdoutPath, 'w');
      stderrFd = fs.openSync(stderrPath, 'w');

      const child = spawn(plan['command'] as string, [], {
        cwd: config.projectRoot,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd],
      });

      // Parent can close immediately; child holds its own handles.
      try {
        fs.closeSync(stdoutFd);
      } catch {
        /* ignore */
      }
      try {
        fs.closeSync(stderrFd);
      } catch {
        /* ignore */
      }
      stdoutFd = null;
      stderrFd = null;

      let timedOut = false;
      let finished = false;
      const timer = setTimeout(
        () => {
          timedOut = true;
          try {
            child.kill();
          } catch {
            /* ignore */
          }
        },
        Math.max(1, (plan['timeoutMs'] as number) === 0 ? 60_000 : (plan['timeoutMs'] as number)),
      );

      function finish(err: Error | null, code: number | null) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        let out = '';
        let errText = '';
        try {
          out = fs.readFileSync(stdoutPath, 'utf8');
        } catch {
          /* ignore */
        }
        try {
          errText = fs.readFileSync(stderrPath, 'utf8');
        } catch {
          /* ignore */
        }
        const effectiveError =
          err ??
          (timedOut || code !== 0
            ? new Error(timedOut ? 'Verification timed out.' : `Exit ${String(code)}`)
            : null);
        handleVerificationResult(effectiveError, out, errText);
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }

      child.on('error', (err: Error) => {
        finish(err, null);
      });
      child.on('close', (code: number | null) => {
        finish(null, code);
      });
    } catch (err) {
      // If even the fallback can't start, treat as a failure but never throw.
      try {
        const msg = (
          (err as Error).message === '' ? 'Verification failed to start.' : (err as Error).message
        ).slice(0, 500);
        handleVerificationResult(new Error(msg), '', '');
      } catch {
        // ignore
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } finally {
      if (stdoutFd !== null) {
        try {
          fs.closeSync(stdoutFd);
        } catch {
          /* ignore */
        }
      }
      if (stderrFd !== null) {
        try {
          fs.closeSync(stderrFd);
        } catch {
          /* ignore */
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- async HTTP handler, errors caught in try/catch block
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? `${host}:${String(port)}`}`,
    );
    const route = requestUrl.pathname;
    const method = req.method ?? 'GET';

    try {
      const handledReadRoute = await handleReadRoute({
        method,
        route,
        requestUrl,
        req,
        res,
        sendJson,
        sendError,
        writeStatus,
        readStatus: () =>
          JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8')) as Record<string, unknown>,
        checkUsage: checkUsage as unknown as () => UsageCheckResult,
        getModelSummary: getModelSummary as () => Record<string, ModelSummaryEntry>,
        readState,
        getSummary,
        projectRoot: config.projectRoot,
        projectName: config.projectName,
        buildPrompt,
        suggestNext,
        readEvents,
        replayEvents,
        sseClients,
        readArchive,
        getMetricsSummary,
        getEventCount: () => eventCount,
      });
      if (handledReadRoute) {
        return;
      }

      if (!isAuthorized(req)) {
        sendError(res, 401, 'Unauthorized');
        return;
      }

      const handledWriteRoute = await handleWriteRoute({
        method,
        route,
        req,
        res,
        readJsonBody,
        sendJson,
        sendError,
        enqueueMutation,
        ensureKnownAgent,
        ensureKnownStatus,
        parseList,
        getCurrentBranch,
        toSessionId,
        nowIso,
        classifyTask,
        nextId,
        detectCycle,
        autoUnblock,
        readState,
        AGENT_NAMES,
        getAgent: getAgent as (name: string) => AgentDef | undefined,
        listAgents: listAgents as (...args: unknown[]) => AgentDef[],
        resolveVerificationPlan: resolveVerificationPlan as unknown as (
          ...args: unknown[]
        ) => Record<string, unknown>,
        projectRoot: config.projectRoot,
        runVerification: runVerification as (...args: unknown[]) => void,
        archiveState,
        truncateEventsFile,
        writeStatus,
        appendEvent,
        broadcastEvent,
        setIsShuttingDown: (value: boolean) => {
          isShuttingDown = value;
        },
        server,
        createSnapshot,
        cleanOldSnapshots,
        checkIdempotency,
        createTaskWorktree,
        mergeTaskWorktree,
        cleanupTaskWorktree,
      } as unknown as WriteRouteCtx);
      if (handledWriteRoute) {
        return;
      }

      sendError(res, 404, `Route not found: ${method} ${route}`);
    } catch (err) {
      sendError(res, 400, (err as Error).message === '' ? 'Bad request' : (err as Error).message);
    }
  });

  server.on('error', (error: Error) => {
    console.error(`Orchestrator server error: ${error.message}`);
    // eslint-disable-next-line n/no-process-exit -- server error handler requires forced exit
    process.exit(1);
  });

  function autoArchiveIfNeeded() {
    void enqueueMutation('auto_archive', (state: HydraStateShape) => {
      const completedCount = state.tasks.filter((t: TaskEntry) =>
        ['done', 'cancelled'].includes(t.status),
      ).length;
      if (completedCount > 20) {
        const moved = archiveState(state);
        if (moved > 0) {
          truncateEventsFile(500);
          return { moved };
        }
      }
      return { moved: 0 };
    })
      .then((result: Record<string, unknown>) => {
        if ((result['moved'] as number) > 0) {
          appendEvent('auto_archive', { moved: result['moved'] });
        }
      })
      .catch(() => {});
  }

  // Load persisted metrics from previous session
  loadPersistedMetrics(COORD_DIR);

  server.listen(port, host, () => {
    appendSyncLog(`[orch] daemon started at http://${host}:${String(port)}`);
    appendEvent('daemon_start', {
      host,
      port: String(port),
      pid: process.pid,
      project: config.projectName,
    });
    writeStatus();

    autoArchiveIfNeeded();

    console.log(hydraSplash());
    console.log(uiLabel('Project', pc.white(config.projectName)));
    console.log(uiLabel('Root', DIM(config.projectRoot)));
    console.log(uiLabel('URL', pc.white(`http://${host}:${String(port)}`)));
    console.log(uiLabel('PID', pc.white(String(process.pid))));
    console.log(uiLabel('State', DIM(path.relative(config.projectRoot, STATE_PATH))));
    console.log(uiLabel('Status', DIM(path.relative(config.projectRoot, STATUS_PATH))));
    console.log(divider());
    console.log(SUCCESS('  Daemon ready'));
    console.log('');
  });

  const statusInterval = setInterval(() => {
    writeStatus();
  }, 5000);

  const metricsInterval = setInterval(() => {
    persistMetrics(COORD_DIR);
  }, 30_000);

  const archiveInterval = setInterval(
    () => {
      autoArchiveIfNeeded();
    },
    30 * 60 * 1000,
  );

  // Stale task reaper: uses heartbeat timeout (fast) or updatedAt fallback (slow)
  const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min — no-heartbeat fallback

  function markStaleTasks() {
    try {
      const cfg = loadHydraConfig();
      const heartbeatTimeoutMsRaw = Number(
        ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
          'heartbeatTimeoutMs'
        ],
      );
      const heartbeatTimeoutMs = heartbeatTimeoutMsRaw === 0 ? 90_000 : heartbeatTimeoutMsRaw; // 90s default
      const maxAttemptsRaw = Number(
        (
          ((cfg as Record<string, unknown>)['workers'] as Record<string, unknown> | undefined)?.[
            'retry'
          ] as Record<string, unknown> | undefined
        )?.['maxAttempts'],
      );
      const maxAttempts = maxAttemptsRaw === 0 ? 3 : maxAttemptsRaw;
      const state = readState();
      const now = Date.now();
      let changed = false;

      for (const task of state.tasks) {
        if (task.status !== 'in_progress') continue;

        let isStale = false;

        if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
          // Legacy: use updatedAt/checkpoint (30 min)
          let lastActivity = task.updatedAt === '' ? 0 : new Date(task.updatedAt).getTime();
          if (Array.isArray(task.checkpoints) && task.checkpoints.length > 0) {
            const lastCp = task.checkpoints.at(-1);
            const cpTime = lastCp ? new Date(lastCp['savedAt'] as string).getTime() : 0;
            if (cpTime > lastActivity) lastActivity = cpTime;
          }
          isStale = now - lastActivity > STALE_THRESHOLD_MS;
        } else {
          const hbAge =
            now - new Date((task as Record<string, unknown>)['lastHeartbeat'] as string).getTime();
          isStale = hbAge > heartbeatTimeoutMs;
        }

        if (isStale && task.stale !== true) {
          task.stale = true;
          task.staleSince = nowIso();
          changed = true;

          // Heartbeat timeout: requeue or dead-letter based on failCount
          if ((task as Record<string, unknown>)['lastHeartbeat'] == null) {
            broadcastEvent({
              type: 'mutation',
              payload: {
                event: 'task_stale',
                taskId: task.id,
                owner: task.owner,
                title: task.title,
              },
            });
          } else {
            const currentFailCount = (task as Record<string, unknown>)['failCount'] as
              | number
              | undefined;
            const failCount = (currentFailCount ?? 0) + 1;
            (task as Record<string, unknown>)['failCount'] = failCount;

            if (failCount < maxAttempts) {
              // Requeue: reset to todo for retry
              task.status = 'todo';
              task.stale = false;
              delete task.staleSince;
              task.updatedAt = nowIso();
              broadcastEvent({
                type: 'mutation',
                payload: {
                  event: 'task:heartbeat_timeout',
                  taskId: task.id,
                  owner: task.owner,
                  action: 'requeue',
                  failCount,
                },
              });
              appendEvent('task:heartbeat_timeout', {
                taskId: task.id,
                owner: task.owner,
                action: 'requeue',
                failCount,
                category: 'heartbeat',
              });
            } else {
              // Exhausted retries → dead-letter queue
              if (!Array.isArray(state['deadLetter'])) state['deadLetter'] = [];
              (state['deadLetter'] as unknown[]).push({
                id: task.id,
                title: task.title,
                owner: task.owner,
                failCount,
                reason: 'heartbeat_timeout',
                movedAt: nowIso(),
              });
              (task as Record<string, unknown>)['status'] = 'failed';
              task.updatedAt = nowIso();
              broadcastEvent({
                type: 'mutation',
                payload: {
                  event: 'task:heartbeat_timeout',
                  taskId: task.id,
                  owner: task.owner,
                  action: 'dead_letter',
                  failCount,
                },
              });
              appendEvent('task:heartbeat_timeout', {
                taskId: task.id,
                owner: task.owner,
                action: 'dead_letter',
                failCount,
                category: 'heartbeat',
              });
            }
          }
        } else if (!isStale && task.stale === true) {
          task.stale = false;
          delete task.staleSince;
          changed = true;
        }
      }

      if (changed) {
        writeState(state);
      }
    } catch {
      // Non-critical — skip silently.
    }
  }

  const staleInterval = setInterval(() => {
    markStaleTasks();
  }, 60 * 1000); // 60s — frequent enough for heartbeat timeouts

  function gracefulExit(signal: string) {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    console.log('');
    console.log(DIM(`  Shutting down (${signal})...`));
    appendSyncLog(`[orch] daemon stopping (${signal})`);
    appendEvent('daemon_stop', { signal, pid: process.pid });
    // Close all SSE clients
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
    // Close MCP clients
    void import('./hydra-mcp.ts').then((m) => m.closeCodexMCP()).catch(() => {});
    persistMetrics(COORD_DIR);
    clearInterval(statusInterval);
    clearInterval(metricsInterval);
    clearInterval(archiveInterval);
    clearInterval(staleInterval);
    writeStatus({ running: false, stoppingAt: nowIso(), signal });
    server.close(() => {
      writeStatus({ running: false, stoppedAt: nowIso(), signal });
      console.log(SUCCESS('  Daemon stopped'));
      // eslint-disable-next-line n/no-process-exit -- server.close callback requires forced exit after cleanup
      process.exit(0);
    });
  }

  // SIGTERM is not reliably delivered on Windows; use HTTP POST /stop for graceful shutdown there.
  process.on('SIGINT', () => {
    gracefulExit('SIGINT');
  });
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => {
      gracefulExit('SIGTERM');
    });
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'start':
      startDaemon(options);
      return;
    case 'status':
      await commandStatus(options);
      return;
    case 'stop':
      await commandStop(options);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 1;
  }
}

void main();
