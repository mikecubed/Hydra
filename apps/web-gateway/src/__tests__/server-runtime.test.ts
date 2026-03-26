import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createStaticAssetResponse,
  isGatewayRoute,
  resolveGatewayServerConfig,
} from '../server-runtime.ts';

describe('resolveGatewayServerConfig', () => {
  it('uses local defaults', () => {
    const config = resolveGatewayServerConfig({});

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 4174);
    assert.equal(config.publicOrigin, 'http://127.0.0.1:4174');
    assert.equal(config.daemonUrl, 'http://127.0.0.1:4173');
    assert.equal(config.operatorId, null);
    assert.equal(config.operatorSecret, null);
  });

  it('applies env overrides and validates seeded operator pairing', () => {
    const config = resolveGatewayServerConfig({
      HYDRA_WEB_GATEWAY_HOST: 'localhost',
      HYDRA_WEB_GATEWAY_PORT: '4300',
      HYDRA_WEB_GATEWAY_ORIGIN: 'http://localhost:4300',
      HYDRA_DAEMON_URL: 'http://localhost:4999',
      HYDRA_WEB_OPERATOR_ID: 'admin',
      HYDRA_WEB_OPERATOR_SECRET: 'password123',
      HYDRA_WEB_OPERATOR_DISPLAY_NAME: 'Admin User',
    });

    assert.equal(config.port, 4300);
    assert.equal(config.publicOrigin, 'http://localhost:4300');
    assert.equal(config.daemonUrl, 'http://localhost:4999');
    assert.equal(config.operatorId, 'admin');
    assert.equal(config.operatorDisplayName, 'Admin User');
  });

  it('rejects partial operator seed configuration', () => {
    assert.throws(
      () =>
        resolveGatewayServerConfig({
          HYDRA_WEB_OPERATOR_ID: 'admin',
        }),
      /must either both be set or both be unset/,
    );
  });

  it('rejects blank seeded operator credentials', () => {
    assert.throws(
      () =>
        resolveGatewayServerConfig({
          HYDRA_WEB_OPERATOR_ID: '   ',
          HYDRA_WEB_OPERATOR_SECRET: 'password123',
        }),
      /HYDRA_WEB_OPERATOR_ID must not be empty when set/,
    );

    assert.throws(
      () =>
        resolveGatewayServerConfig({
          HYDRA_WEB_OPERATOR_ID: 'admin',
          HYDRA_WEB_OPERATOR_SECRET: '   ',
        }),
      /HYDRA_WEB_OPERATOR_SECRET must not be empty when set/,
    );
  });
});

describe('isGatewayRoute', () => {
  it('detects API and websocket paths', () => {
    assert.equal(isGatewayRoute('/auth/login'), true);
    assert.equal(isGatewayRoute('/healthz'), true);
    assert.equal(isGatewayRoute('/conversations/abc'), true);
    assert.equal(isGatewayRoute('/ws'), true);
    assert.equal(isGatewayRoute('/workspace'), false);
  });
});

describe('createStaticAssetResponse', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    const cleanupDir = tempDir;
    tempDir = null;
    if (cleanupDir != null) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it('serves direct assets and SPA fallback from the static dir', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));
    await writeFile(join(tempDir, 'index.html'), '<!doctype html><div id="app"></div>');
    await writeFile(join(tempDir, 'app.js'), 'console.log("hydra");');

    const assetResponse = await createStaticAssetResponse(tempDir, '/app.js');
    assert.ok(assetResponse);
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /hydra/);

    const routeResponse = await createStaticAssetResponse(tempDir, '/workspace');
    assert.ok(routeResponse);
    assert.equal(routeResponse.status, 200);
    assert.match(await routeResponse.text(), /id="app"/);
    assert.match(routeResponse.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(routeResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(routeResponse.headers.get('x-frame-options'), 'DENY');
    assert.equal(routeResponse.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  });

  it('returns null for gateway-owned routes', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));
    await writeFile(join(tempDir, 'index.html'), '<!doctype html>');

    const response = await createStaticAssetResponse(tempDir, '/auth/login');
    assert.equal(response, null);
  });

  it('reserves /healthz for the gateway instead of the SPA fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));
    await writeFile(join(tempDir, 'index.html'), '<!doctype html>');

    const response = await createStaticAssetResponse(tempDir, '/healthz');
    assert.equal(response, null);
  });

  it('reports missing frontend builds clearly', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));

    const response = await createStaticAssetResponse(tempDir, '/workspace');
    assert.ok(response);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /Run `npm --workspace @hydra\/web run build` first/);
  });

  it('does not silently swallow unexpected filesystem read errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));
    await writeFile(join(tempDir, 'index.html'), '<!doctype html><div id="app"></div>');
    await mkdir(join(tempDir, 'workspace'));
    assert.ok(tempDir);
    const staticDir = tempDir;

    await assert.rejects(
      () => createStaticAssetResponse(staticDir, '/workspace'),
      /EISDIR|illegal operation on a directory/i,
    );
  });
});
