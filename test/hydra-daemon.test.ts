import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import type { HydraStateShape } from '../lib/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(REPO_ROOT, 'lib', 'orchestrator-daemon.ts');

type RequestResult<T = Record<string, unknown>> = {
  response: { status: number; ok: boolean };
  json: T;
  text: string;
};

type RequestOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
};

type DaemonInstance = {
  child: ChildProcess;
  baseUrl: string;
  authToken?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTempProject(packageJson: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-daemon-ts-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );
  return root;
}

function getCoordinationPaths(projectRoot: string) {
  const coordDir = path.join(projectRoot, 'docs', 'coordination');
  return {
    coordDir,
    statePath: path.join(coordDir, 'AI_SYNC_STATE.json'),
    eventsPath: path.join(coordDir, 'AI_ORCHESTRATOR_EVENTS.ndjson'),
  };
}

function readStateFile(projectRoot: string): HydraStateShape {
  const { statePath } = getCoordinationPaths(projectRoot);
  return JSON.parse(fs.readFileSync(statePath, 'utf8')) as HydraStateShape;
}

function readEventsFile(projectRoot: string): Array<Record<string, unknown>> {
  const { eventsPath } = getCoordinationPaths(projectRoot);
  return fs
    .readFileSync(eventsPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
  options: RequestOptions = {},
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
        headers: {
          ...(body == null
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }),
          ...(options.headers ?? {}),
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
            // Keep the empty object fallback for non-JSON responses.
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

    req.setTimeout(options.timeoutMs ?? 4_000, () => {
      req.destroy(new Error(`Request timeout: ${method} ${route}`));
    });
    req.once('error', reject);

    if (payload !== '') {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  headers?: Record<string, string>,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before becoming healthy (exit=${String(child.exitCode)})`);
    }
    try {
      const { response } = await requestJson(baseUrl, 'GET', '/health', null, { headers });
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

async function startDaemon(
  projectRoot: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DaemonInstance> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const authToken = options.env?.['AI_ORCH_TOKEN'];
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${String(port)}`, `project=${projectRoot}`],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        ...options.env,
      },
    },
  );
  child.unref();

  await waitForHealth(baseUrl, child, authToken ? { 'x-ai-orch-token': authToken } : undefined);
  return { child, baseUrl, authToken };
}

async function stopDaemon(instance: DaemonInstance | null): Promise<void> {
  if (instance == null) {
    return;
  }
  try {
    await requestJson(
      instance.baseUrl,
      'POST',
      '/shutdown',
      {},
      {
        timeoutMs: 1_500,
        headers: instance.authToken ? { 'x-ai-orch-token': instance.authToken } : undefined,
      },
    );
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

describe('hydra daemon endpoint characterization', () => {
  it(
    'enforces write auth and rejects duplicate idempotency keys',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-auth',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot, { env: { AI_ORCH_TOKEN: 'top-secret-token' } });
      const authHeaders = { 'x-ai-orch-token': 'top-secret-token' };

      const state = await requestJson<{ ok: boolean; state: HydraStateShape }>(
        daemon.baseUrl,
        'GET',
        '/state',
      );
      assert.equal(state.response.status, 200);
      assert.deepEqual(state.json.state.tasks, []);

      const unauthorized = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'should be rejected',
        },
      );
      assert.equal(unauthorized.response.status, 401);
      assert.match(unauthorized.json.error ?? '', /unauthorized/i);

      const firstCreate = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        { title: 'safe write' },
        {
          headers: {
            ...authHeaders,
            'idempotency-key': 'hydra-daemon-add-once',
          },
        },
      );
      assert.equal(firstCreate.response.status, 200);
      assert.equal(firstCreate.json.task.id, 'T001');

      const duplicateCreate = await requestJson<{ error?: string }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        { title: 'safe write' },
        {
          headers: {
            ...authHeaders,
            'idempotency-key': 'hydra-daemon-add-once',
          },
        },
      );
      assert.equal(duplicateCreate.response.status, 409);
      assert.match(duplicateCreate.json.error ?? '', /duplicate request/i);

      const persisted = await requestJson<{ state: HydraStateShape }>(
        daemon.baseUrl,
        'GET',
        '/state',
      );
      assert.equal(persisted.json.state.tasks.length, 1);
      assert.equal(persisted.json.state.tasks[0]?.title, 'safe write');
    },
  );

  it('persists state and event logs across daemon restarts', { timeout: 60_000 }, async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-daemon-persist',
      private: true,
      type: 'module',
    });
    const daemons: DaemonInstance[] = [];
    t.after(async () => {
      for (const daemonInstance of daemons.reverse()) {
        await stopDaemon(daemonInstance);
      }
      await removeDirBestEffort(projectRoot);
    });

    const daemon = await startDaemon(projectRoot);
    daemons.push(daemon);

    const add = await requestJson<{ task: { id: string } }>(daemon.baseUrl, 'POST', '/task/add', {
      title: 'persisted task',
      owner: 'claude',
      notes: 'survives restart',
    });
    assert.equal(add.response.status, 200);

    const decision = await requestJson<{ decision: { id: string } }>(
      daemon.baseUrl,
      'POST',
      '/decision',
      {
        title: 'Keep daemon state on disk',
        owner: 'human',
        rationale: 'characterization test',
      },
    );
    assert.equal(decision.response.status, 200);
    assert.equal(decision.json.decision.id, 'D001');

    const beforeRestart = await requestJson<{ events: Array<{ seq: number; category?: string }> }>(
      daemon.baseUrl,
      'GET',
      '/events/replay?from=0',
    );
    assert.equal(beforeRestart.response.status, 200);
    const beforeMaxSeq = Math.max(...beforeRestart.json.events.map((event) => event.seq));

    const stateOnDisk = readStateFile(projectRoot);
    assert.equal(stateOnDisk.tasks[0]?.title, 'persisted task');
    assert.equal(stateOnDisk.decisions[0]?.title, 'Keep daemon state on disk');

    const eventsOnDisk = readEventsFile(projectRoot);
    assert.ok(eventsOnDisk.length >= beforeRestart.json.events.length);
    assert.ok(eventsOnDisk.some((event) => event['category'] === 'task'));
    assert.ok(eventsOnDisk.some((event) => event['category'] === 'decision'));

    await stopDaemon(daemon);
    const restartedDaemon = await startDaemon(projectRoot);
    daemons.push(restartedDaemon);

    const afterRestartState = await requestJson<{ state: HydraStateShape }>(
      restartedDaemon.baseUrl,
      'GET',
      '/state',
    );
    assert.equal(afterRestartState.response.status, 200);
    assert.equal(afterRestartState.json.state.tasks[0]?.title, 'persisted task');
    assert.equal(afterRestartState.json.state.decisions[0]?.id, 'D001');

    const afterRestartEvents = await requestJson<{ events: Array<{ seq: number; type: string }> }>(
      restartedDaemon.baseUrl,
      'GET',
      '/events/replay?from=0',
    );
    assert.equal(afterRestartEvents.response.status, 200);
    assert.ok(afterRestartEvents.json.events.length > beforeRestart.json.events.length);
    assert.ok(
      afterRestartEvents.json.events.some(
        (event) => event.type === 'daemon_start' && event.seq > beforeMaxSeq,
      ),
    );
  });

  it(
    'summarizes open work and next actions from persisted state',
    { timeout: 60_000 },
    async (t) => {
      const projectRoot = createTempProject({
        name: 'hydra-daemon-summary',
        private: true,
        type: 'module',
      });
      let daemon: DaemonInstance | null = null;
      t.after(async () => {
        await stopDaemon(daemon);
        await removeDirBestEffort(projectRoot);
      });

      daemon = await startDaemon(projectRoot);

      const owned = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Owned implementation task',
          owner: 'claude',
          type: 'implementation',
        },
      );
      const handoffTarget = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Follow up on the handoff',
          owner: 'gemini',
          type: 'analysis',
        },
      );
      const blocked = await requestJson<{ task: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/task/add',
        {
          title: 'Blocked downstream task',
          owner: 'codex',
          status: 'blocked',
          blockedBy: [owned.json.task.id],
          type: 'implementation',
        },
      );
      assert.equal(blocked.response.status, 200);

      const decision = await requestJson<{ decision: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/decision',
        {
          title: 'Route next work via handoff',
          owner: 'human',
          impact: 'Keeps ownership clear',
        },
      );
      assert.equal(decision.json.decision.id, 'D001');

      const handoff = await requestJson<{ handoff: { id: string } }>(
        daemon.baseUrl,
        'POST',
        '/handoff',
        {
          from: 'claude',
          to: 'gemini',
          summary: 'Pick up the follow-up task',
          nextStep: 'Review the notes and continue',
          tasks: [handoffTarget.json.task.id],
        },
      );
      assert.equal(handoff.json.handoff.id, 'H001');

      const summary = await requestJson<{
        summary: {
          counts: { tasksOpen: number; blockersOpen: number; decisions: number; handoffs: number };
          openTasks: Array<{ id: string; pendingDependencies: string[] }>;
          recentDecision: { id: string };
          latestHandoff: { id: string };
        };
      }>(daemon.baseUrl, 'GET', '/summary');
      assert.equal(summary.response.status, 200);
      assert.equal(summary.json.summary.counts.tasksOpen, 3);
      assert.equal(summary.json.summary.counts.blockersOpen, 0);
      assert.equal(summary.json.summary.counts.decisions, 1);
      assert.equal(summary.json.summary.counts.handoffs, 1);
      assert.equal(summary.json.summary.recentDecision.id, 'D001');
      assert.equal(summary.json.summary.latestHandoff.id, 'H001');
      assert.deepEqual(
        summary.json.summary.openTasks.find((task) => task.id === blocked.json.task.id)
          ?.pendingDependencies,
        [owned.json.task.id],
      );

      const geminiNext = await requestJson<{
        next: { action: string; relatedTask?: { id: string }; handoff?: { id: string } };
      }>(daemon.baseUrl, 'GET', '/next?agent=gemini');
      assert.equal(geminiNext.response.status, 200);
      assert.equal(geminiNext.json.next.action, 'pickup_handoff');
      assert.equal(geminiNext.json.next.handoff?.id, 'H001');
      assert.equal(geminiNext.json.next.relatedTask?.id, handoffTarget.json.task.id);

      const claudeNext = await requestJson<{ next: { action: string; task?: { id: string } } }>(
        daemon.baseUrl,
        'GET',
        '/next?agent=claude',
      );
      assert.equal(claudeNext.response.status, 200);
      assert.equal(claudeNext.json.next.action, 'claim_owned_task');
      assert.equal(claudeNext.json.next.task?.id, owned.json.task.id);
    },
  );
});
