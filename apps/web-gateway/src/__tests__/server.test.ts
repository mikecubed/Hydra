import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatStartupLines, type GatewayServerConfig } from '../server-runtime.ts';

function buildTestConfig(
  overrides: Partial<GatewayServerConfig> = {},
): GatewayServerConfig {
  return {
    host: '127.0.0.1',
    port: 4174,
    publicOrigin: 'http://127.0.0.1:4174',
    daemonUrl: 'http://127.0.0.1:4173',
    staticDir: '/fake/static',
    staticDirSource: 'source-checkout',
    stateDir: '/fake/state',
    operatorsPath: '/fake/state/operators.json',
    sessionsPath: '/fake/state/sessions.json',
    auditPath: '/fake/state/audit.log',
    operatorId: null,
    operatorDisplayName: null,
    operatorSecret: null,
    ...overrides,
  };
}

describe('formatStartupLines', () => {
  it('includes source-checkout label in static assets line', () => {
    const config = buildTestConfig({ staticDirSource: 'source-checkout' });
    const lines = formatStartupLines(config);
    const staticLine = lines.find((l) => l.includes('Static assets'));
    assert.ok(staticLine, 'Expected a "Static assets" line');
    assert.match(staticLine, /source checkout/);
    assert.match(staticLine, /\/fake\/static/);
  });

  it('includes packaged label in static assets line', () => {
    const config = buildTestConfig({
      staticDirSource: 'packaged',
      staticDir: '/opt/hydra/dist/web-runtime/web',
    });
    const lines = formatStartupLines(config);
    const staticLine = lines.find((l) => l.includes('Static assets'));
    assert.ok(staticLine);
    assert.match(staticLine, /packaged/);
  });

  it('includes env-override label in static assets line', () => {
    const config = buildTestConfig({
      staticDirSource: 'env-override',
      staticDir: '/custom/dir',
    });
    const lines = formatStartupLines(config);
    const staticLine = lines.find((l) => l.includes('Static assets'));
    assert.ok(staticLine);
    assert.match(staticLine, /env override/);
  });

  it('includes listening URL and daemon URL', () => {
    const config = buildTestConfig({
      publicOrigin: 'http://localhost:9999',
      daemonUrl: 'http://localhost:8888',
    });
    const lines = formatStartupLines(config);
    assert.ok(lines.some((l) => l.includes('http://localhost:9999')));
    assert.ok(lines.some((l) => l.includes('http://localhost:8888')));
  });

  it('shows seeded operator when configured', () => {
    const config = buildTestConfig({ operatorId: 'admin' });
    const lines = formatStartupLines(config);
    assert.ok(lines.some((l) => l.includes('Seeded operator: admin')));
  });

  it('shows no-seed notice when operator is not configured', () => {
    const config = buildTestConfig({ operatorId: null });
    const lines = formatStartupLines(config);
    assert.ok(lines.some((l) => l.includes('No operator seed configured')));
  });
});
