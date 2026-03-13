import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { HydraStateShape, TaskEntry } from '../lib/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(REPO_ROOT, 'lib', 'orchestrator-daemon.ts');

type RequestResult<T = Record<string, unknown>> = {
  response: { status: number; ok: boolean };
  json: T;
  text: string;
};

type DaemonInstance = {
  child: ChildProcess;
  baseUrl: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTempProject(packageJson: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-daemon-state-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );
  return root;
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function requestJson<T = Record<string, unknown>>(
  baseUrl: string,
  method: string,
  route: string,
  body: unknown = null,
  timeoutMs = 4_000,
): Promise<RequestResult<T>> {
  const target = new URL(route, baseUrl);
  const payload = body == null ? '' : JSON.stringify(body);

  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers:
          body == null
            ? undefined
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let json = {} as T;
          try {
            json = JSON.parse(text) as T;
          } catch {
            // Keep fallback empty object for non-JSON responses.
          }
          const status = res.statusCode ?? 0;
          resolve({
            response: {
              status,
              ok: status >= 200 && status < 300,
            },
            json,
            text,
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout: ${method} ${route}`));
    });
    req.once('error', reject);

    if (payload !== '') {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before becoming healthy (exit=${String(child.exitCode)})`);
    }
    try {
      const { response } = await requestJson(baseUrl, 'GET', '/health');
      if (response.ok) {
        return;
      }
    } catch {
      // Retry until timeout.
    }
    await sleep(125);
  }
  throw new Error('Timed out waiting for daemon health check');
}

async function waitForExit(child: ChildProcess, timeoutMs = 4_000): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function startDaemon(projectRoot: string): Promise<DaemonInstance> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${String(port)}`, `project=${projectRoot}`],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  child.unref();

  await waitForHealth(baseUrl, child);
  return { child, baseUrl };
}

async function stopDaemon(instance: DaemonInstance | null): Promise<void> {
  if (instance == null) {
    return;
  }
  try {
    await requestJson(instance.baseUrl, 'POST', '/shutdown', {}, 1_500);
  } catch {
    // Fall through to process termination below.
  }
  await waitForExit(instance.child, 1_500);
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await waitForExit(instance.child, 2_000);
  }
}

async function removeDirBestEffort(dirPath: string, attempts = 8): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || index === attempts - 1) {
        return;
      }
      await sleep(150);
    }
  }
}

async function getState(baseUrl: string): Promise<HydraStateShape> {
  const response = await requestJson<{ state: HydraStateShape }>(baseUrl, 'GET', '/state');
  assert.equal(response.response.status, 200);
  return response.json.state;
}

function findTask(state: HydraStateShape, taskId: string): TaskEntry | undefined {
  return state.tasks.find((task) => task.id === taskId);
}

describe('hydra daemon state-machine characterization', () => {
  it(
    'moves tasks through claim, update, result completion, and auto-unblock flow',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-lifecycle',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot);

      const parent = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Implement the parent task',
          owner: 'unassigned',
        },
      );
      const dependent = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Wait on the parent task',
          owner: 'gemini',
          status: 'blocked',
          blockedBy: [parent.json.task.id],
        },
      );

      const claim = await requestJson<{ task: { id: string; claimToken: string; status: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/claim',
        {
          taskId: parent.json.task.id,
          agent: 'claude',
        },
      );
      assert.equal(claim.response.status, 200);
      assert.equal(claim.json.task.status, 'in_progress');

      const update = await requestJson<{ task: { notes: string; status: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          taskId: parent.json.task.id,
          claimToken: claim.json.task.claimToken,
          notes: 'Started implementing the parent task',
        },
      );
      assert.equal(update.response.status, 200);
      assert.match(update.json.task.notes, /Started implementing/);
      assert.equal(update.json.task.status, 'in_progress');

      const result = await requestJson<{
        task: { status: string; results?: Array<{ status: string; output: string }> };
        entry: { status: string; output: string };
      }>(daemon.baseUrl, 'POST', '/task/result', {
        taskId: parent.json.task.id,
        agent: 'claude',
        status: 'completed',
        output: 'Parent task finished cleanly',
        durationMs: 125,
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.json.entry.status, 'completed');
      assert.equal(result.json.task.status, 'done');

      const state = await getState(daemon.baseUrl);
      const completedParent = findTask(state, parent.json.task.id);
      const unblockedChild = findTask(state, dependent.json.task.id);
      assert.ok(completedParent);
      assert.ok(unblockedChild);
      assert.equal(completedParent.status, 'done');
      const completedResults = completedParent['results'] as Array<{ status: string }> | undefined;
      assert.equal(completedResults?.length, 1);
      assert.equal(unblockedChild.status, 'todo');
      assert.match(unblockedChild.notes, /All dependencies completed/);
    },
  );

  it(
    'serializes concurrent claims and records worker heartbeats',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-concurrency',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot);

      const add = await requestJson<{ task: { id: string } }>(daemon.baseUrl, 'POST', '/task/add', {
        title: 'Contended task',
      });
      const taskId = add.json.task.id;

      const claims = await Promise.all([
        requestJson<{ task?: { owner: string; claimToken: string }; error?: string }>(
          daemon.baseUrl,
          'POST',
          '/task/claim',
          { taskId, agent: 'claude' },
        ),
        requestJson<{ task?: { owner: string; claimToken: string }; error?: string }>(
          daemon.baseUrl,
          'POST',
          '/task/claim',
          { taskId, agent: 'gemini' },
        ),
      ]);

      const success = claims.find((result) => result.response.status === 200);
      const failure = claims.find((result) => result.response.status === 400);
      assert.ok(success, 'One claimant should win the race');
      assert.ok(failure, 'One claimant should lose the race');
      assert.ok(success.json.task);
      assert.ok(success.json.task.claimToken);
      assert.match(failure.json.error ?? '', /already in progress by/i);

      const owner = success.json.task.owner;
      const heartbeat = await requestJson<{
        taskId: string;
        heartbeat: string;
      }>(daemon.baseUrl, 'POST', `/task/${taskId}/heartbeat`, {
        agent: owner,
        progress: 42,
        outputBytes: 1024,
        phase: 'tests',
      });
      assert.equal(heartbeat.response.status, 200);
      assert.equal(heartbeat.json.taskId, taskId);
      assert.match(heartbeat.json.heartbeat, /^\d{4}-\d{2}-\d{2}T/);

      const state = await getState(daemon.baseUrl);
      const task = findTask(state, taskId);
      assert.ok(task);
      assert.equal(task.owner, owner);
      assert.equal(task.status, 'in_progress');
      const lastHeartbeat = task['lastHeartbeat'];
      assert.equal(typeof lastHeartbeat, 'string');
      if (typeof lastHeartbeat !== 'string') {
        assert.fail('Expected lastHeartbeat to be recorded as an ISO string');
      }
      assert.match(lastHeartbeat, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(task['lastHeartbeatDetail'], {
        agent: owner,
        progress: 42,
        outputBytes: 1024,
        phase: 'tests',
      });

      const stale = await requestJson<{ tasks: Array<{ id: string }> }>(
        daemon.baseUrl,
        'GET',
        '/tasks/stale',
      );
      assert.equal(stale.response.status, 200);
      assert.deepEqual(stale.json.tasks, []);
    },
  );

  it(
    'rejects missing fields, invalid task IDs, invalid statuses, and circular dependencies',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-invalid',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot);

      const missingTaskId = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          notes: 'Missing task id',
        },
      );
      assert.equal(missingTaskId.response.status, 400);
      assert.match(missingTaskId.json.error ?? '', /taskId/i);

      const missingAgent = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/result',
        {
          taskId: 'T404',
        },
      );
      assert.equal(missingAgent.response.status, 400);
      assert.match(missingAgent.json.error ?? '', /taskId.*agent|agent.*taskId/i);

      const first = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'First dependency node',
        },
      );
      const second = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Second dependency node',
        },
      );

      const invalidTask = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          taskId: 'T999',
          status: 'done',
        },
      );
      assert.equal(invalidTask.response.status, 400);
      assert.match(invalidTask.json.error ?? '', /not found/i);

      const firstDependency = await requestJson<{ task: { blockedBy: string[] } }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          taskId: first.json.task.id,
          blockedBy: [second.json.task.id],
        },
      );
      assert.equal(firstDependency.response.status, 200);
      assert.deepEqual(firstDependency.json.task.blockedBy, [second.json.task.id]);

      const circular = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          taskId: second.json.task.id,
          blockedBy: [first.json.task.id],
        },
      );
      assert.equal(circular.response.status, 400);
      assert.match(circular.json.error ?? '', /circular dependency/i);

      const invalidStatus = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/update',
        {
          taskId: first.json.task.id,
          status: 'failed',
        },
      );
      assert.equal(invalidStatus.response.status, 400);
      assert.match(invalidStatus.json.error ?? '', /invalid status/i);
    },
  );

  it(
    'dead-letters repeated worker errors and allows retrying the task',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-dlq',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot);

      const claim = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/claim',
        {
          title: 'Flaky worker task',
          agent: 'codex',
        },
      );
      const taskId = claim.json.task.id;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const errorResult: RequestResult<{
          task: { status: string; failCount?: number; blockedReason?: string };
          entry: { status: string };
        }> = await requestJson(daemon.baseUrl, 'POST', '/task/result', {
          taskId,
          agent: 'codex',
          status: 'error',
          output: `failure ${String(attempt)}`,
          durationMs: 25,
        });
        assert.equal(errorResult.response.status, 200);
        assert.equal(errorResult.json.entry.status, 'error');
        assert.equal(errorResult.json.task.status, 'blocked');
        assert.equal(errorResult.json.task.failCount, attempt);
        assert.match(
          errorResult.json.task.blockedReason ?? '',
          new RegExp(`failure ${String(attempt)}`),
        );

        const reopen: RequestResult<{ task: { status: string; owner: string } }> =
          await requestJson(daemon.baseUrl, 'POST', '/task/update', {
            taskId,
            owner: 'codex',
            status: 'in_progress',
          });
        assert.equal(reopen.response.status, 200);
        assert.equal(reopen.json.task.status, 'in_progress');
      }

      const terminalError = await requestJson<{
        task: { status: string; deadLetteredAt?: string; failCount?: number };
        entry: { status: string };
      }>(daemon.baseUrl, 'POST', '/task/result', {
        taskId,
        agent: 'codex',
        status: 'error',
        output: 'failure 3',
        durationMs: 25,
      });
      assert.equal(terminalError.response.status, 200);
      assert.equal(terminalError.json.entry.status, 'error');
      assert.equal(terminalError.json.task.status, 'cancelled');
      assert.equal(terminalError.json.task.failCount, 3);
      assert.match(terminalError.json.task.deadLetteredAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const stateAfterDeadLetter = await getState(daemon.baseUrl);
      assert.equal(findTask(stateAfterDeadLetter, taskId), undefined);

      const deadLetter = await requestJson<{
        items: Array<{ id: string; status?: string; failCount?: number; deadLetteredAt?: string }>;
      }>(daemon.baseUrl, 'GET', '/dead-letter');
      assert.equal(deadLetter.response.status, 200);
      assert.equal(deadLetter.json.items.length, 1);
      assert.equal(deadLetter.json.items[0]?.id, taskId);
      assert.equal(deadLetter.json.items[0]?.status, 'cancelled');
      assert.equal(deadLetter.json.items[0]?.failCount, 3);

      const retry = await requestJson<{
        task: { id: string; status: string; failCount: number; retriedAt?: string };
      }>(daemon.baseUrl, 'POST', '/dead-letter/retry', { id: taskId });
      assert.equal(retry.response.status, 200);
      assert.equal(retry.json.task.id, taskId);
      assert.equal(retry.json.task.status, 'todo');
      assert.equal(retry.json.task.failCount, 0);
      assert.match(retry.json.task.retriedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

      const stateAfterRetry = await getState(daemon.baseUrl);
      assert.equal(findTask(stateAfterRetry, taskId)?.status, 'todo');

      const deadLetterAfterRetry = await requestJson<{ items: Array<unknown> }>(
        daemon.baseUrl,
        'GET',
        '/dead-letter',
      );
      assert.deepEqual(deadLetterAfterRetry.json.items, []);
    },
  );
});
