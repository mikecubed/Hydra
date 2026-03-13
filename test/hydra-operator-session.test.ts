/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { executeDaemonResume } from '../lib/hydra-operator-session.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRl() {
  return { prompt: () => {} } as any;
}

/** Build a minimal session-status response. */
function sessionStatus(overrides: Record<string, any> = {}) {
  return {
    activeSession: { status: 'active' },
    staleTasks: [],
    pendingHandoffs: [],
    inProgressTasks: [],
    agentSuggestions: {},
    ...overrides,
  };
}

/** Creates a spy that records calls and returns canned responses. */
function makeRequestSpy(responses: Record<string, any>) {
  return mock.fn((method: string, _baseUrl: string, path: string, _body?: any) => {
    const key = `${method} ${path}`;
    if (key in responses) return Promise.resolve(responses[key]);
    if (method === 'POST') return Promise.resolve({});
    return Promise.reject(new Error(`Unexpected request: ${key}`));
  });
}

describe('executeDaemonResume', () => {
  it('completes without error for a clean (no-op) session', async () => {
    const requestSpy = makeRequestSpy({
      'GET /session/status': sessionStatus(),
    });
    await assert.doesNotReject(
      executeDaemonResume('http://localhost:4173', ['claude', 'gemini'], makeRl(), requestSpy),
    );
    assert.equal(requestSpy.mock.calls.length, 1, 'only one GET should be made');
  });

  it('calls /session/unpause when session is paused', async () => {
    const requestSpy = makeRequestSpy({
      'GET /session/status': sessionStatus({ activeSession: { status: 'paused' } }),
      'POST /session/unpause': {},
    });
    await executeDaemonResume('http://localhost:4173', ['claude'], makeRl(), requestSpy);
    const calls = requestSpy.mock.calls.map(
      (c: any) => `${String(c.arguments[0])} ${String(c.arguments[2])}`,
    );
    assert.ok(calls.includes('POST /session/unpause'), 'should call /session/unpause');
  });

  it('resets stale tasks to "todo"', async () => {
    const requestSpy = makeRequestSpy({
      'GET /session/status': sessionStatus({
        staleTasks: [{ id: 'task-1', owner: 'claude', updatedAt: new Date().toISOString() }],
      }),
      'POST /task/update': {},
    });
    await executeDaemonResume('http://localhost:4173', ['claude'], makeRl(), requestSpy);
    const updateCall = requestSpy.mock.calls.find((c: any) => c.arguments[2] === '/task/update');
    assert.ok(updateCall, 'should call /task/update');
    assert.equal((updateCall as any).arguments[3].taskId, 'task-1');
    assert.equal((updateCall as any).arguments[3].status, 'todo');
  });

  it('acks pending handoffs', async () => {
    const requestSpy = makeRequestSpy({
      'GET /session/status': sessionStatus({
        pendingHandoffs: [{ id: 'h1', to: 'gemini' }],
      }),
      'POST /handoff/ack': {},
    });
    await executeDaemonResume('http://localhost:4173', ['gemini'], makeRl(), requestSpy);
    const ackCall = requestSpy.mock.calls.find((c: any) => c.arguments[2] === '/handoff/ack');
    assert.ok(ackCall, 'should call /handoff/ack');
    assert.equal((ackCall as any).arguments[3].handoffId, 'h1');
  });

  it('does not throw when /session/status request fails', async () => {
    const requestSpy = mock.fn(() => Promise.reject(new Error('Connection refused')));
    await assert.doesNotReject(
      executeDaemonResume('http://localhost:4173', ['claude'], makeRl(), requestSpy),
    );
  });

  it('does not throw when /session/unpause fails', async () => {
    const requestSpy = mock.fn((_method: string, _baseUrl: string, path: string) => {
      if (path === '/session/status')
        return Promise.resolve(sessionStatus({ activeSession: { status: 'paused' } }));
      if (path === '/session/unpause') return Promise.reject(new Error('unpause failed'));
      return Promise.resolve({});
    });
    await assert.doesNotReject(
      executeDaemonResume('http://localhost:4173', ['claude'], makeRl(), requestSpy),
    );
  });
});
