import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, beforeEach, describe, test } from 'node:test';

import {
  _resetRegistry,
  bestAgentFor,
  getAgent,
  initAgentRegistry,
  listAgents,
  unregisterAgent,
} from '../lib/hydra-agents.ts';
import { loadHydraConfig, _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import { createMockExecuteAgent, loadAgentFixture } from './helpers/mock-agent.ts';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const fsModule = require('node:fs') as typeof import('node:fs');
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const childProcess = require('node:child_process') as typeof import('node:child_process');

const ROUTING_MODES = ['economy', 'balanced', 'performance'] as const;

let mockExecuteAgent: Awaited<ReturnType<typeof createMockExecuteAgent>>;

before(async () => {
  const [claudeFixtures, geminiFixtures, codexFixtures] = await Promise.all([
    loadAgentFixture('claude'),
    loadAgentFixture('gemini'),
    loadAgentFixture('codex'),
  ]);

  mockExecuteAgent = createMockExecuteAgent({
    claude: claudeFixtures,
    gemini: geminiFixtures,
    codex: codexFixtures,
  });
});

beforeEach(() => {
  _resetRegistry();
  initAgentRegistry();
});

after(() => {
  _resetRegistry();
  initAgentRegistry();
});

describe('mock agent isolation', () => {
  test('mockExecuteAgent stays fully in-process after fixtures are loaded', async () => {
    const activity: { method: string; args: unknown[] }[] = [];
    const originalReadFile = fsModule.promises.readFile;
    const originalReadFileSync = fsModule.readFileSync;
    const originalSpawn = childProcess.spawn;
    const originalSpawnSync = childProcess.spawnSync;

    fsModule.promises.readFile = (async (...args: unknown[]) => {
      activity.push({ method: 'readFile', args });
      throw new Error('Unexpected fs.promises.readFile during mock execution');
    }) as typeof fsModule.promises.readFile;
    fsModule.readFileSync = ((...args: unknown[]) => {
      activity.push({ method: 'readFileSync', args });
      throw new Error('Unexpected fs.readFileSync during mock execution');
    }) as typeof fsModule.readFileSync;
    childProcess.spawn = ((...args: unknown[]) => {
      activity.push({ method: 'spawn', args });
      throw new Error('Unexpected child_process.spawn during mock execution');
    }) as typeof childProcess.spawn;
    childProcess.spawnSync = ((...args: unknown[]) => {
      activity.push({ method: 'spawnSync', args });
      throw new Error('Unexpected child_process.spawnSync during mock execution');
    }) as typeof childProcess.spawnSync;

    try {
      const fallbackResult = await mockExecuteAgent(
        'claude',
        'unmatched prompt for default fixture',
        {},
      );
      const matchedResult = await mockExecuteAgent('codex', 'implement the feature', {
        cwd: process.cwd(),
      });

      assert.equal(fallbackResult.ok, true);
      assert.equal(matchedResult.ok, true);
      assert.match(fallbackResult.output, /default summary/i);
      assert.match(matchedResult.output, /implementation result/i);
    } finally {
      // eslint-disable-next-line require-atomic-updates -- intentional mock restore
      fsModule.promises.readFile = originalReadFile;
      // eslint-disable-next-line require-atomic-updates -- intentional mock restore
      fsModule.readFileSync = originalReadFileSync;
      // eslint-disable-next-line require-atomic-updates -- intentional mock restore
      childProcess.spawn = originalSpawn;
      // eslint-disable-next-line require-atomic-updates -- intentional mock restore
      childProcess.spawnSync = originalSpawnSync;
    }

    assert.deepEqual(activity, [], 'mock execution must not perform file I/O or spawn processes');
  });
});

describe('local agent routing contract', () => {
  test('initAgentRegistry exposes local alongside the cloud physical agents', () => {
    const physicalAgentNames = new Set(listAgents({ type: 'physical' }).map((agent) => agent.name));

    for (const agentName of ['claude', 'gemini', 'codex', 'local']) {
      assert.ok(physicalAgentNames.has(agentName), `physical agents should include ${agentName}`);
    }

    const local = getAgent('local');
    assert.ok(local);
    assert.equal(local.cli, null);
    assert.equal(local.councilRole, null);
  });

  test('implementation routing follows the documented mode policy without budget pressure', () => {
    const original = loadHydraConfig();
    _setTestConfig({ ...original, local: { ...original.local, enabled: true } });
    try {
      assert.equal(bestAgentFor('implementation', { mode: 'economy' }), 'local');
      assert.equal(bestAgentFor('implementation', { mode: 'balanced' }), 'codex');
      assert.notEqual(bestAgentFor('implementation', { mode: 'performance' }), 'local');
    } finally {
      invalidateConfigCache();
    }
  });

  test('budget gating promotes local implementation work without ever routing research to local', () => {
    const budgetState = {
      daily: { percentUsed: 95 },
      weekly: { percentUsed: 95 },
    };

    const original = loadHydraConfig();
    _setTestConfig({ ...original, local: { ...original.local, enabled: true } });
    try {
      assert.equal(bestAgentFor('implementation', { mode: 'balanced', budgetState }), 'local');

      for (const mode of ROUTING_MODES) {
        assert.notEqual(
          bestAgentFor('research', { mode, budgetState }),
          'local',
          `research must not route to local in ${mode} mode under budget pressure`,
        );
      }
    } finally {
      invalidateConfigCache();
    }
  });

  test('local remains a built-in physical agent and cannot be unregistered', () => {
    assert.throws(
      () => unregisterAgent('local'),
      /Cannot unregister built-in physical agent "local"/,
    );
  });
});
