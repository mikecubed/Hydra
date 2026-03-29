import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createStaticAssetResponse,
  describeStaticDirSource,
  isGatewayRoute,
  missingAssetsMessage,
  resolveGatewayServerConfig,
  resolveStaticDirWithSource,
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

  it('includes staticDirSource in resolved config', () => {
    const config = resolveGatewayServerConfig({});
    assert.ok(
      ['source-checkout', 'packaged', 'env-override'].includes(config.staticDirSource),
      `Expected a valid staticDirSource, got "${config.staticDirSource}"`,
    );
  });

  it('reports env-override when HYDRA_WEB_STATIC_DIR is set', () => {
    const config = resolveGatewayServerConfig({
      HYDRA_WEB_STATIC_DIR: '/custom/static/path',
    });
    assert.equal(config.staticDirSource, 'env-override');
    assert.equal(config.staticDir, resolve('/custom/static/path'));
  });
});

describe('resolveStaticDirWithSource', () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    const cleanupDir = tempDir;
    tempDir = null;
    if (cleanupDir != null) {
      await rm(cleanupDir, { recursive: true, force: true });
    }
  });

  it('returns env-override when explicit path is provided', () => {
    const result = resolveStaticDirWithSource('/some/explicit/path');
    assert.equal(result.staticDirSource, 'env-override');
    assert.equal(result.staticDir, resolve('/some/explicit/path'));
  });

  it('detects packaged mode when web/ subdirectory exists under moduleDir', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-packaged-'));
    await mkdir(join(tempDir, 'web'));

    const result = resolveStaticDirWithSource(undefined, tempDir);
    assert.equal(result.staticDirSource, 'packaged');
    assert.equal(result.staticDir, join(tempDir, 'web'));
  });

  it('falls back to source-checkout when no packaged dir exists', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-source-'));

    const result = resolveStaticDirWithSource(undefined, tempDir);
    assert.equal(result.staticDirSource, 'source-checkout');
    assert.match(result.staticDir, /web[/\\]dist$/);
  });

  it('ignores empty env override string', () => {
    const result = resolveStaticDirWithSource('');
    assert.notEqual(result.staticDirSource, 'env-override');
  });
});

describe('describeStaticDirSource', () => {
  it('returns human-readable labels for all source types', () => {
    assert.equal(describeStaticDirSource('source-checkout'), 'source checkout');
    assert.equal(describeStaticDirSource('packaged'), 'packaged');
    assert.equal(describeStaticDirSource('env-override'), 'env override');
  });
});

describe('missingAssetsMessage', () => {
  it('provides build command for source-checkout mode', () => {
    const msg = missingAssetsMessage('source-checkout');
    assert.match(msg, /npm --workspace @hydra\/web run build/);
  });

  it('references packaged asset path for packaged mode', () => {
    const msg = missingAssetsMessage('packaged');
    assert.match(msg, /dist\/web-runtime\/web/);
    assert.match(msg, /build-pack/);
  });

  it('references env var for env-override mode', () => {
    const msg = missingAssetsMessage('env-override');
    assert.match(msg, /HYDRA_WEB_STATIC_DIR/);
  });

  it('defaults to source-checkout guidance when source is undefined', () => {
    const msg = missingAssetsMessage(undefined);
    assert.match(msg, /npm --workspace @hydra\/web run build/);
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

  it('tailors 503 message for packaged mode', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));

    const response = await createStaticAssetResponse(tempDir, '/workspace', {
      staticDirSource: 'packaged',
    });
    assert.ok(response);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /dist\/web-runtime\/web/);
    assert.match(text, /build-pack/);
  });

  it('tailors 503 message for env-override mode', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hydra-web-static-'));

    const response = await createStaticAssetResponse(tempDir, '/workspace', {
      staticDirSource: 'env-override',
    });
    assert.ok(response);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.match(text, /HYDRA_WEB_STATIC_DIR/);
  });
});
