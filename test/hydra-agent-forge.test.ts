import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  validateAgentSpec,
  analyzeCodebase,
  loadForgeRegistry,
  saveForgeRegistry,
  listForgedAgents,
  persistForgedAgent,
  removeForgedAgent,
  generateSamplePrompt,
  _setTestForgeDir,
  type ForgeSpec,
} from '../lib/hydra-agent-forge.ts';
import { TASK_TYPES, getAgent, _resetRegistry, initAgentRegistry } from '../lib/hydra-agents.ts';
import { registerBuiltInSubAgents } from '../lib/hydra-sub-agents.ts';
import { _setTestConfigPath, invalidateConfigCache, saveHydraConfig } from '../lib/hydra-config.ts';

// ── Test isolation: redirect config + forge writes to a tmp directory ──────────
let _tmpDir: string;

function setupTmp(): void {
  _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-forge-test-'));
  _setTestConfigPath(path.join(_tmpDir, 'hydra.config.json'));
  _setTestForgeDir(path.join(_tmpDir, 'forge'));
  saveHydraConfig({});
}

function teardownTmp(): void {
  _setTestConfigPath(null);
  _setTestForgeDir(null);
  invalidateConfigCache();
  _resetRegistry();
  initAgentRegistry();
  fs.rmSync(_tmpDir, { recursive: true, force: true });
}

// ── validateAgentSpec ─────────────────────────────────────────────────────────

test('validateAgentSpec: valid spec passes', () => {
  const spec: Record<string, unknown> = {
    name: 'test-agent',
    displayName: 'Test Agent',
    baseAgent: 'claude',
    strengths: ['testing'],
    weaknesses: ['speed'],
    tags: ['test'],
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
    enabled: true,
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid, `Expected valid but got errors: ${result.errors.join(', ')}`);
  assert.equal(result.errors.length, 0);
});

test('validateAgentSpec: rejects invalid name', () => {
  const spec: Record<string, unknown> = {
    name: 'INVALID NAME!',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('Invalid name')));
});

test('validateAgentSpec: rejects missing baseAgent', () => {
  const spec: Record<string, unknown> = {
    name: 'test-agent',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('baseAgent')));
});

test('validateAgentSpec: rejects non-physical baseAgent', () => {
  // security-reviewer is virtual, should be rejected
  _resetRegistry();
  initAgentRegistry();
  registerBuiltInSubAgents();

  const spec: Record<string, unknown> = {
    name: 'bad-base',
    baseAgent: 'security-reviewer',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('must be a physical agent')));
});

test('validateAgentSpec: rejects collision with physical agent', () => {
  const spec: Record<string, unknown> = {
    name: 'claude',
    baseAgent: 'gemini',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('collides')));
});

test('validateAgentSpec: rejects missing rolePrompt', () => {
  const spec: Record<string, unknown> = {
    name: 'no-prompt',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('rolePrompt')));
});

test('validateAgentSpec: rejects missing taskAffinity', () => {
  const spec: Record<string, unknown> = {
    name: 'no-affinity',
    baseAgent: 'claude',
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('taskAffinity')));
});

test('validateAgentSpec: warns on short rolePrompt', () => {
  const spec: Record<string, unknown> = {
    name: 'short-prompt',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'Brief.',
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid); // warnings don't make it invalid
  assert.ok(result.warnings.some((w: string) => w.includes('very short')));
});

test('validateAgentSpec: warns on missing affinities', () => {
  const spec: Record<string, unknown> = {
    name: 'partial-affinity',
    baseAgent: 'claude',
    taskAffinity: { implementation: 0.9 },
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w: string) => w.includes('Missing affinity')));
});

test('validateAgentSpec: warns on high affinity where base is weak', () => {
  const spec: Record<string, unknown> = {
    name: 'bad-affinity',
    baseAgent: 'codex',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.3])),
    rolePrompt: 'A'.repeat(200),
  };
  // Codex is weak at architecture (0.15) — set high affinity to trigger warning
  (spec['taskAffinity'] as Record<string, number>)['architecture'] = 0.95;
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w: string) => w.includes('underperform')));
});

// ── analyzeCodebase ───────────────────────────────────────────────────────────

test('analyzeCodebase returns expected profile structure', () => {
  const profile = analyzeCodebase();
  assert.ok(profile.projectName, 'should have projectName');
  assert.ok(typeof profile.fileTypes === 'object', 'should have fileTypes');
  assert.ok(typeof profile.hasTests === 'boolean', 'should have hasTests');
  assert.ok(Array.isArray(profile.existingAgents), 'should have existingAgents');
  assert.ok(Array.isArray(profile.coverageGaps), 'should have coverageGaps');
  assert.ok(Array.isArray(profile.recentCommits), 'should have recentCommits');
});

test('analyzeCodebase detects this project correctly', () => {
  const profile = analyzeCodebase();
  // This is the Hydra project
  assert.ok(profile.claudeMd, 'should detect CLAUDE.md');
  assert.ok(profile.hasTests, 'should detect test directory');
  assert.ok(profile.existingAgents.length >= 3, 'should have at least 3 agents');
});

// ── generateSamplePrompt ──────────────────────────────────────────────────────

test('generateSamplePrompt returns a string matching top affinity', () => {
  const spec: Record<string, unknown> = {
    taskAffinity: {
      testing: 0.95,
      implementation: 0.5,
      review: 0.3,
    },
  };
  const prompt = generateSamplePrompt(spec, { projectName: 'TestProject' });
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 20);
  // Testing is the top affinity, so prompt should be test-related
  assert.ok(prompt.toLowerCase().includes('test'));
});

test('generateSamplePrompt handles empty affinity', () => {
  const prompt = generateSamplePrompt({ taskAffinity: {} }, { projectName: 'X' });
  assert.ok(typeof prompt === 'string');
  assert.ok(prompt.length > 10);
});

// ── Registry operations ───────────────────────────────────────────────────────

test('loadForgeRegistry returns object (may be empty)', () => {
  const registry = loadForgeRegistry();
  assert.ok(typeof registry === 'object');
  assert.ok(!Array.isArray(registry));
});

test('listForgedAgents returns array', () => {
  const list = listForgedAgents();
  assert.ok(Array.isArray(list));
});

// ── persistForgedAgent + removeForgedAgent round-trip ──────────────────────────

test('persist and remove a forged agent round-trip', () => {
  setupTmp();
  try {
    const testName = 'forge-test-roundtrip';

    const spec: Record<string, unknown> = {
      name: testName,
      displayName: 'Forge Test Roundtrip',
      baseAgent: 'claude',
      strengths: ['testing'],
      weaknesses: ['scope'],
      tags: ['test'],
      taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.4])),
      rolePrompt: `Test agent for unit test round-trip validation. ${'A'.repeat(100)}`,
      enabled: true,
      type: 'virtual',
    };

    // Persist
    persistForgedAgent(spec as unknown as ForgeSpec, {
      description: 'Unit test round-trip',
      phasesRun: ['analyze', 'design', 'critique', 'refine'],
    });

    // Verify registered
    const agent = getAgent(testName);
    assert.ok(agent, 'Agent should be registered after persist');
    assert.equal(agent.displayName, 'Forge Test Roundtrip');
    assert.equal(agent.baseAgent, 'claude');

    // Verify in forge registry
    const registry = loadForgeRegistry();
    assert.ok(registry[testName], 'Should be in forge registry');
    assert.equal(registry[testName].description, 'Unit test round-trip');

    // Verify in listForgedAgents
    const list = listForgedAgents();
    assert.ok(
      list.some((a: Record<string, unknown>) => a['name'] === testName),
      'Should appear in listForgedAgents',
    );

    // Remove
    removeForgedAgent(testName);

    // Verify removed from live registry
    const afterRemove = getAgent(testName);
    assert.ok(!afterRemove, 'Agent should be unregistered after remove');

    // Verify removed from forge registry
    const registryAfter = loadForgeRegistry();
    assert.ok(!registryAfter[testName], 'Should be removed from forge registry');
  } finally {
    teardownTmp();
  }
});

// ── _setTestForgeDir ─────────────────────────────────────────────────────────

test('_setTestForgeDir redirects registry reads to temp dir', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-forge-seam-'));
  try {
    _setTestForgeDir(tmpDir);
    // Reading registry from an empty temp dir should return empty object
    const registry = loadForgeRegistry();
    assert.deepEqual(registry, {});
  } finally {
    _setTestForgeDir(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('_setTestForgeDir(null) restores default behavior', () => {
  _setTestForgeDir('/some/fake/path');
  _setTestForgeDir(null);
  // Should not throw — reads from real forge dir
  const registry = loadForgeRegistry();
  assert.ok(typeof registry === 'object');
});

// ── saveForgeRegistry + loadForgeRegistry round-trip ──────────────────────────

test('saveForgeRegistry + loadForgeRegistry round-trip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-forge-reg-'));
  try {
    _setTestForgeDir(tmpDir);
    const data = {
      'test-agent': {
        forgedAt: '2025-01-01T00:00:00.000Z',
        description: 'Test entry',
        phasesRun: ['analyze', 'design'],
        testResult: null,
        version: 1,
      },
    };
    saveForgeRegistry(data);
    const loaded = loadForgeRegistry();
    assert.deepEqual(loaded, data);
  } finally {
    _setTestForgeDir(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── validateAgentSpec: additional edge cases ─────────────────────────────────

test('validateAgentSpec: rejects name starting with uppercase', () => {
  const spec: Record<string, unknown> = {
    name: 'UpperCase',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('Invalid name')));
});

test('validateAgentSpec: rejects name with spaces', () => {
  const spec: Record<string, unknown> = {
    name: 'has space',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('Invalid name')));
});

test('validateAgentSpec: rejects undefined name', () => {
  const spec: Record<string, unknown> = {
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('Invalid name')));
});

test('validateAgentSpec: warns on very long rolePrompt', () => {
  const spec: Record<string, unknown> = {
    name: 'long-prompt',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(6000),
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w: string) => w.includes('very long')));
});

test('validateAgentSpec: warns on missing displayName', () => {
  const spec: Record<string, unknown> = {
    name: 'no-display',
    baseAgent: 'claude',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid);
  assert.ok(result.warnings.some((w: string) => w.includes('displayName')));
});

test('validateAgentSpec: warns on out-of-range affinity values', () => {
  const spec: Record<string, unknown> = {
    name: 'bad-range',
    baseAgent: 'claude',
    taskAffinity: { implementation: 1.5, review: -0.5 },
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(result.valid); // out of range is a warning, not error
  assert.ok(result.warnings.some((w: string) => w.includes('out of range')));
});

test('validateAgentSpec: rejects non-existent baseAgent', () => {
  const spec: Record<string, unknown> = {
    name: 'bad-base',
    baseAgent: 'nonexistent-agent-xyz',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('does not exist')));
});

test('validateAgentSpec: rejects empty string baseAgent', () => {
  const spec: Record<string, unknown> = {
    name: 'empty-base',
    baseAgent: '',
    taskAffinity: Object.fromEntries(TASK_TYPES.map((t) => [t, 0.5])),
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('baseAgent')));
});

test('validateAgentSpec: taskAffinity as non-object is rejected', () => {
  const spec: Record<string, unknown> = {
    name: 'bad-affinity-type',
    baseAgent: 'claude',
    taskAffinity: 'not-an-object',
    rolePrompt: 'A'.repeat(200),
  };
  const result = validateAgentSpec(spec);
  assert.ok(!result.valid);
  assert.ok(result.errors.some((e: string) => e.includes('taskAffinity')));
});

// ── analyzeCodebase: additional checks ───────────────────────────────────────

test('analyzeCodebase returns non-empty fileTypes for this repo', () => {
  const profile = analyzeCodebase();
  assert.ok(Object.keys(profile.fileTypes).length > 0, 'should detect file types');
  assert.ok(profile.fileTypes['.ts'] > 0, 'should detect .ts files');
});

test('analyzeCodebase detects package.json', () => {
  const profile = analyzeCodebase();
  assert.ok(profile.packageJson !== null, 'should detect package.json');
  assert.ok(typeof profile.packageJson === 'object');
});

test('analyzeCodebase returns recentCommits as array of strings', () => {
  const profile = analyzeCodebase();
  assert.ok(Array.isArray(profile.recentCommits));
  if (profile.recentCommits.length > 0) {
    assert.equal(typeof profile.recentCommits[0], 'string');
  }
});

test('analyzeCodebase existingAgents have expected shape', () => {
  const profile = analyzeCodebase();
  for (const agent of profile.existingAgents) {
    assert.ok(typeof agent.name === 'string');
    assert.ok(typeof agent.type === 'string');
    assert.ok(Array.isArray(agent.topAffinities));
  }
});

test('analyzeCodebase coverageGaps have expected shape', () => {
  const profile = analyzeCodebase();
  for (const gap of profile.coverageGaps) {
    assert.ok(typeof gap.type === 'string');
    assert.ok(typeof gap.bestScore === 'number');
    assert.ok(gap.bestScore < 0.7, 'gaps should have bestScore < 0.7');
  }
});
