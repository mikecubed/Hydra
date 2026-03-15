import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DaemonHeartbeat } from '../daemon-heartbeat.ts';
import { SessionService } from '../session-service.ts';
import { SessionStore } from '../session-store.ts';
import { FakeClock } from '../../shared/clock.ts';

describe('DaemonHeartbeat', () => {
  let store: SessionStore;
  let clock: FakeClock;
  let service: SessionService;
  let healthResult: boolean;

  beforeEach(() => {
    store = new SessionStore(null);
    clock = new FakeClock(Date.now());
    service = new SessionService(store, clock);
    healthResult = true;
  });

  function createHeartbeat() {
    return new DaemonHeartbeat(service, store, async () => healthResult);
  }

  it('healthy daemon keeps sessions active', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const hb = createHeartbeat();
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'active');
  });

  it('unhealthy transitions to daemon-unreachable', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    healthResult = false;
    const hb = createHeartbeat();
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');
  });

  it('recovery restores active', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const hb = createHeartbeat();

    healthResult = false;
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    healthResult = true;
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'active');
  });

  it('expiring-soon session transitions to daemon-unreachable on outage', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const hb = createHeartbeat();

    // Advance into warning window so validate flips state to expiring-soon
    clock.advance(service.config.sessionLifetimeMs - service.config.warningThresholdMs + 1);
    await service.validate(session.id);
    assert.equal(store.get(session.id)?.state, 'expiring-soon');

    // Daemon goes down — expiring-soon must reach daemon-unreachable
    healthResult = false;
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');
  });

  it('expiring-soon session recovers via daemon-up', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const hb = createHeartbeat();

    // Move to expiring-soon
    clock.advance(service.config.sessionLifetimeMs - service.config.warningThresholdMs + 1);
    await service.validate(session.id);
    assert.equal(store.get(session.id)?.state, 'expiring-soon');

    // Daemon outage
    healthResult = false;
    await hb.tick();
    assert.equal(store.get(session.id)?.state, 'daemon-unreachable');

    // Daemon recovers — session should be restored (validate + daemon-up → active)
    healthResult = true;
    await hb.tick();
    const recovered = store.get(session.id);
    assert.ok(recovered);
    assert.notEqual(recovered.state, 'daemon-unreachable');
    // Should be active (daemon-up restores to active; next validate would re-enter expiring-soon)
    assert.equal(recovered.state, 'active');
  });

  it('expired-during-outage stays terminal', async () => {
    const session = await service.create('op-1', '127.0.0.1');
    const hb = createHeartbeat();

    healthResult = false;
    await hb.tick();

    // Simulate expiry during outage by setting expiresAt to past
    store.update(session.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });

    healthResult = true;
    await hb.tick();
    const s = store.get(session.id);
    // Session should be expired (validate transitions daemon-unreachable → expired)
    assert.equal(s?.state, 'expired');
  });
});
