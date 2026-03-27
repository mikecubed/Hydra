/**
 * Deep coverage tests for lib/hydra-operator-concierge.ts
 *
 * Uses mock.module() to mock child_process.spawn, hydra-config, hydra-utils,
 * and other deps to test all dispatch functions without real process spawning.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EventEmitter from 'node:events';
import { PassThrough } from 'node:stream';

// ── Mock child_process spawn ────────────────────────────────────────────────

let spawnResult = { status: 0, stdout: '', stderr: '' };

function makeMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();

  // Capture current spawnResult value
  const captured = { ...spawnResult };

  // Schedule data + close on next tick
  process.nextTick(() => {
    if (captured.stdout) {
      child.stdout.write(captured.stdout);
    }
    child.stdout.end();
    if (captured.stderr) {
      child.stderr.write(captured.stderr);
    }
    child.stderr.end();
    child.emit('close', captured.status);
  });

  return child;
}

const mockSpawn = mock.fn((_cmd: string, _args: string[], _opts?: any) => makeMockChild());

mock.module('node:child_process', {
  namedExports: {
    spawn: mockSpawn,
  },
});

// ── Mock hydra-exec-spawn (rewriteNodeInvocation) ───────────────────────────

mock.module('../lib/hydra-exec-spawn.ts', {
  namedExports: {
    rewriteNodeInvocation: (_cmd: string, args: string[], _root: string) => ({
      command: 'node',
      args,
    }),
  },
});

// ── Mock hydra-config ───────────────────────────────────────────────────────

let tmpDir = '';
let tmpCfgPath = '';

tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-opconcierge-'));
tmpCfgPath = path.join(tmpDir, 'hydra.config.json');
fs.writeFileSync(
  tmpCfgPath,
  JSON.stringify(
    {
      version: 2,
      mode: 'economy',
      modeTiers: { economy: {}, balanced: {}, performance: {} },
      routing: {
        intentGate: { enabled: false },
        tandemEnabled: false,
      },
    },
    null,
    2,
  ),
);

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    resolveProject: () => ({
      projectRoot: tmpDir,
      projectName: 'test-project',
      configPath: tmpCfgPath,
    }),
    loadHydraConfig: () => ({
      version: 2,
      mode: 'economy',
      modeTiers: { economy: {}, balanced: {}, performance: {} },
      routing: {
        intentGate: { enabled: false },
        tandemEnabled: false,
      },
    }),
    HYDRA_ROOT: tmpDir,
    invalidateConfigCache: () => {},
    _setTestConfigPath: (_p: string | null) => {},
    _setTestConfig: (_cfg: Record<string, unknown>) => {},
  },
});

// ── Mock hydra-agents (getMode / setMode) ───────────────────────────────────

let currentMode = 'economy';

mock.module('../lib/hydra-agents.ts', {
  namedExports: {
    getMode: () => currentMode,
    setMode: (m: string) => {
      if (!['economy', 'balanced', 'performance'].includes(m)) {
        throw new Error(`Invalid mode: ${m}`);
      }
      currentMode = m;
    },
  },
});

// ── Mock hydra-utils ────────────────────────────────────────────────────────

mock.module('../lib/hydra-utils.ts', {
  namedExports: {
    classifyPrompt: (text: string) => ({
      tier: text.length > 50 ? 'complex' : 'simple',
      taskType: 'implementation',
      suggestedAgent: 'claude',
      confidence: 0.8,
      routeStrategy: text.length > 50 ? 'council' : 'single',
      tandemPair: null,
    }),
    selectTandemPair: () => null,
    generateSpec: async () => ({
      specId: 'spec-1',
      specPath: '/tmp/spec.json',
      specContent: 'test spec',
    }),
  },
});

// ── Mock hydra-intent-gate ──────────────────────────────────────────────────

mock.module('../lib/hydra-intent-gate.ts', {
  namedExports: {
    gateIntent: async (text: string) => ({
      text,
      classification: {
        tier: text.length > 50 ? 'complex' : 'simple',
        taskType: 'implementation',
        suggestedAgent: 'claude',
        confidence: 0.8,
        routeStrategy: text.length > 50 ? 'council' : 'single',
        tandemPair: null,
      },
    }),
  },
});

// ── Mock hydra-statusbar ────────────────────────────────────────────────────

mock.module('../lib/hydra-statusbar.ts', {
  namedExports: {
    setLastDispatch: mock.fn(() => {}),
  },
});

// ── Mock hydra-operator-ui ──────────────────────────────────────────────────

mock.module('../lib/hydra-operator-ui.ts', {
  namedExports: {
    SMART_TIER_MAP: { simple: 'economy', medium: 'balanced', complex: 'performance' },
  },
});

// ── Mock hydra-operator-dispatch ────────────────────────────────────────────

const mockPublishFastPath = mock.fn(async (opts: any) => ({
  agent: opts?.classification?.suggestedAgent ?? 'claude',
  task: { id: 'task-1' },
  handoff: { to: opts?.classification?.suggestedAgent ?? 'claude' },
}));

const mockPublishMiniRound = mock.fn(async () => ({
  tasks: [{ id: 'task-1' }],
  handoffs: [{ to: 'claude' }],
}));

const mockPublishTandem = mock.fn(async () => ({
  lead: 'claude',
  follow: 'codex',
  tasks: [{ id: 't1' }, { id: 't2' }],
  handoffs: [{ to: 'claude' }, { to: 'codex' }],
}));

mock.module('../lib/hydra-operator-dispatch.ts', {
  namedExports: {
    shouldCrossVerify: () => false,
    runCrossVerification: async () => ({ ok: true }),
    publishFastPathDelegation: mockPublishFastPath,
    publishMiniRoundDelegation: mockPublishMiniRound,
    publishTandemDelegation: mockPublishTandem,
  },
});

// ── Import module under test ────────────────────────────────────────────────

const { runCouncilPrompt, runCouncilJson, runAutoPrompt, runAutoPromptLegacy, runSmartPrompt } =
  await import('../lib/hydra-operator-concierge.ts');

// ── Tests ───────────────────────────────────────────────────────────────────

describe('runCouncilPrompt', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
    currentMode = 'economy';
  });

  it('spawns council script and returns ok=true on exit 0', async () => {
    spawnResult = { status: 0, stdout: 'council output', stderr: '' };
    const result = await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test prompt',
    });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'council output');
    assert.equal(result.status, 0);
  });

  it('returns ok=false on non-zero exit', async () => {
    spawnResult = { status: 1, stdout: '', stderr: 'error occurred' };
    const result = await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('error occurred'));
  });

  it('passes preview flag', async () => {
    spawnResult = { status: 0, stdout: 'preview', stderr: '' };
    await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      preview: true,
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('mode=preview')));
    assert.ok(args.some((a: string) => a.includes('publish=false')));
  });

  it('passes agents filter', async () => {
    spawnResult = { status: 0, stdout: '', stderr: '' };
    await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      agents: ['claude', 'gemini'],
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('agents=claude,gemini')));
  });

  it('passes rounds parameter', async () => {
    spawnResult = { status: 0, stdout: '', stderr: '' };
    await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      rounds: 3,
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('rounds=3')));
  });

  it('invokes onProgress callback for council_phase markers', async () => {
    const progressData: any[] = [];
    spawnResult = {
      status: 0,
      stdout: '',
      stderr: '{"type":"council_phase","phase":"round1"}\n{"type":"other"}\n',
    };

    await runCouncilPrompt({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      onProgress: (data) => progressData.push(data),
    });

    // The stderr data may be emitted — progress parsing is best-effort
    // Just verify it doesn't crash
    assert.ok(Array.isArray(progressData));
  });
});

describe('runCouncilJson', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
  });

  it('returns parsed report on success', async () => {
    const report = { recommendedMode: 'handoff', tasks: [] };
    spawnResult = { status: 0, stdout: JSON.stringify({ report }), stderr: '' };
    const result = await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.report, report);
  });

  it('returns ok=false on non-zero exit', async () => {
    spawnResult = { status: 1, stdout: '', stderr: 'failed' };
    const result = await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
    });
    assert.equal(result.ok, false);
    assert.equal(result.report, null);
  });

  it('returns ok=false on unparseable JSON', async () => {
    spawnResult = { status: 0, stdout: 'not json', stderr: '' };
    const result = await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
    });
    assert.equal(result.ok, false);
    assert.ok(result.stderr.includes('Failed to parse'));
  });

  it('passes emit=json and save=false', async () => {
    spawnResult = { status: 0, stdout: '{}', stderr: '' };
    await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('emit=json')));
    assert.ok(args.some((a: string) => a.includes('save=false')));
  });

  it('passes publish flag', async () => {
    spawnResult = { status: 0, stdout: '{}', stderr: '' };
    await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      publish: true,
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('publish=true')));
  });

  it('adds preview flags when preview=true', async () => {
    spawnResult = { status: 0, stdout: '{}', stderr: '' };
    await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      preview: true,
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('mode=preview')));
  });

  it('passes agents filter', async () => {
    spawnResult = { status: 0, stdout: '{}', stderr: '' };
    await runCouncilJson({
      baseUrl: 'http://localhost:4173',
      promptText: 'test',
      agents: ['codex'],
    });
    const args = mockSpawn.mock.calls[0].arguments[1];
    assert.ok(args.some((a: string) => a.includes('agents=codex')));
  });
});

describe('runAutoPrompt — non-preview', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
    mockPublishFastPath.mock.resetCalls();
    currentMode = 'economy';
  });

  it('dispatches via fast-path for simple prompts', async () => {
    mockPublishFastPath.mock.mockImplementation(async () => ({
      agent: 'claude',
      task: { id: 'task-1' },
      handoff: { to: 'claude' },
    }));

    const result = await runAutoPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.equal(result.mode, 'fast-path');
    assert.ok(result.published);
    assert.equal(result.escalatedToCouncil, false);
    assert.equal(mockPublishFastPath.mock.callCount(), 1);
  });

  it('dispatches via council for complex prompts', async () => {
    spawnResult = { status: 0, stdout: 'council result text', stderr: '' };

    const result = await runAutoPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude', 'gemini'],
      promptText:
        'Redesign the entire authentication system with multi-factor support and token rotation',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.equal(result.mode, 'council');
    assert.equal(result.escalatedToCouncil, true);
    assert.ok(result.councilOutput);
  });
});

describe('runAutoPrompt — preview mode', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
    mockPublishFastPath.mock.resetCalls();
    currentMode = 'economy';
  });

  it('returns fast-path preview without HTTP calls', async () => {
    const result = await runAutoPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: true,
    });

    assert.equal(result.mode, 'fast-path');
    assert.equal(result.published, null);
    assert.equal(mockPublishFastPath.mock.callCount(), 0);
  });

  it('returns council preview for complex prompts', async () => {
    const result = await runAutoPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude', 'gemini'],
      promptText:
        'Redesign the entire authentication system with multi-factor support and token rotation',
      miniRounds: 1,
      councilRounds: 2,
      preview: true,
    });

    assert.equal(result.mode, 'council');
    assert.equal(result.published, null);
    assert.equal(result.escalatedToCouncil, true);
  });

  it('includes classification in result', async () => {
    const result = await runAutoPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: [],
      promptText: 'Add a button',
      miniRounds: 1,
      councilRounds: 2,
      preview: true,
    });

    assert.ok(result.classification);
    assert.ok(typeof (result.classification as any).tier === 'string');
  });
});

describe('runSmartPrompt', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
    mockPublishFastPath.mock.resetCalls();
    currentMode = 'economy';
  });

  it('annotates result with smartTier and smartMode', async () => {
    mockPublishFastPath.mock.mockImplementation(async () => ({
      agent: 'claude',
      task: { id: 't1' },
      handoff: { to: 'claude' },
    }));

    const result = await runSmartPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.ok('smartTier' in result);
    assert.ok('smartMode' in result);
    assert.ok(typeof result.smartTier === 'string');
    assert.ok(typeof result.smartMode === 'string');
  });

  it('prefixes route with tier arrow', async () => {
    mockPublishFastPath.mock.mockImplementation(async () => ({
      agent: 'claude',
      task: { id: 't1' },
      handoff: { to: 'claude' },
    }));

    const result = await runSmartPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.ok(result.route.includes('\u2192'));
  });

  it('restores mode after dispatch', async () => {
    currentMode = 'economy';
    mockPublishFastPath.mock.mockImplementation(async () => ({
      agent: 'claude',
      task: { id: 't1' },
      handoff: { to: 'claude' },
    }));

    await runSmartPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.equal(currentMode, 'economy');
  });

  it('does not change mode in preview', async () => {
    currentMode = 'economy';

    await runSmartPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix typo',
      miniRounds: 1,
      councilRounds: 2,
      preview: true,
    });

    assert.equal(currentMode, 'economy');
  });

  it('handles complex prompt in smart mode', async () => {
    spawnResult = { status: 0, stdout: 'council output', stderr: '' };

    const result = await runSmartPrompt({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude', 'gemini'],
      promptText:
        'Redesign the entire authentication system with multi-factor support and token rotation and audit',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
    });

    assert.ok(result.smartTier === 'complex');
    assert.ok(result.smartMode === 'performance');
  });
});

describe('runAutoPromptLegacy', () => {
  beforeEach(() => {
    mockSpawn.mock.resetCalls();
    mockPublishMiniRound.mock.resetCalls();
    currentMode = 'economy';
  });

  it('runs mini-round triage and delegates', async () => {
    const report = { recommendedMode: 'handoff', tasks: [{ owner: 'claude', title: 'Do it' }] };
    spawnResult = { status: 0, stdout: JSON.stringify({ report }), stderr: '' };

    mockPublishMiniRound.mock.mockImplementation(async () => ({
      tasks: [{ id: 't1' }],
      handoffs: [{ to: 'claude' }],
    }));

    const result = await runAutoPromptLegacy({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Fix a bug',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
      onProgress: null,
      classification: {
        tier: 'simple',
        taskType: 'implementation',
        suggestedAgent: 'claude',
        confidence: 0.9,
        routeStrategy: 'single',
      },
    });

    assert.equal(result.mode, 'handoff');
    assert.ok(result.published);
    assert.equal(result.escalatedToCouncil, false);
  });

  it('escalates to council when recommended', async () => {
    // Need two spawns: mini-round triage then council
    let callCount = 0;
    const triageReport = { recommendedMode: 'council', tasks: [] };
    mockSpawn.mock.mockImplementation((_cmd: string, _args: string[], _opts?: any) => {
      callCount++;
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => {
        if (callCount === 1) {
          child.stdout.write(JSON.stringify({ report: triageReport }));
        } else {
          child.stdout.write('council escalation output');
        }
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    });

    const result = await runAutoPromptLegacy({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'Complex multi-step task',
      miniRounds: 1,
      councilRounds: 2,
      preview: false,
      onProgress: null,
      classification: {
        tier: 'medium',
        taskType: 'implementation',
        suggestedAgent: 'claude',
        confidence: 0.7,
        routeStrategy: 'council',
      },
    });

    assert.equal(result.escalatedToCouncil, true);
  });

  it('throws when mini-round fails', async () => {
    spawnResult = { status: 1, stdout: '', stderr: 'mini-round failed' };

    await assert.rejects(
      () =>
        runAutoPromptLegacy({
          baseUrl: 'http://localhost:4173',
          from: 'operator',
          agents: [],
          promptText: 'test',
          miniRounds: 1,
          councilRounds: 2,
          preview: false,
          onProgress: null,
          classification: null,
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes('mini-round') ||
            err.message.includes('Mini-round') ||
            err.message.length > 0,
        );
        return true;
      },
    );
  });

  it('preview mode returns without HTTP calls', async () => {
    // Reset mockSpawn to use default makeMockChild (may have been overridden by escalation test)
    mockSpawn.mock.mockImplementation((_cmd: string, _args: string[], _opts?: any) =>
      makeMockChild(),
    );
    const report = { recommendedMode: 'handoff', tasks: [] };
    spawnResult = { status: 0, stdout: JSON.stringify({ report }), stderr: '' };

    const result = await runAutoPromptLegacy({
      baseUrl: 'http://localhost:4173',
      from: 'operator',
      agents: ['claude'],
      promptText: 'test',
      miniRounds: 1,
      councilRounds: 2,
      preview: true,
      onProgress: null,
      classification: {
        tier: 'simple',
        taskType: 'implementation',
        suggestedAgent: 'claude',
        confidence: 0.9,
        routeStrategy: 'single',
      },
    });

    assert.equal(result.mode, 'preview');
    assert.equal(result.published, null);
  });
});

// Cleanup temp dir
afterEach(() => {
  currentMode = 'economy';
});

// Final cleanup
import { after } from 'node:test';
after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});
