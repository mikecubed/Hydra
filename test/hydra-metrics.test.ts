import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import {
  estimateFlowDuration,
  getAgentMetrics,
  getMetricsSummary,
  getSessionUsage,
  metricsEmitter,
  metricsRecorder,
  recordCallComplete,
  recordCallStart,
  recordExecution,
  resetMetrics,
} from '../lib/hydra-metrics.ts';
import type { IMetricsRecorder } from '../lib/types.ts';

function withMockedDateNow<T>(timestamps: number[], callback: () => T): T {
  let index = 0;
  const spy = mock.method(Date, 'now', () => {
    const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
    index += 1;
    return timestamp;
  });
  try {
    return callback();
  } finally {
    spy.mock.restore();
  }
}

test('metrics(ts): zero-duration calls keep duration metrics at zero and default model to unknown', () => {
  resetMetrics();

  withMockedDateNow([50_000, 50_000], () => {
    const handle = recordCallStart('claude');
    recordCallComplete(handle, { stdout: '', stderr: '' });
  });

  const agent = getAgentMetrics('claude');

  assert.ok(agent);
  assert.equal(agent.totalDurationMs, 0);
  assert.equal(agent.avgDurationMs, 0);
  assert.equal(agent.lastModel, 'unknown');
  assert.equal(agent.history[0]?.model, 'unknown');
  assert.equal(agent.history[0]?.estimatedTokens, 0);
});

test('metrics(ts): negative token counts are accumulated as provided', () => {
  resetMetrics();

  const handle = recordCallStart('claude', 'claude-opus-4-6');
  recordCallComplete(handle, {
    stdout: 'negative token usage case',
    stderr: '',
    tokenUsage: {
      inputTokens: -10,
      outputTokens: -5,
      cacheCreationTokens: -2,
      cacheReadTokens: -1,
      totalTokens: -15,
    },
    costUsd: -0.25,
  });

  const agent = getAgentMetrics('claude');
  const sessionUsage = getSessionUsage();

  assert.ok(agent);
  assert.equal(agent.sessionTokens.inputTokens, -10);
  assert.equal(agent.sessionTokens.outputTokens, -5);
  assert.equal(agent.sessionTokens.cacheCreationTokens, -2);
  assert.equal(agent.sessionTokens.cacheReadTokens, -1);
  assert.equal(agent.sessionTokens.totalTokens, -15);
  assert.equal(agent.sessionTokens.costUsd, -0.25);
  assert.equal(sessionUsage.totalTokens, -15);
  assert.equal(agent.history[0]?.realTokens?.totalTokens, -15);
  assert.equal(agent.history[0]?.costUsd, -0.25);
});

test('metrics(ts): metricsEmitter emits one call:complete event per completed call', () => {
  resetMetrics();

  const emittedEvents: Array<{ agent: string; ok: boolean }> = [];
  const handler = (event: { agent: string; ok: boolean }) => {
    emittedEvents.push(event);
  };

  metricsEmitter.on('call:complete', handler);

  try {
    const handle = recordCallStart('gemini', 'gemini-2.5-pro');
    recordCallComplete(handle, { stdout: 'ok', stderr: '' });
  } finally {
    metricsEmitter.off('call:complete', handler);
  }

  assert.deepEqual(emittedEvents, [{ agent: 'gemini', ok: true }]);
});

test('metrics(ts): getMetricsSummary preserves its public shape contract', () => {
  resetMetrics();

  const handle = recordCallStart('codex');
  recordCallComplete(handle, { stdout: 'summary payload', stderr: '' });

  const summary = getMetricsSummary();
  const agentSummary = summary.agents['codex'] as Record<string, unknown>;
  const latency = agentSummary['latency'] as Record<string, unknown>;
  const sessionTokens = agentSummary['sessionTokens'] as Record<string, unknown>;

  assert.deepEqual(Object.keys(summary).sort(), [
    'agents',
    'sessionUsage',
    'startedAt',
    'totalCalls',
    'totalDurationMs',
    'totalTokens',
    'uptimeSec',
  ]);
  assert.equal(summary.totalCalls, 1);
  assert.ok(typeof summary.startedAt === 'string');
  assert.ok(typeof summary.uptimeSec === 'number');
  assert.ok(agentSummary);
  assert.deepEqual(Object.keys(agentSummary).sort(), [
    'avgDurationMs',
    'callsFailed',
    'callsSuccess',
    'callsToday',
    'estimatedTokensToday',
    'lastCallAt',
    'lastModel',
    'latency',
    'sessionTokens',
    'successRate',
  ]);
  assert.deepEqual(Object.keys(latency).sort(), ['avg', 'p50', 'p95', 'p99']);
  assert.equal(agentSummary['lastModel'], 'unknown');
  assert.equal(agentSummary['successRate'], 100);
  assert.deepEqual(Object.keys(sessionTokens).sort(), [
    'cacheCreationTokens',
    'cacheReadTokens',
    'callCount',
    'costUsd',
    'inputTokens',
    'outputTokens',
    'totalTokens',
  ]);
});

test('metrics(ts): estimateFlowDuration returns zero for an empty flow', () => {
  resetMetrics();

  assert.equal(estimateFlowDuration([]), 0);
});

test('metrics(ts): estimateFlowDuration uses a recorded single-agent average when positive', () => {
  resetMetrics();

  withMockedDateNow([1_000, 1_000, 1_250], () => {
    const handle = recordCallStart('gemini', 'gemini-2.5-pro');
    recordCallComplete(handle, { stdout: 'done', stderr: '' });
  });

  assert.equal(estimateFlowDuration([{ agent: 'gemini' }]), 250);
});

test('metrics(ts): estimateFlowDuration adds chained agent durations and rounds', () => {
  resetMetrics();

  withMockedDateNow([10_000, 10_000, 10_400, 20_000, 20_000, 20_900], () => {
    const claudeHandle = recordCallStart('claude', 'claude-opus-4-6');
    recordCallComplete(claudeHandle, { stdout: 'claude', stderr: '' });

    const codexHandle = recordCallStart('codex', 'gpt-5.3-codex');
    recordCallComplete(codexHandle, { stdout: 'codex', stderr: '' });
  });

  assert.equal(estimateFlowDuration([{ agent: 'claude' }, { agent: 'codex' }], 3), (400 + 900) * 3);
});

test('metrics(ts): concurrent recordCallStart calls produce distinct handles and isolated lifecycles', async () => {
  resetMetrics();

  const [firstHandle, secondHandle] = await Promise.all([
    Promise.resolve().then(() => recordCallStart('claude', 'model-a')),
    Promise.resolve().then(() => recordCallStart('claude', 'model-b')),
  ]);

  assert.notEqual(firstHandle, secondHandle);

  await Promise.all([
    Promise.resolve().then(() => {
      recordCallComplete(secondHandle, { stdout: 'beta', stderr: '' });
    }),
    Promise.resolve().then(() => {
      recordCallComplete(firstHandle, { stdout: 'alpha', stderr: '' });
    }),
  ]);

  const agent = getAgentMetrics('claude');
  const recordedModels = agent?.history.map((entry) => entry.model).sort();

  assert.ok(agent);
  assert.equal(agent.callsTotal, 2);
  assert.equal(agent.callsSuccess, 2);
  assert.deepEqual(recordedModels, ['model-a', 'model-b']);
});

// ── recordExecution tests ───────────────────────────────────────────────────

test('recordExecution: success path records complete and returns result', async () => {
  resetMetrics();
  const result = await recordExecution('claude', 'opus', () =>
    Promise.resolve({ output: 'done', stdout: 'done', stderr: '' }),
  );

  assert.deepEqual(result, { output: 'done', stdout: 'done', stderr: '' });
  const agent = getAgentMetrics('claude');
  assert.ok(agent);
  assert.equal(agent.callsTotal, 1);
  assert.equal(agent.callsSuccess, 1);
  assert.equal(agent.callsFailed, 0);
  assert.equal(agent.lastModel, 'opus');
});

test('recordExecution: error path records error and re-throws', async () => {
  resetMetrics();
  const err = new Error('agent crashed');

  await assert.rejects(
    () => recordExecution('gemini', 'flash', () => Promise.reject(err)),
    (thrown: unknown) => thrown === err,
  );

  const agent = getAgentMetrics('gemini');
  assert.ok(agent);
  assert.equal(agent.callsTotal, 1);
  assert.equal(agent.callsFailed, 1);
  assert.equal(agent.callsSuccess, 0);
  assert.equal(agent.history[0]?.error, 'agent crashed');
});

test('recordExecution: model defaults to unknown when undefined', async () => {
  resetMetrics();
  await recordExecution('codex', undefined, () => Promise.resolve({ output: 'x' }));

  const agent = getAgentMetrics('codex');
  assert.ok(agent);
  assert.equal(agent.lastModel, 'unknown');
});

test('recordExecution: emits call:start and call:complete events', async () => {
  resetMetrics();
  const events: string[] = [];
  const onStart = () => events.push('start');
  const onComplete = () => events.push('complete');
  metricsEmitter.on('call:start', onStart);
  metricsEmitter.on('call:complete', onComplete);

  await recordExecution('claude', 'sonnet', () => Promise.resolve({ output: 'ok' }));

  metricsEmitter.off('call:start', onStart);
  metricsEmitter.off('call:complete', onComplete);
  assert.deepEqual(events, ['start', 'complete']);
});

test('recordExecution: emits call:start and call:error events on failure', async () => {
  resetMetrics();
  const events: string[] = [];
  const onStart = () => events.push('start');
  const onError = () => events.push('error');
  metricsEmitter.on('call:start', onStart);
  metricsEmitter.on('call:error', onError);

  await recordExecution('claude', 'sonnet', () => Promise.reject(new Error('boom'))).catch(
    () => {},
  );

  metricsEmitter.off('call:start', onStart);
  metricsEmitter.off('call:error', onError);
  assert.deepEqual(events, ['start', 'error']);
});

test('recordExecution: ok:false result is recorded as failure not success', async () => {
  resetMetrics();
  const result = await recordExecution('claude', 'opus', () =>
    Promise.resolve({ ok: false, output: '', stderr: 'agent failed' }),
  );

  assert.deepEqual(result, { ok: false, output: '', stderr: 'agent failed' });
  const agent = getAgentMetrics('claude');
  assert.ok(agent);
  assert.equal(agent.callsTotal, 1);
  assert.equal(agent.callsFailed, 1);
  assert.equal(agent.callsSuccess, 0);
  assert.ok(
    agent.history[0]?.error?.includes('agent failed'),
    'error message should include stderr detail',
  );
});

test('recordExecution: ok:false result emits call:error not call:complete', async () => {
  resetMetrics();
  const events: string[] = [];
  const onComplete = () => events.push('complete');
  const onError = () => events.push('error');
  metricsEmitter.on('call:complete', onComplete);
  metricsEmitter.on('call:error', onError);

  await recordExecution('gemini', 'flash', () => Promise.resolve({ ok: false, output: '' }));

  metricsEmitter.off('call:complete', onComplete);
  metricsEmitter.off('call:error', onError);
  assert.deepEqual(events, ['error']);
});

test('metricsRecorder satisfies IMetricsRecorder including recordExecution', () => {
  const recorder: IMetricsRecorder = metricsRecorder;
  assert.equal(typeof recorder.recordCallStart, 'function');
  assert.equal(typeof recorder.recordCallComplete, 'function');
  assert.equal(typeof recorder.recordCallError, 'function');
  assert.equal(typeof recorder.recordExecution, 'function');
});
