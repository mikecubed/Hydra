import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  _setTestConfigPath,
  invalidateConfigCache,
  loadHydraConfig,
} from '../../lib/hydra-config.ts';
import {
  handleMutationRoute,
  computeConfigRevision,
  _clearAuditStoreForTest,
  _resetAuditStoreCacheForTest,
  _injectAuditRecordsForTest,
  _clearWorkflowLaunchesForTest,
  _injectWorkflowLaunchForTest,
  _setWorkflowTaskStatusResolverForTest,
  _setWorkflowStateAccessorsForTest,
  _hasForbiddenKeyForTest,
} from '../../lib/daemon/mutation-routes.ts';
import type { MutationAuditRecord } from '@hydra/web-contracts';
import { createDefaultState } from '../../lib/daemon/state.ts';
import type { HydraStateShape } from '../../lib/types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function tmpConfigDir(): string {
  const dir = path.join(
    process.cwd(),
    'test',
    'daemon',
    `.tmp-mutation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function setupTestConfig(dir: string, initial: Record<string, unknown> = {}): string {
  const cfgPath = path.join(dir, 'hydra.config.json');
  const seed = {
    routing: { mode: 'balanced' },
    models: {
      claude: {
        default: 'claude-sonnet-4-6',
        fast: 'claude-haiku',
        cheap: 'claude-haiku',
        active: 'default',
      },
      gemini: {
        default: 'gemini-pro',
        fast: 'gemini-flash',
        cheap: 'gemini-flash',
        active: 'default',
      },
      codex: { default: 'gpt-5.4', fast: 'gpt-4.1', cheap: 'gpt-4.1', active: 'default' },
    },
    usage: {
      dailyTokenBudget: { 'claude-opus-4-6': 5000000, 'gemini-pro': 3000000 },
      weeklyTokenBudget: { 'claude-opus-4-6': 25000000, 'gemini-pro': 15000000 },
    },
    ...initial,
  };
  fs.writeFileSync(cfgPath, JSON.stringify(seed, null, 2), 'utf8');
  _setTestConfigPath(cfgPath);
  return cfgPath;
}

function cleanupDir(dir: string): void {
  _setTestConfigPath(null);
  invalidateConfigCache();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Create a fake IncomingMessage from method + url + optional body */
function fakeReq(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
): http.IncomingMessage {
  const bodyStr = body ? JSON.stringify(body) : '';
  const readable = new Readable({
    read() {
      if (bodyStr) this.push(Buffer.from(bodyStr));
      this.push(null);
    },
  });
  Object.assign(readable, {
    method,
    url: urlStr,
    headers: { host: 'localhost:4173', 'content-type': 'application/json', ...headers },
  });
  return readable as unknown as http.IncomingMessage;
}

/** Collect response from a ServerResponse-like writable */
function fakeRes(): {
  res: http.ServerResponse;
  getResult: () => { status: number; body: unknown };
} {
  const chunks: Buffer[] = [];
  let statusCode = 200;
  const res = {
    writeHead(code: number, _headers?: Record<string, string>) {
      statusCode = code;
      return res;
    },
    end(data?: string | Buffer) {
      if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    getResult() {
      const raw = Buffer.concat(chunks).toString('utf8');
      return { status: statusCode, body: raw ? JSON.parse(raw) : null };
    },
  };
}

function makeAuditRecord(overrides: Partial<MutationAuditRecord> = {}): MutationAuditRecord {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: 'config.routing.mode.changed',
    operatorId: null,
    sessionId: null,
    targetField: 'config.routing.mode',
    beforeValue: 'balanced',
    afterValue: 'economy',
    outcome: 'success',
    rejectionReason: null,
    sourceIp: '',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('mutation-routes', () => {
  let tmpDir: string;
  let testState: HydraStateShape;

  beforeEach(() => {
    tmpDir = tmpConfigDir();
    testState = createDefaultState();
    _clearAuditStoreForTest();
    _clearWorkflowLaunchesForTest();
    _setWorkflowTaskStatusResolverForTest(null);
    _setWorkflowStateAccessorsForTest({
      read: () => testState,
      write: (nextState) => {
        testState = nextState;
      },
    });
  });

  afterEach(() => {
    _setWorkflowTaskStatusResolverForTest(null);
    _setWorkflowStateAccessorsForTest(null);
    cleanupDir(tmpDir);
  });

  describe('GET /config/safe', () => {
    it('returns 200 with config.routing.mode and a 32-char hex revision', async () => {
      setupTestConfig(tmpDir);
      const req = fakeReq('GET', '/config/safe');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/safe');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      const b = body as Record<string, unknown>;
      assert.equal(status, 200);
      const config = b['config'] as Record<string, unknown>;
      assert.ok(config != null, 'config field must be present');
      const routing = config['routing'] as Record<string, unknown>;
      assert.equal(routing['mode'], 'balanced');
      const revision = b['revision'] as string;
      assert.equal(typeof revision, 'string');
      assert.match(revision, /^[0-9a-f]{32}$/);
    });

    it('returns 503 when config file is missing (EISDIR)', async () => {
      const bogusPath = path.join(tmpDir, 'does-not-exist', 'hydra.config.json');
      fs.mkdirSync(bogusPath, { recursive: true });
      _setTestConfigPath(bogusPath);
      invalidateConfigCache();

      const req = fakeReq('GET', '/config/safe');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/safe');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 503);
      assert.equal((body as Record<string, unknown>)['error'], 'daemon-unavailable');
    });
  });

  describe('POST /config/routing/mode', () => {
    it('returns 200 with ConfigMutationResponse on valid request', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/routing/mode', {
        mode: 'economy',
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const resp = body as Record<string, unknown>;
      assert.equal(typeof resp['appliedRevision'], 'string');
      assert.equal(typeof resp['timestamp'], 'string');
      const snapshot = resp['snapshot'] as Record<string, unknown>;
      const routing = snapshot['routing'] as Record<string, unknown>;
      assert.equal(routing['mode'], 'economy');
    });

    it('returns 409 on stale expectedRevision', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('POST', '/config/routing/mode', {
        mode: 'economy',
        expectedRevision: 'deadbeefdeadbeefdeadbeefdeadbeef',
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 409);
      assert.equal((body as Record<string, unknown>)['error'], 'stale-revision');
    });

    it('returns 400 on invalid mode "turbo"', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('POST', '/config/routing/mode', {
        mode: 'turbo',
        expectedRevision: 'aaaabbbbccccddddaaaabbbbccccdddd',
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 400);
      assert.equal((body as Record<string, unknown>)['error'], 'Invalid request body');
    });

    it('returns 400 on missing expectedRevision field', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('POST', '/config/routing/mode', { mode: 'economy' });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 400);
      assert.equal((body as Record<string, unknown>)['error'], 'Invalid request body');
    });

    it('returns 503 and preserves the file when config JSON is malformed', async () => {
      const cfgPath = setupTestConfig(tmpDir);
      fs.writeFileSync(cfgPath, '{"routing":', 'utf8');
      invalidateConfigCache();

      const req = fakeReq('POST', '/config/routing/mode', {
        mode: 'economy',
        expectedRevision: 'any-revision',
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 503);
      assert.equal((body as Record<string, unknown>)['error'], 'daemon-unavailable');
      assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{"routing":');
    });

    it('concurrency: two simultaneous requests yield exactly one 200 and one 409', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const makeRequest = () => {
        const req = fakeReq('POST', '/config/routing/mode', {
          mode: 'performance',
          expectedRevision: revision,
        });
        const { res, getResult } = fakeRes();
        const url = new URL('http://localhost:4173/config/routing/mode');
        return handleMutationRoute(req, res, url).then(() => getResult());
      };

      const [r1, r2] = await Promise.all([makeRequest(), makeRequest()]);

      const statuses = [r1.status, r2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409]);
    });
  });

  describe('POST /config/models/:agent/active', () => {
    it('returns 200 with updated tier in snapshot', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/models/claude/active', {
        tier: 'fast',
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/models/claude/active');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const resp = body as Record<string, unknown>;
      assert.equal(typeof resp['appliedRevision'], 'string');
      const snapshot = resp['snapshot'] as Record<string, unknown>;
      const models = snapshot['models'] as Record<string, Record<string, unknown>>;
      assert.equal(models['claude']?.['active'], 'fast');
    });

    it('returns 400 for unknown agent', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/models/unknown-agent/active', {
        tier: 'fast',
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/models/unknown-agent/active');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });

    it('returns 409 on stale revision', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('POST', '/config/models/gemini/active', {
        tier: 'cheap',
        expectedRevision: 'stalerevisionstalerevisionstaler',
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/models/gemini/active');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 409);
      assert.equal((body as Record<string, unknown>)['error'], 'stale-revision');
    });

    it('returns 400 for invalid tier value', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/models/claude/active', {
        tier: 'turbo',
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/models/claude/active');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });
  });

  describe('POST /config/usage/budget', () => {
    it('returns 200 on valid budget mutation', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/usage/budget', {
        modelId: 'claude-opus-4-6',
        dailyLimit: 8000000,
        weeklyLimit: 40000000,
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/usage/budget');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const resp = body as Record<string, unknown>;
      assert.equal(typeof resp['appliedRevision'], 'string');
      const snapshot = resp['snapshot'] as Record<string, unknown>;
      const usage = snapshot['usage'] as Record<string, Record<string, unknown>>;
      assert.equal(usage['dailyTokenBudget']?.['claude-opus-4-6'], 8_000_000);
      assert.equal(usage['weeklyTokenBudget']?.['claude-opus-4-6'], 40_000_000);
    });

    it('returns 400 when both dailyLimit and weeklyLimit are null', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/usage/budget', {
        modelId: 'claude-opus-4-6',
        dailyLimit: null,
        weeklyLimit: null,
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/usage/budget');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });

    it('returns 400 when dailyLimit is non-positive', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/usage/budget', {
        modelId: 'claude-opus-4-6',
        dailyLimit: -100,
        weeklyLimit: 40000000,
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/usage/budget');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });

    it('returns 400 for unknown modelId', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/config/usage/budget', {
        modelId: 'unknown-model-xyz',
        dailyLimit: 1000000,
        weeklyLimit: null,
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/usage/budget');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });
  });

  describe('POST /workflows/launch', () => {
    it('returns 202 with destructive:false for "tasks" workflow', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 202);
      const resp = body as Record<string, unknown>;
      assert.equal(typeof resp['taskId'], 'string');
      assert.equal(resp['workflow'], 'tasks');
      assert.equal(resp['destructive'], false);
    });

    it('materializes a daemon task entry for launched workflows', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq(
        'POST',
        '/workflows/launch',
        {
          workflow: 'tasks',
          label: 'Backfill queue projections',
          idempotencyKey: crypto.randomUUID(),
          expectedRevision: revision,
        },
        {
          'x-hydra-operator-id': 'operator-21',
          'x-hydra-session-id': 'session-33',
          'x-hydra-source-ip': '10.2.3.4',
        },
      );
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 202);
      const responseTaskId = (body as Record<string, unknown>)['taskId'];
      assert.equal(responseTaskId, 'T001');
      assert.equal(testState.tasks.length, 1);
      assert.deepStrictEqual(testState.tasks[0], {
        id: 'T001',
        title: 'Workflow: tasks — Backfill queue projections',
        owner: 'codex',
        status: 'in_progress',
        type: 'workflow',
        files: [],
        notes: 'Launched via controlled mutation endpoint.',
        blockedBy: [],
        updatedAt: testState.tasks[0]?.updatedAt,
      });

      const auditReq = fakeReq('GET', '/audit');
      const { res: auditRes, getResult: getAuditResult } = fakeRes();
      const auditHandled = await handleMutationRoute(
        auditReq,
        auditRes,
        new URL('http://localhost:4173/audit'),
      );
      assert.equal(auditHandled, true);
      const auditRecords = (getAuditResult().body as Record<string, unknown>)[
        'records'
      ] as MutationAuditRecord[];
      assert.equal(auditRecords[0]?.operatorId, 'operator-21');
      assert.equal(auditRecords[0]?.sessionId, 'session-33');
      assert.equal(auditRecords[0]?.sourceIp, '10.2.3.4');
    });

    it('returns 202 with destructive:true for "evolve" workflow', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'evolve',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 202);
      const resp = body as Record<string, unknown>;
      assert.equal(resp['destructive'], true);
    });

    it('returns 409 when same workflow is already running', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      // Inject an already-running 'tasks' workflow
      _injectWorkflowLaunchForTest({
        taskId: 'existing-task-001',
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        launchedAt: new Date().toISOString(),
        status: 'running',
      });

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 409);
      assert.equal((body as Record<string, unknown>)['error'], 'workflow-conflict');
    });

    it('allows re-launch when conflicting entry is older than 5 minutes', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      // Inject a stale 'tasks' entry (6 minutes ago — beyond the 5-min window)
      const staleTime = new Date(Date.now() - 6 * 60_000).toISOString();
      _injectWorkflowLaunchForTest({
        taskId: 'stale-task-001',
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        launchedAt: staleTime,
        status: 'pending',
      });

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 202);
      assert.equal(typeof (body as Record<string, unknown>)['taskId'], 'string');
    });

    it('allows re-launch when the tracked task is already done', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      _injectWorkflowLaunchForTest({
        taskId: 'completed-task-001',
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        launchedAt: new Date().toISOString(),
        status: 'pending',
      });
      _setWorkflowTaskStatusResolverForTest((taskId) =>
        taskId === 'completed-task-001' ? 'done' : null,
      );

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'tasks',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 202);
      assert.equal(typeof (body as Record<string, unknown>)['taskId'], 'string');
    });

    it('returns 400 for unknown workflow name', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const req = fakeReq('POST', '/workflows/launch', {
        workflow: 'unknown-workflow',
        idempotencyKey: crypto.randomUUID(),
        expectedRevision: revision,
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/workflows/launch');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status } = getResult();
      assert.equal(status, 400);
    });

    it('deduplicates idempotent launches within 60 seconds', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);
      const idempotencyKey = crypto.randomUUID();

      // First launch
      const req1 = fakeReq('POST', '/workflows/launch', {
        workflow: 'nightly',
        idempotencyKey,
        expectedRevision: revision,
      });
      const { res: res1, getResult: getResult1 } = fakeRes();
      await handleMutationRoute(req1, res1, new URL('http://localhost:4173/workflows/launch'));
      const { body: body1 } = getResult1();
      const firstTaskId = (body1 as Record<string, unknown>)['taskId'];

      // Second launch with same idempotencyKey — should return same taskId
      const req2 = fakeReq('POST', '/workflows/launch', {
        workflow: 'nightly',
        idempotencyKey,
        expectedRevision: revision,
      });
      const { res: res2, getResult: getResult2 } = fakeRes();
      await handleMutationRoute(req2, res2, new URL('http://localhost:4173/workflows/launch'));
      const { status: status2, body: body2 } = getResult2();

      assert.equal(status2, 202);
      assert.equal((body2 as Record<string, unknown>)['taskId'], firstTaskId);
    });
  });

  describe('GET /audit', () => {
    it('returns 200 with empty records when store is empty', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('GET', '/audit');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/audit');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const resp = body as Record<string, unknown>;
      assert.deepEqual(resp['records'], []);
      assert.equal(resp['nextCursor'], null);
    });

    it('returns first page with nextCursor when more records exist', async () => {
      setupTestConfig(tmpDir);

      // Inject 5 records with distinct timestamps
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        _injectAuditRecordsForTest([
          makeAuditRecord({ timestamp: new Date(now + i * 1000).toISOString() }),
        ]);
      }

      const req = fakeReq('GET', '/audit?limit=2');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/audit?limit=2');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const resp = body as Record<string, unknown>;
      const records = resp['records'] as unknown[];
      assert.equal(records.length, 2);
      assert.ok(
        resp['nextCursor'] !== null,
        'nextCursor should be non-null when more records exist',
      );
      assert.equal(resp['totalCount'], 5);
    });

    it('reloads persisted audit records after the in-memory cache is reset', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);

      const mutateReq = fakeReq('POST', '/config/routing/mode', {
        mode: 'economy',
        expectedRevision: revision,
      });
      const { res: mutateRes } = fakeRes();
      await handleMutationRoute(
        mutateReq,
        mutateRes,
        new URL('http://localhost:4173/config/routing/mode'),
      );

      _resetAuditStoreCacheForTest();

      const req = fakeReq('GET', '/audit');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/audit');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 200);
      const records = (body as Record<string, unknown>)['records'] as MutationAuditRecord[];
      assert.equal(records.length, 1);
      assert.equal(records[0]?.eventType, 'config.routing.mode.changed');
    });

    it('logs audit persistence failures without failing the mutation response', async () => {
      setupTestConfig(tmpDir);
      invalidateConfigCache();
      const config = loadHydraConfig();
      const revision = computeConfigRevision(config);
      let logged = '';
      const appendFileMock = mock.method(fs, 'appendFileSync', () => {
        throw new Error('disk-full');
      });
      const stderrWriteMock = mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
        logged += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      });

      try {
        const req = fakeReq(
          'POST',
          '/config/routing/mode',
          { mode: 'economy', expectedRevision: revision },
          { 'x-hydra-operator-id': 'operator-1' },
        );
        const { res, getResult } = fakeRes();
        const handled = await handleMutationRoute(
          req,
          res,
          new URL('http://localhost:4173/config/routing/mode'),
        );
        assert.equal(handled, true);
        assert.equal(getResult().status, 200);
        assert.match(logged, /failed to persist mutation audit record/i);
      } finally {
        appendFileMock.mock.restore();
        stderrWriteMock.mock.restore();
      }
    });

    it('returns next page of records with no overlap', async () => {
      setupTestConfig(tmpDir);

      const now = Date.now();
      const allRecords: MutationAuditRecord[] = [];
      for (let i = 0; i < 5; i++) {
        const r = makeAuditRecord({ timestamp: new Date(now + i * 1000).toISOString() });
        allRecords.push(r);
      }
      _injectAuditRecordsForTest(allRecords);

      // Get page 1
      const { res: res1, getResult: get1 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', '/audit?limit=2'),
        res1,
        new URL('http://localhost:4173/audit?limit=2'),
      );
      const page1 = get1().body as Record<string, unknown>;
      const cursor = page1['nextCursor'] as string;
      const page1Ids = (page1['records'] as MutationAuditRecord[]).map((r) => r.id);

      // Get page 2 using cursor
      const { res: res2, getResult: get2 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', `/audit?limit=2&cursor=${cursor}`),
        res2,
        new URL(`http://localhost:4173/audit?limit=2&cursor=${cursor}`),
      );
      const page2 = get2().body as Record<string, unknown>;
      const page2Ids = (page2['records'] as MutationAuditRecord[]).map((r) => r.id);

      assert.equal(page2Ids.length, 2);
      // No overlap between pages
      for (const id of page2Ids) {
        assert.ok(!page1Ids.includes(id), `Record ${id} appeared in both pages`);
      }
    });

    it('returns last partial page with null nextCursor', async () => {
      setupTestConfig(tmpDir);

      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        _injectAuditRecordsForTest([
          makeAuditRecord({ timestamp: new Date(now + i * 1000).toISOString() }),
        ]);
      }

      // Page 1
      const { res: res1, getResult: get1 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', '/audit?limit=2'),
        res1,
        new URL('http://localhost:4173/audit?limit=2'),
      );
      const cursor1 = (get1().body as Record<string, unknown>)['nextCursor'] as string;

      // Page 2
      const { res: res2, getResult: get2 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', `/audit?limit=2&cursor=${cursor1}`),
        res2,
        new URL(`http://localhost:4173/audit?limit=2&cursor=${cursor1}`),
      );
      const cursor2 = (get2().body as Record<string, unknown>)['nextCursor'] as string;

      // Page 3 — last page with only 1 record
      const { res: res3, getResult: get3 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', `/audit?limit=2&cursor=${cursor2}`),
        res3,
        new URL(`http://localhost:4173/audit?limit=2&cursor=${cursor2}`),
      );
      const page3 = get3().body as Record<string, unknown>;
      const page3Records = page3['records'] as MutationAuditRecord[];

      assert.equal(page3Records.length, 1);
      assert.equal(page3['nextCursor'], null);
    });

    it('does not skip records when a page boundary splits identical timestamps', async () => {
      setupTestConfig(tmpDir);

      const timestamp = '2026-03-28T06:00:00.000Z';
      _injectAuditRecordsForTest([
        makeAuditRecord({ id: 'audit-c', timestamp }),
        makeAuditRecord({ id: 'audit-b', timestamp }),
        makeAuditRecord({ id: 'audit-a', timestamp }),
      ]);

      const { res: res1, getResult: get1 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', '/audit?limit=2'),
        res1,
        new URL('http://localhost:4173/audit?limit=2'),
      );
      const page1 = get1().body as Record<string, unknown>;
      const page1Ids = (page1['records'] as MutationAuditRecord[]).map((record) => record.id);
      const cursor = page1['nextCursor'] as string;

      const { res: res2, getResult: get2 } = fakeRes();
      await handleMutationRoute(
        fakeReq('GET', `/audit?limit=2&cursor=${cursor}`),
        res2,
        new URL(`http://localhost:4173/audit?limit=2&cursor=${cursor}`),
      );
      const page2 = get2().body as Record<string, unknown>;
      const page2Ids = (page2['records'] as MutationAuditRecord[]).map((record) => record.id);

      assert.deepEqual([...page1Ids, ...page2Ids].sort(), ['audit-a', 'audit-b', 'audit-c']);
      assert.equal(page2Ids.length, 1);
      assert.ok(!page1Ids.includes(page2Ids[0] ?? ''));
    });
  });

  describe('unmatched routes', () => {
    it('returns false for unknown paths', async () => {
      setupTestConfig(tmpDir);
      const req = fakeReq('GET', '/not-a-mutation-route');
      const { res } = fakeRes();
      const url = new URL('http://localhost:4173/not-a-mutation-route');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, false);
    });
  });
});

describe('hasForbiddenKey', () => {
  it('returns null for plain safe objects', () => {
    assert.equal(_hasForbiddenKeyForTest({ routing: { mode: 'economy' } }), null);
  });

  it('detects a forbidden key at the top level', () => {
    assert.notEqual(_hasForbiddenKeyForTest({ apiKey: 'secret' }), null);
  });

  it('detects a forbidden key nested in an object', () => {
    assert.notEqual(_hasForbiddenKeyForTest({ models: { claude: { password: 'x' } } }), null);
  });

  it('detects a forbidden key nested inside an array element', () => {
    const result = _hasForbiddenKeyForTest({ items: [{ apiKey: 'leaked' }] });
    assert.notEqual(result, null);
  });

  it('detects a forbidden key in a deeply nested array', () => {
    const result = _hasForbiddenKeyForTest({ a: [{ b: [{ secret: 'x' }] }] });
    assert.notEqual(result, null);
  });

  it('returns null for arrays containing only safe objects', () => {
    assert.equal(
      _hasForbiddenKeyForTest({ items: [{ tier: 'default' }, { mode: 'balanced' }] }),
      null,
    );
  });

  it('returns the key for top-level credential fields', () => {
    const result = _hasForbiddenKeyForTest({ credential: 'gh_abc123' });
    assert.notEqual(result, null);
    assert.ok((result as string).includes('credential'));
  });

  it('returns the key for nested credential fields', () => {
    const result = _hasForbiddenKeyForTest({ agent: { apiCredential: 'secret' } });
    assert.notEqual(result, null);
  });

  it('returns null for null and undefined inputs', () => {
    assert.equal(_hasForbiddenKeyForTest(null), null);
    // eslint-disable-next-line unicorn/no-useless-undefined
    assert.equal(_hasForbiddenKeyForTest(undefined), null);
  });

  it('returns null for primitives', () => {
    assert.equal(_hasForbiddenKeyForTest('plain-string'), null);
    assert.equal(_hasForbiddenKeyForTest(42), null);
  });
});
