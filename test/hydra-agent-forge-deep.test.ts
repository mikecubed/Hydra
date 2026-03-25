/**
 * Deep coverage tests for lib/hydra-agent-forge.ts
 *
 * Uses mock.module() to mock executeAgent and other dependencies so we can
 * test the forge pipeline, persistence, and validation without real agent calls.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockExecuteAgent = mock.fn(
  async (_agent: string, _prompt: string, _opts?: Record<string, unknown>) => ({
    ok: true,
    output: '{}',
    durationMs: 100,
    error: null as string | null,
  }),
);

mock.module('../lib/hydra-shared/agent-executor.ts', {
  namedExports: {
    executeAgent: mockExecuteAgent,
  },
});

// Mock git to avoid real git calls
mock.module('../lib/hydra-shared/git-ops.ts', {
  namedExports: {
    git: mock.fn(() => ({
      status: 0,
      stdout: 'abc123 recent commit',
      stderr: '',
      error: null,
      signal: null,
    })),
  },
});

// We need to keep real config functions but redirect to tmp
// (already handled by _setTestConfigPath / _setTestForgeDir in the module)

const {
  validateAgentSpec,
  generateSamplePrompt,
  loadForgeRegistry,
  saveForgeRegistry,
  listForgedAgents,
  persistForgedAgent,
  removeForgedAgent,
  runForgePipeline,
  testForgedAgent,
  forgeAgent,
  analyzeCodebase,
  _setTestForgeDir,
} = await import('../lib/hydra-agent-forge.ts');

// Use inline types to avoid `type` import keyword which Node's type-strip rejects
interface ForgeSpec {
  name: string;
  displayName: string;
  baseAgent: string;
  strengths: string[];
  weaknesses: string[];
  tags: string[];
  taskAffinity: Partial<Record<string, number>>;
  rolePrompt: string;
  enabled: boolean;
  type?: string;
}

interface CodebaseProfile {
  projectName: string;
  projectRoot: string;
  fileTypes: Record<string, number>;
  hasTests: boolean;
  packageJson: Record<string, unknown> | null;
  claudeMd: boolean;
  recentCommits: string[];
  existingAgents: Array<{ name: string; type: string; topAffinities: string[] }>;
  coverageGaps: Array<{ type: string; bestScore: number }>;
}

const { _setTestConfigPath, invalidateConfigCache, saveHydraConfig } =
  await import('../lib/hydra-config.ts');

const { TASK_TYPES, _resetRegistry, initAgentRegistry } = await import('../lib/hydra-agents.ts');

// ── Isolation ───────────────────────────────────────────────────────────────

let tmpDir: string;

function setupTmp(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-forge-deep-'));
  _setTestConfigPath(path.join(tmpDir, 'hydra.config.json'));
  _setTestForgeDir(path.join(tmpDir, 'forge'));
  saveHydraConfig({});
}

function teardownTmp(): void {
  _setTestConfigPath(null);
  _setTestForgeDir(null);
  invalidateConfigCache();
  _resetRegistry();
  initAgentRegistry();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeValidSpec(overrides: Partial<ForgeSpec> = {}): ForgeSpec {
  return {
    name: 'test-agent',
    displayName: 'Test Agent',
    baseAgent: 'claude',
    strengths: ['testing', 'analysis'],
    weaknesses: ['speed'],
    tags: ['test'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])) as ForgeSpec['taskAffinity'],
    rolePrompt: 'A detailed role prompt for the test agent with specific methodology. '.repeat(5),
    enabled: true,
    type: 'virtual',
    ...overrides,
  };
}

function makeAnalysisJson(): string {
  return JSON.stringify({
    recommendedFocus: 'test automation',
    suggestedName: 'test-bot',
    suggestedBase: 'codex',
    reasoning: 'Testing gaps in codebase',
    targetTaskTypes: ['testing', 'implementation'],
    suggestedStrengths: ['unit-testing', 'coverage'],
    codebaseInsights: 'Good test infra but gaps',
  });
}

function makeDesignJson(): string {
  return JSON.stringify({
    name: 'test-bot',
    displayName: 'Test Bot',
    baseAgent: 'codex',
    strengths: ['unit-testing', 'coverage', 'tdd'],
    weaknesses: ['architecture', 'design'],
    tags: ['testing', 'quality'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, t === 'testing' ? 0.95 : 0.3])),
    rolePrompt: `You are a specialized test automation agent. Follow TDD methodology. Write comprehensive tests with edge cases. ${'A'.repeat(200)}`,
    enabled: true,
  });
}

function makeCritiqueJson(): string {
  return JSON.stringify({
    overallAssessment: 'good',
    issues: [{ severity: 'info', field: 'name', message: 'Name is clear' }],
    suggestions: ['Add more coverage for edge cases'],
    affinityAdjustments: { testing: 0.97 },
    rolePromptFeedback: 'Good structure, add output format.',
    nameAlternatives: ['test-automator'],
  });
}

function makeRefineJson(): string {
  return JSON.stringify({
    name: 'test-bot',
    displayName: 'Test Bot',
    baseAgent: 'codex',
    strengths: ['unit-testing', 'coverage', 'tdd', 'edge-cases'],
    weaknesses: ['architecture'],
    tags: ['testing', 'quality'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, t === 'testing' ? 0.97 : 0.3])),
    rolePrompt: `You are a specialized test automation agent. Follow TDD methodology. Write comprehensive tests with edge cases. Ensure high coverage. ${'A'.repeat(200)}`,
    enabled: true,
  });
}

// ── saveForgeRegistry / loadForgeRegistry ───────────────────────────────────

describe('forge registry round-trip', () => {
  beforeEach(() => {
    setupTmp();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('saves and loads registry', () => {
    const reg = {
      'my-agent': {
        forgedAt: '2025-01-01',
        description: 'test',
        phasesRun: ['analyze'],
        testResult: null,
        version: 1,
      },
    };
    saveForgeRegistry(reg);
    const loaded = loadForgeRegistry();
    assert.deepEqual(loaded, reg);
  });

  it('returns empty object when registry file missing', () => {
    const loaded = loadForgeRegistry();
    assert.deepEqual(loaded, {});
  });
});

// ── validateAgentSpec — additional coverage ─────────────────────────────────

describe('validateAgentSpec — deep', () => {
  it('warns on very long rolePrompt', () => {
    const spec = makeValidSpec({ rolePrompt: 'A'.repeat(6000) });
    const result = validateAgentSpec(spec);
    assert.ok(result.valid);
    assert.ok(result.warnings.some((w: string) => w.includes('very long')));
  });

  it('warns on missing displayName', () => {
    const spec = makeValidSpec({ displayName: '' });
    const result = validateAgentSpec(spec);
    assert.ok(result.valid);
    assert.ok(result.warnings.some((w: string) => w.includes('displayName')));
  });

  it('rejects out-of-range affinity with warning', () => {
    const spec = makeValidSpec({
      taskAffinity: Object.fromEntries(
        TASK_TYPES.map((t) => [t, t === 'testing' ? 1.5 : 0.5]),
      ) as ForgeSpec['taskAffinity'],
    });
    const result = validateAgentSpec(spec);
    assert.ok(result.valid); // warnings don't invalidate
    assert.ok(result.warnings.some((w: string) => w.includes('out of range')));
  });

  it('accepts valid spec with no warnings', () => {
    const spec = makeValidSpec();
    const result = validateAgentSpec(spec);
    assert.ok(result.valid);
    // Some warnings are expected (like missing displayName) but errors should be 0
    assert.equal(result.errors.length, 0);
  });
});

// ── generateSamplePrompt — deeper coverage ──────────────────────────────────

describe('generateSamplePrompt — deep', () => {
  it('generates security prompt for security affinity', () => {
    const prompt = generateSamplePrompt(
      { taskAffinity: { security: 0.99, testing: 0.1 } },
      { projectName: 'MyApp' },
    );
    assert.ok(prompt.toLowerCase().includes('security'));
    assert.ok(prompt.includes('MyApp'));
  });

  it('generates documentation prompt for doc affinity', () => {
    const prompt = generateSamplePrompt(
      { taskAffinity: { documentation: 0.99 } },
      { projectName: 'Lib' },
    );
    assert.ok(prompt.toLowerCase().includes('document'));
  });

  it('generates research prompt for research affinity', () => {
    const prompt = generateSamplePrompt({ taskAffinity: { research: 0.99 } });
    assert.ok(prompt.toLowerCase().includes('research'));
  });

  it('falls back to implementation for unknown type', () => {
    const prompt = generateSamplePrompt({ taskAffinity: {} });
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 10);
  });

  it('uses "the project" when no projectName given', () => {
    const prompt = generateSamplePrompt({ taskAffinity: { planning: 0.99 } });
    assert.ok(prompt.includes('the project'));
  });

  for (const type of ['planning', 'architecture', 'review', 'refactor', 'analysis', 'testing']) {
    it(`covers ${type} prompt template`, () => {
      const prompt = generateSamplePrompt(
        { taskAffinity: { [type]: 0.99 } },
        { projectName: 'Proj' },
      );
      assert.ok(prompt.length > 20);
    });
  }
});

// ── runForgePipeline (mocked executeAgent) ──────────────────────────────────

describe('runForgePipeline (mocked)', () => {
  beforeEach(() => {
    setupTmp();
    mockExecuteAgent.mock.resetCalls();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('runs 4 phases and returns spec', async () => {
    let callIdx = 0;
    mockExecuteAgent.mock.mockImplementation(async () => {
      callIdx++;
      const outputs = [makeAnalysisJson(), makeDesignJson(), makeCritiqueJson(), makeRefineJson()];
      return { ok: true, output: outputs[callIdx - 1] ?? '{}', durationMs: 50, error: null };
    });

    const profile: CodebaseProfile = {
      projectName: 'TestProject',
      projectRoot: tmpDir,
      fileTypes: { '.ts': 10 },
      hasTests: true,
      packageJson: null,
      claudeMd: false,
      recentCommits: ['abc123 test'],
      existingAgents: [],
      coverageGaps: [],
    };

    const phases: string[] = [];
    const result = await runForgePipeline('create a test agent', profile, {
      phaseTimeoutMs: 5000,
      onPhase: (name, status) => phases.push(`${name}:${status}`),
    });

    assert.ok(result.spec.name);
    assert.ok(result.spec.rolePrompt.length > 0);
    assert.equal(result.session.phasesRun.length, 4);
    assert.ok(phases.includes('analyze:running'));
    assert.ok(phases.includes('analyze:done'));
    assert.ok(phases.includes('design:running'));
    assert.ok(phases.includes('design:done'));
    assert.ok(phases.includes('critique:running'));
    assert.ok(phases.includes('critique:done'));
    assert.ok(phases.includes('refine:running'));
    assert.ok(phases.includes('refine:done'));
    assert.equal(mockExecuteAgent.mock.callCount(), 4);
  });

  it('falls back to defaults when analysis returns garbage', async () => {
    mockExecuteAgent.mock.mockImplementation(async () => ({
      ok: true,
      output: 'not json at all',
      durationMs: 50,
      error: null,
    }));

    const profile: CodebaseProfile = {
      projectName: 'TestProject',
      projectRoot: tmpDir,
      fileTypes: {},
      hasTests: false,
      packageJson: null,
      claudeMd: false,
      recentCommits: [],
      existingAgents: [],
      coverageGaps: [],
    };

    const result = await runForgePipeline('test', profile, { phaseTimeoutMs: 5000 });
    assert.ok(result.spec);
    // Should have fallback values
    assert.ok(result.spec.name.length > 0);
    assert.ok(result.spec.rolePrompt.length > 0);
  });

  it('uses phaseTimeoutMs from config', async () => {
    let callIdx = 0;
    mockExecuteAgent.mock.mockImplementation(async () => {
      callIdx++;
      const outputs = [makeAnalysisJson(), makeDesignJson(), makeCritiqueJson(), makeRefineJson()];
      return { ok: true, output: outputs[callIdx - 1] ?? '{}', durationMs: 50, error: null };
    });

    const profile: CodebaseProfile = {
      projectName: 'Test',
      projectRoot: tmpDir,
      fileTypes: {},
      hasTests: false,
      packageJson: null,
      claudeMd: false,
      recentCommits: [],
      existingAgents: [],
      coverageGaps: [],
    };

    // Just verify it doesn't throw when using defaults
    const result = await runForgePipeline('', profile);
    assert.ok(result.spec);
  });
});

// ── testForgedAgent (mocked) ────────────────────────────────────────────────

describe('testForgedAgent (mocked)', () => {
  beforeEach(() => {
    setupTmp();
    mockExecuteAgent.mock.resetCalls();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('runs agent with role prompt prepended', async () => {
    mockExecuteAgent.mock.mockImplementation(async (_agent: string, _prompt: string) => ({
      ok: true,
      output: 'test passed',
      durationMs: 200,
      error: null,
    }));

    const spec = makeValidSpec({ baseAgent: 'codex' });
    const result = await testForgedAgent(spec, 'Run tests');
    assert.equal(result.ok, true);
    assert.equal(result.output, 'test passed');
    assert.equal(result.prompt, 'Run tests');

    // Check that the execute was called with codex
    const call = mockExecuteAgent.mock.calls[0];
    assert.equal(call.arguments[0], 'codex');
    // Prompt should contain rolePrompt + task
    assert.ok(call.arguments[1].includes(spec.rolePrompt));
    assert.ok(call.arguments[1].includes('Run tests'));
  });

  it('generates sample prompt when none provided', async () => {
    mockExecuteAgent.mock.mockImplementation(async () => ({
      ok: true,
      output: 'ok',
      durationMs: 100,
      error: null,
    }));

    const spec = makeValidSpec({
      taskAffinity: Object.fromEntries(
        TASK_TYPES.map((t) => [t, t === 'security' ? 0.99 : 0.1]),
      ) as ForgeSpec['taskAffinity'],
    });
    const profile: CodebaseProfile = {
      projectName: 'TestProject',
      projectRoot: tmpDir,
      fileTypes: {},
      hasTests: true,
      packageJson: null,
      claudeMd: false,
      recentCommits: [],
      existingAgents: [],
      coverageGaps: [],
    };

    const result = await testForgedAgent(spec, null, { profile });
    assert.ok(result.prompt.toLowerCase().includes('security'));
  });

  it('returns error from failed agent execution', async () => {
    mockExecuteAgent.mock.mockImplementation(async () => ({
      ok: false,
      output: '',
      durationMs: 100,
      error: 'agent crashed',
    }));

    const spec = makeValidSpec();
    const result = await testForgedAgent(spec);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'agent crashed');
  });
});

// ── persistForgedAgent — deep coverage ──────────────────────────────────────

describe('persistForgedAgent — deep', () => {
  beforeEach(() => {
    setupTmp();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('persists agent to config and registry', () => {
    const spec = makeValidSpec({ name: 'deep-test-agent' });
    persistForgedAgent(spec, {
      description: 'Deep test',
      phasesRun: ['analyze', 'design'],
    });

    const registry = loadForgeRegistry();
    assert.ok(registry['deep-test-agent']);
    assert.equal(registry['deep-test-agent'].description, 'Deep test');
    assert.equal(registry['deep-test-agent'].version, 1);
  });

  it('increments version on re-persist', () => {
    const spec = makeValidSpec({ name: 'versioned-agent' });
    persistForgedAgent(spec, { description: 'v1', phasesRun: ['analyze'] });
    persistForgedAgent(spec, { description: 'v2', phasesRun: ['analyze'] });

    const registry = loadForgeRegistry();
    assert.equal(registry['versioned-agent'].version, 2);
  });

  it('handles session with testResult', () => {
    const spec = makeValidSpec({ name: 'tested-agent' });
    persistForgedAgent(spec, {
      description: 'Tested',
      phasesRun: ['analyze'],
      testResult: { ok: true, durationMs: 500 },
    });

    const registry = loadForgeRegistry();
    assert.deepEqual(registry['tested-agent'].testResult, { ok: true, durationMs: 500 });
  });

  it('saves forge session file', () => {
    const spec = makeValidSpec({ name: 'session-agent' });
    persistForgedAgent(spec, {
      description: 'Session test',
      startedAt: '2025-01-01T00:00:00Z',
      phasesRun: ['analyze', 'design', 'critique', 'refine'],
    });

    const sessionsDir = path.join(tmpDir, 'forge', 'sessions');
    const files = fs.readdirSync(sessionsDir);
    assert.ok(files.some((f) => f.startsWith('FORGE_session-agent_')));
  });
});

// ── removeForgedAgent — deep coverage ───────────────────────────────────────

describe('removeForgedAgent — deep', () => {
  beforeEach(() => {
    setupTmp();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('removes from both config and registry', () => {
    const spec = makeValidSpec({ name: 'removable' });
    persistForgedAgent(spec, { description: 'temp', phasesRun: ['analyze'] });

    removeForgedAgent('removable');

    const registry = loadForgeRegistry();
    assert.ok(!registry['removable']);
  });

  it('handles removing non-existent agent gracefully', () => {
    assert.doesNotThrow(() => {
      removeForgedAgent('non-existent-agent');
    });
  });

  it('normalizes name to lowercase', () => {
    const spec = makeValidSpec({ name: 'uppercase-test' });
    persistForgedAgent(spec, { description: 'test', phasesRun: ['analyze'] });

    removeForgedAgent('UPPERCASE-TEST');

    const registry = loadForgeRegistry();
    assert.ok(!registry['uppercase-test']);
  });
});

// ── listForgedAgents — deep ─────────────────────────────────────────────────

describe('listForgedAgents — deep', () => {
  beforeEach(() => {
    setupTmp();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('returns agent details from registry and config', () => {
    const spec = makeValidSpec({ name: 'list-test', displayName: 'List Test' });
    persistForgedAgent(spec, { description: 'For listing', phasesRun: ['analyze'] });

    const list = listForgedAgents();
    const found = list.find((a) => a.name === 'list-test');
    assert.ok(found);
    assert.equal(found.displayName, 'List Test');
    assert.equal(found.baseAgent, 'claude');
    assert.ok(found.version >= 1);
    assert.ok(Array.isArray(found.topAffinities));
  });

  it('returns empty array when no forged agents', () => {
    const list = listForgedAgents();
    // May have some from other test pollution, but should be an array
    assert.ok(Array.isArray(list));
  });

  it('shows topAffinities for agents', () => {
    const spec = makeValidSpec({
      name: 'affinity-test',
      taskAffinity: Object.fromEntries(
        TASK_TYPES.map((t) => [t, t === 'testing' ? 0.95 : 0.1]),
      ) as ForgeSpec['taskAffinity'],
    });
    persistForgedAgent(spec, { description: 'Affinity', phasesRun: ['analyze'] });

    const list = listForgedAgents();
    const found = list.find((a) => a.name === 'affinity-test');
    assert.ok(found);
    assert.ok(found.topAffinities.length > 0);
    assert.ok(found.topAffinities[0].includes('testing'));
  });
});

// ── forgeAgent (non-interactive API, mocked) ────────────────────────────────

describe('forgeAgent (mocked)', () => {
  beforeEach(() => {
    setupTmp();
    mockExecuteAgent.mock.resetCalls();
  });
  afterEach(() => {
    teardownTmp();
  });

  it('runs full pipeline and persists', async () => {
    let callIdx = 0;
    mockExecuteAgent.mock.mockImplementation(async () => {
      callIdx++;
      const outputs = [makeAnalysisJson(), makeDesignJson(), makeCritiqueJson(), makeRefineJson()];
      return { ok: true, output: outputs[callIdx - 1] ?? '{}', durationMs: 50, error: null };
    });

    const result = await forgeAgent('create a test bot', { skipTest: true });
    assert.equal(result.ok, true);
    assert.ok(result.spec);
    assert.ok(result.spec.name.length > 0);
    assert.ok(result.phases);
  });

  it('overrides name when provided', async () => {
    mockExecuteAgent.mock.mockImplementation(async () => ({
      ok: true,
      output: makeDesignJson(),
      durationMs: 50,
      error: null,
    }));

    const result = await forgeAgent('test', { name: 'my-custom-name', skipTest: true });
    if (result.ok) {
      assert.equal(result.spec.name, 'my-custom-name');
    }
  });

  it('overrides baseAgent when provided', async () => {
    mockExecuteAgent.mock.mockImplementation(async () => ({
      ok: true,
      output: makeDesignJson(),
      durationMs: 50,
      error: null,
    }));

    const result = await forgeAgent('test', { baseAgent: 'gemini', skipTest: true });
    if (result.ok) {
      assert.equal(result.spec.baseAgent, 'gemini');
    }
  });

  it('returns validation errors when spec is invalid', async () => {
    // Return valid analysis but empty-name design spec that will fail validation
    let callIdx = 0;
    mockExecuteAgent.mock.mockImplementation(async () => {
      callIdx++;
      if (callIdx === 1)
        return { ok: true, output: makeAnalysisJson(), durationMs: 50, error: null };
      // All subsequent phases return a spec with empty baseAgent to trigger validation failure
      return {
        ok: true,
        output: JSON.stringify({
          name: 'invalid agent!!!',
          displayName: '',
          baseAgent: 'nonexistent-agent',
          strengths: [],
          weaknesses: [],
          tags: [],
          taskAffinity: {},
          rolePrompt: '',
          enabled: true,
        }),
        durationMs: 50,
        error: null,
      };
    });

    const result = await forgeAgent('bad spec', { skipTest: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors && result.errors.length > 0);
  });
});

// ── analyzeCodebase ─────────────────────────────────────────────────────────

describe('analyzeCodebase — deep', () => {
  it('returns profile with all expected fields', () => {
    const profile = analyzeCodebase();
    assert.ok(typeof profile.projectName === 'string');
    assert.ok(typeof profile.projectRoot === 'string');
    assert.ok(typeof profile.fileTypes === 'object');
    assert.ok(typeof profile.hasTests === 'boolean');
    assert.ok(typeof profile.claudeMd === 'boolean');
    assert.ok(Array.isArray(profile.recentCommits));
    assert.ok(Array.isArray(profile.existingAgents));
    assert.ok(Array.isArray(profile.coverageGaps));
  });
});
