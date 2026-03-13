import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimateFlowDuration,
  getAgentMetrics,
  getMetricsSummary,
  getSessionUsage,
  metricsEmitter,
  recordCallComplete,
  recordCallStart,
  resetMetrics,
} from '../lib/hydra-metrics.ts';

function withMockedDateNow<T>(timestamps: number[], callback: () => T): T {
  const originalDateNow = Date.now;
  let index = 0;

  Date.now = () => {
    const timestamp = timestamps[Math.min(index, timestamps.length - 1)];
    index += 1;
    return timestamp;
  };

  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
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
