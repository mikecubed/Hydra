import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { _setTestConfigPath, invalidateConfigCache, loadHydraConfig } from '../../lib/hydra-config.ts';
import { handleMutationRoute, computeConfigRevision } from '../../lib/daemon/mutation-routes.ts';

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
    models: { claude: { default: 'claude-sonnet-4-6' } },
    usage: {},
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
  } catch { /* ignore */ }
}

/** Create a fake IncomingMessage from method + url + optional body */
function fakeReq(
  method: string,
  urlStr: string,
  body?: Record<string, unknown>,
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
    headers: { host: 'localhost:4173', 'content-type': 'application/json' },
  });
  return readable as unknown as http.IncomingMessage;
}

/** Collect response from a ServerResponse-like writable */
function fakeRes(): { res: http.ServerResponse; getResult: () => { status: number; body: unknown } } {
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('mutation-routes', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = tmpConfigDir();
  });

  afterEach(() => {
    cleanupDir(tmpDir);
  });

  describe('GET /config/safe', () => {
    it('returns 200 with routing.mode and a 32-char hex revision', async () => {
      setupTestConfig(tmpDir);
      const req = fakeReq('GET', '/config/safe');
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/safe');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      const b = body as Record<string, unknown>;
      assert.equal(status, 200);
      assert.equal(b['routing'] != null, true);
      const routing = b['routing'] as Record<string, unknown>;
      assert.equal(routing['mode'], 'balanced');
      const revision = b['revision'] as string;
      assert.equal(typeof revision, 'string');
      assert.match(revision, /^[0-9a-f]{32}$/);
    });

    it('returns 503 when config is unavailable', async () => {
      // Point to a nonexistent file so loadHydraConfig throws
      const bogusPath = path.join(tmpDir, 'does-not-exist', 'hydra.config.json');
      _setTestConfigPath(bogusPath);
      // Force a throw by making the dir unreadable — instead we mock loadHydraConfig
      // Actually, loadHydraConfig falls back to defaults on read error. Let's override
      // the config path to a directory (not a file) to trigger a JSON parse error.
      fs.mkdirSync(bogusPath, { recursive: true });
      // Now bogusPath IS a directory — readFileSync will throw EISDIR
      // But loadHydraConfig catches and returns defaults. We need a different approach.
      // Let's force an error by using _setTestConfig with something that SafeConfigView.parse rejects.

      // SafeConfigView rejects if a forbidden key (apiKey, secret, etc.) exists.
      // Pass raw object with a forbidden key to trigger the superRefine rejection.
      invalidateConfigCache();

      // Write a config file with a forbidden key that SafeConfigView.parse will reject
      const cfgPath = path.join(tmpDir, 'hydra.config.json');
      const badConfig = {
        routing: { mode: 'balanced', apiKey: 'LEAKED' },
        models: {},
        usage: {},
      };
      fs.writeFileSync(cfgPath, JSON.stringify(badConfig, null, 2), 'utf8');
      _setTestConfigPath(cfgPath);

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
      assert.ok(resp['snapshot']);
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
      assert.ok((body as Record<string, unknown>)['error']);
    });

    it('returns 400 on missing expectedRevision field', async () => {
      setupTestConfig(tmpDir);

      const req = fakeReq('POST', '/config/routing/mode', {
        mode: 'economy',
      });
      const { res, getResult } = fakeRes();
      const url = new URL('http://localhost:4173/config/routing/mode');

      const handled = await handleMutationRoute(req, res, url);
      assert.equal(handled, true);

      const { status, body } = getResult();
      assert.equal(status, 400);
      assert.ok((body as Record<string, unknown>)['error']);
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
