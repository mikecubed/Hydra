import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadGatewayConfig, DEFAULT_GATEWAY_CONFIG } from '../config.ts';

describe('GatewayConfig', () => {
  it('returns defaults without overrides', () => {
    const config = loadGatewayConfig();
    assert.equal(config.sessionLifetimeMs, DEFAULT_GATEWAY_CONFIG.sessionLifetimeMs);
    assert.equal(config.bindAddress, '127.0.0.1');
  });

  it('applies overrides', () => {
    const config = loadGatewayConfig({ idleTimeoutMs: 60_000 });
    assert.equal(config.idleTimeoutMs, 60_000);
  });

  it('rejects negative sessionLifetimeMs', () => {
    assert.throws(() => loadGatewayConfig({ sessionLifetimeMs: -1 }));
  });

  it('rejects zero maxConcurrentSessions', () => {
    assert.throws(() => loadGatewayConfig({ maxConcurrentSessions: 0 }));
  });

  it('rejects negative idleTimeoutMs', () => {
    assert.throws(() => loadGatewayConfig({ idleTimeoutMs: -1 }));
  });
});
