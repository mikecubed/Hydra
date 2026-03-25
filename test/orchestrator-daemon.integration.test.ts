import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON_SCRIPT = path.join(REPO_ROOT, 'lib', 'orchestrator-daemon.ts');

interface DaemonInstance {
  child: ChildProcess;
  baseUrl: string;
}

interface RequestJsonResponse {
  response: { status: number; ok: boolean };
  json: Record<string, unknown>;
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createTempProject(packageJson: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-daemon-it-'));
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
      const address = server.address() as AddressInfo;
      const port = address.port;
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

async function requestJson(
  baseUrl: string,
  method: string,
  route: string,
  body: Record<string, unknown> | null = null,
  timeoutMs: number = 4_000,
): Promise<RequestJsonResponse> {
  const target = new URL(route, baseUrl);
  const payload = body ? JSON.stringify(body) : '';

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(text);
          } catch {
            // json stays as fallback {}
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
    req.on('error', reject);

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before becoming healthy (exit=${child.exitCode})`);
    }
    try {
      const { response } = await requestJson(baseUrl, 'GET', '/health');
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying until timeout.
    }
    await sleep(125);
  }
  throw new Error('Timed out waiting for daemon health check');
}

async function waitForExit(child: ChildProcess, timeoutMs: number = 4_000): Promise<void> {
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
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [DAEMON_SCRIPT, 'start', 'host=127.0.0.1', `port=${port}`, `project=${projectRoot}`],
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
  if (!instance?.child) {
    return;
  }
  try {
    await requestJson(instance.baseUrl, 'POST', '/shutdown', {}, 1_500);
  } catch {
    // Fallback to force stop below.
  }
  await waitForExit(instance.child, 1_500);
  if (instance.child.exitCode === null) {
    instance.child.kill();
    await waitForExit(instance.child, 2_000);
  }
}

async function removeDirBestEffort(dirPath: string, attempts: number = 8): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? '';
      if (!['EBUSY', 'ENOTEMPTY', 'EPERM'].includes(code) || i === attempts - 1) {
        return;
      }
      await sleep(150);
    }
  }
}

test(
  '/task/update returns skipped verification when auto-detection finds no command',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-no-verify',
      private: true,
      type: 'module',
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', {
      title: 'integration no-verify task',
    });
    assert.equal(add.response.status, 200);
    const taskId = (add.json?.['task'] as Record<string, unknown>)?.['id'];
    assert.ok(taskId);

    const update = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
      taskId,
      status: 'done',
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.json['verifying'], false);
    assert.equal((update.json['verification'] as Record<string, unknown>)?.['enabled'], false);
    assert.equal((update.json['verification'] as Record<string, unknown>)?.['command'], null);
    assert.match(
      ((update.json['verification'] as Record<string, unknown>)?.['reason'] as string) ?? '',
      /No project-specific verification command/i,
    );
  },
);

test(
  '/verify and /task/update report enabled verification when verify script is present',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-verify',
      private: true,
      type: 'module',
      scripts: {
        verify: 'node -e "process.exit(0)"',
      },
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', {
      title: 'integration verify task',
    });
    assert.equal(add.response.status, 200);
    const taskId = (add.json?.['task'] as Record<string, unknown>)?.['id'];
    assert.ok(taskId);

    const verify = await requestJson(daemon.baseUrl, 'POST', '/verify', { taskId });
    assert.equal(verify.response.status, 200);
    assert.equal((verify.json['verification'] as Record<string, unknown>)?.['enabled'], true);
    assert.equal(
      (verify.json['verification'] as Record<string, unknown>)?.['command'],
      'npm run verify',
    );
    assert.match((verify.json['message'] as string) ?? '', /Verification started/i);

    const update = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
      taskId,
      status: 'done',
    });
    assert.equal(update.response.status, 200);
    assert.equal(update.json['verifying'], true);
    assert.equal((update.json['verification'] as Record<string, unknown>)?.['enabled'], true);
    assert.equal(
      (update.json['verification'] as Record<string, unknown>)?.['command'],
      'npm run verify',
    );
  },
);

test(
  'GET /self returns a structured snapshot with project root and models',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-self',
      private: true,
      type: 'module',
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    const self = await requestJson(daemon.baseUrl, 'GET', '/self');
    assert.equal(self.response.status, 200);
    assert.equal(self.json?.['ok'], true);
    assert.ok(self.json?.['self']);
    assert.equal(
      (self.json['self'] as Record<string, unknown> & { project?: { root?: string } }).project
        ?.root,
      projectRoot,
    );
    assert.ok(
      (self.json['self'] as Record<string, unknown>)['models'],
      'Should include model summary',
    );
  },
);

// ── Phase 1: Event-Sourced Mutation Log ─────────────────────────────────────

test('events have monotonic seq numbers and category fields', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-event-seq',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Create a few mutations to generate events
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'seq test task 1' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'seq test task 2' });
  await requestJson(daemon.baseUrl, 'POST', '/decision', {
    title: 'seq test decision',
    owner: 'human',
    rationale: 'test',
  });

  // Fetch all events
  const events = await requestJson(daemon.baseUrl, 'GET', '/events?limit=500');
  assert.equal(events.response.status, 200);
  const list = events.json['events'] as Array<Record<string, unknown>>;
  assert.ok(list.length >= 3, `Expected at least 3 events, got ${list.length}`);

  // Check seq numbers are present and monotonically increasing
  let lastSeq = -1;
  for (const evt of list) {
    if (typeof evt['seq'] !== 'number') continue; // skip legacy events without seq
    assert.ok(evt['seq'] > lastSeq, `Expected seq ${evt['seq']} > ${lastSeq}`);
    lastSeq = evt['seq'];
  }

  // Check category fields
  const taskEvents = list.filter((e) => e['category'] === 'task');
  const decisionEvents = list.filter((e) => e['category'] === 'decision');
  assert.ok(taskEvents.length >= 2, 'Should have at least 2 task-category events');
  assert.ok(decisionEvents.length >= 1, 'Should have at least 1 decision-category event');
});

test('/events/replay returns events from a given seq', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-replay',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 1' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 2' });
  await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'replay task 3' });

  // Get all events to find a midpoint seq
  const all = await requestJson(daemon.baseUrl, 'GET', '/events/replay?from=0');
  assert.equal(all.response.status, 200);
  const allEvents = all.json['events'] as Array<Record<string, unknown>>;
  assert.ok(allEvents.length >= 3);

  // Replay from a midpoint
  const midSeq = allEvents[Math.floor(allEvents.length / 2)]['seq'] as number;
  const partial = await requestJson(daemon.baseUrl, 'GET', `/events/replay?from=${midSeq}`);
  assert.equal(partial.response.status, 200);
  const partialEvents = partial.json['events'] as Array<Record<string, unknown>>;
  assert.ok(partialEvents.length > 0);
  assert.ok(partialEvents.length <= allEvents.length);
  assert.ok((partialEvents[0]['seq'] as number) >= midSeq);

  // Filter by category
  const taskOnly = await requestJson(daemon.baseUrl, 'GET', '/events/replay?from=0&category=task');
  assert.equal(taskOnly.response.status, 200);
  for (const evt of taskOnly.json['events'] as Array<Record<string, unknown>>) {
    assert.equal(evt['category'], 'task');
  }
});

// ── Phase 1: Atomic Task Claiming ───────────────────────────────────────────

test(
  '/task/claim returns claimToken and /task/update validates it',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-claim-token',
      private: true,
      type: 'module',
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    // Add a task then claim it
    const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', { title: 'claimable task' });
    const taskId = (add.json['task'] as Record<string, unknown>)['id'];

    const claim = await requestJson(daemon.baseUrl, 'POST', '/task/claim', {
      taskId,
      agent: 'claude',
    });
    assert.equal(claim.response.status, 200);
    assert.ok(
      (claim.json['task'] as Record<string, unknown>)['claimToken'],
      'Claim should return a claimToken',
    );
    const token = (claim.json['task'] as Record<string, unknown>)['claimToken'];

    // Update with correct token should succeed
    const goodUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
      taskId,
      notes: 'progress update',
      claimToken: token,
    });
    assert.equal(goodUpdate.response.status, 200);

    // Update with wrong token should fail
    const badUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
      taskId,
      notes: 'rogue update',
      claimToken: '00000000-0000-0000-0000-000000000000',
    });
    assert.equal(badUpdate.response.status, 400);
    assert.match((badUpdate.json['error'] as string) ?? '', /claim token mismatch/i);

    // Force override should work
    const forceUpdate = await requestJson(daemon.baseUrl, 'POST', '/task/update', {
      taskId,
      notes: 'forced update',
      claimToken: '00000000-0000-0000-0000-000000000000',
      force: true,
    });
    assert.equal(forceUpdate.response.status, 200);
  },
);

test('/task/claim by title creates task with claimToken', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-claim-new',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const claim = await requestJson(daemon.baseUrl, 'POST', '/task/claim', {
    title: 'brand new claimed task',
    agent: 'gemini',
  });
  assert.equal(claim.response.status, 200);
  assert.ok(
    (claim.json['task'] as Record<string, unknown>)['claimToken'],
    'New task via claim should have a claimToken',
  );
  assert.equal((claim.json['task'] as Record<string, unknown>)['owner'], 'gemini');
  assert.equal((claim.json['task'] as Record<string, unknown>)['status'], 'in_progress');
});

// ── Phase 2: Checkpoint/Resume ──────────────────────────────────────────────

test(
  'POST /task/checkpoint creates and GET retrieves checkpoints',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-checkpoint',
      private: true,
      type: 'module',
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    const add = await requestJson(daemon.baseUrl, 'POST', '/task/add', {
      title: 'checkpoint test task',
      owner: 'claude',
    });
    const taskId = (add.json['task'] as Record<string, unknown>)['id'];

    // Create first checkpoint
    const cp1 = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', {
      taskId,
      name: 'proposal_complete',
      context: 'Initial proposal drafted with 3 subtasks',
      agent: 'claude',
    });
    assert.equal(cp1.response.status, 200);
    assert.ok(cp1.json['ok']);
    assert.equal((cp1.json['checkpoint'] as Record<string, unknown>)['name'], 'proposal_complete');
    assert.equal((cp1.json['checkpoint'] as Record<string, unknown>)['agent'], 'claude');
    assert.ok((cp1.json['checkpoint'] as Record<string, unknown>)['savedAt']);

    // Create second checkpoint
    const cp2 = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', {
      taskId,
      name: 'critique_done',
      context: 'Gemini reviewed and found 2 issues',
      agent: 'gemini',
    });
    assert.equal(cp2.response.status, 200);
    assert.equal((cp2.json['checkpoint'] as Record<string, unknown>)['name'], 'critique_done');

    // Retrieve checkpoints
    const list = await requestJson(daemon.baseUrl, 'GET', `/task/${taskId}/checkpoints`);
    assert.equal(list.response.status, 200);
    assert.equal(list.json['taskId'], taskId);
    const checkpoints = list.json['checkpoints'] as Array<Record<string, unknown>>;
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[0]['name'], 'proposal_complete');
    assert.equal(checkpoints[1]['name'], 'critique_done');
  },
);

test('POST /task/checkpoint rejects missing taskId or name', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-checkpoint-validate',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const noTaskId = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', { name: 'test' });
  assert.equal(noTaskId.response.status, 400);

  const noName = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', { taskId: 'T001' });
  assert.equal(noName.response.status, 400);

  const badTask = await requestJson(daemon.baseUrl, 'POST', '/task/checkpoint', {
    taskId: 'TXXX',
    name: 'test',
  });
  assert.equal(badTask.response.status, 400);
});

test('GET /task/:id/checkpoints returns 404 for missing task', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-checkpoint-404',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/task/T999/checkpoints');
  assert.equal(result.response.status, 404);
});

// ── Phase 3: Git Worktree / MCP ─────────────────────────────────────────────

test('GET /worktrees returns worktree listing', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-worktrees',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const result = await requestJson(daemon.baseUrl, 'GET', '/worktrees');
  assert.equal(result.response.status, 200);
  assert.ok(result.json['ok']);
  assert.equal(result.json['enabled'], false); // disabled by default
  assert.ok(Array.isArray(result.json['worktrees']));
  assert.equal((result.json['worktrees'] as unknown[]).length, 0);
});

// ── Phase 4: Session Fork/Spawn ─────────────────────────────────────────────

test('POST /session/fork creates a fork of the active session', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-session-fork',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  // Start a session first
  const session = await requestJson(daemon.baseUrl, 'POST', '/session/start', {
    focus: 'test fork session',
    owner: 'human',
  });
  assert.equal(session.response.status, 200);
  const parentId = (session.json['session'] as Record<string, unknown>)['id'];

  // Fork it
  const fork = await requestJson(daemon.baseUrl, 'POST', '/session/fork', {
    reason: 'exploring alternative approach',
  });
  assert.equal(fork.response.status, 200);
  assert.ok((fork.json['session'] as Record<string, unknown>)['id']);
  assert.equal((fork.json['session'] as Record<string, unknown>)['type'], 'fork');
  assert.equal((fork.json['session'] as Record<string, unknown>)['parentId'], parentId);
  assert.ok((fork.json['session'] as Record<string, unknown>)['contextSnapshot']);

  // List sessions
  const sessions = await requestJson(daemon.baseUrl, 'GET', '/sessions');
  assert.equal(sessions.response.status, 200);
  assert.ok(sessions.json['activeSession']);
  assert.ok(
    ((sessions.json['activeSession'] as Record<string, unknown>)['children'] as unknown[]).length >=
      1,
  );
  assert.equal((sessions.json['childSessions'] as unknown[]).length, 1);
  assert.equal(
    (sessions.json['childSessions'] as Array<Record<string, unknown>>)[0]['type'],
    'fork',
  );
});

test(
  'POST /session/spawn creates a child session with fresh focus',
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = createTempProject({
      name: 'hydra-it-session-spawn',
      private: true,
      type: 'module',
    });
    let daemon: DaemonInstance | null = null;
    t.after(async () => {
      await stopDaemon(daemon);
      await removeDirBestEffort(projectRoot);
    });
    daemon = await startDaemon(projectRoot);

    // Start a parent session
    await requestJson(daemon.baseUrl, 'POST', '/session/start', {
      focus: 'parent session',
      owner: 'human',
    });

    // Spawn a child
    const spawnResult = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {
      focus: 'investigate auth module',
      owner: 'claude',
    });
    assert.equal(spawnResult.response.status, 200);
    assert.ok((spawnResult.json['session'] as Record<string, unknown>)['id']);
    assert.equal((spawnResult.json['session'] as Record<string, unknown>)['type'], 'spawn');
    assert.equal(
      (spawnResult.json['session'] as Record<string, unknown>)['focus'],
      'investigate auth module',
    );
    assert.equal((spawnResult.json['session'] as Record<string, unknown>)['owner'], 'claude');

    // Spawn another
    const spawn2 = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {
      focus: 'optimize database queries',
      owner: 'gemini',
    });
    assert.equal(spawn2.response.status, 200);

    // Verify session tree
    const sessions = await requestJson(daemon.baseUrl, 'GET', '/sessions');
    assert.equal((sessions.json['childSessions'] as unknown[]).length, 2);
    assert.ok(
      ((sessions.json['activeSession'] as Record<string, unknown>)['children'] as unknown[])
        .length >= 2,
    );
  },
);

test('POST /session/fork rejects when no active session', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-fork-no-session',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const fork = await requestJson(daemon.baseUrl, 'POST', '/session/fork', {});
  assert.equal(fork.response.status, 400);
  assert.match((fork.json['error'] as string) ?? '', /no active session/i);
});

test('POST /session/spawn rejects missing focus', { timeout: 60_000 }, async (t) => {
  const projectRoot = createTempProject({
    name: 'hydra-it-spawn-no-focus',
    private: true,
    type: 'module',
  });
  let daemon: DaemonInstance | null = null;
  t.after(async () => {
    await stopDaemon(daemon);
    await removeDirBestEffort(projectRoot);
  });
  daemon = await startDaemon(projectRoot);

  const spawnResult = await requestJson(daemon.baseUrl, 'POST', '/session/spawn', {});
  assert.equal(spawnResult.response.status, 400);
});
