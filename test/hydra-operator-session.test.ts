import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Interface as ReadlineInterface } from 'node:readline';
import { executeDaemonResume } from '../lib/hydra-operator-session.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRl(): ReadlineInterface {
  return { prompt: () => {} } as unknown as ReadlineInterface;
}

/** Build a minimal session-status response. */
function sessionStatus(overrides: Record<string, unknown> = {}) {
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
function makeRequestSpy(responses: Record<string, unknown>) {
  return mock.fn((method: string, _baseUrl: string, path: string) => {
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
    const calls = requestSpy.mock.calls.map((c) => `${c.arguments[0]} ${c.arguments[2]}`);
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
    const updateCall = requestSpy.mock.calls.find((c) => c.arguments[2] === '/task/update');
    assert.ok(updateCall, 'should call /task/update');
    const updateBody = updateCall.arguments[3] as Record<string, unknown>;
    assert.equal(updateBody.taskId, 'task-1');
    assert.equal(updateBody.status, 'todo');
  });

  it('acks pending handoffs and launches matching agents', async () => {
    const requestSpy = makeRequestSpy({
      'GET /session/status': sessionStatus({
        pendingHandoffs: [{ id: 'h1', to: 'gemini' }],
      }),
      'POST /handoff/ack': {},
    });
    const startWorkersSpy = mock.fn();
    await executeDaemonResume(
      'http://localhost:4173',
      ['gemini'],
      makeRl(),
      requestSpy,
      startWorkersSpy,
    );
    const ackCall = requestSpy.mock.calls.find((c) => c.arguments[2] === '/handoff/ack');
    assert.ok(ackCall, 'should call /handoff/ack');
    const ackBody = ackCall.arguments[3] as Record<string, unknown>;
    assert.equal(ackBody.handoffId, 'h1');
    assert.equal(startWorkersSpy.mock.calls.length, 1, 'should launch workers');
    assert.deepEqual(startWorkersSpy.mock.calls[0].arguments[0], ['gemini']);
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
