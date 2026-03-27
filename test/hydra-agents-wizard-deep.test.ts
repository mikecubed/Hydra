/**
 * Deep coverage tests for hydra-agents-wizard.ts
 *
 * Tests: validateAgentName, parseArgsTemplate, buildCustomAgentEntry,
 * and runAgentsWizard (with mocked readline + dependencies).
 *
 * Requires --experimental-test-module-mocks.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, mock, before } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock dependencies before import ──────────────────────────────────────────

const mockPromptChoice: any = mock.fn(async () => ({ value: 'cli' }));

mock.module('../lib/hydra-prompt-choice.ts', {
  namedExports: {
    promptChoice: mockPromptChoice,
    isChoiceActive: mock.fn(() => false),
    isAutoAccepting: mock.fn(() => false),
    setAutoAccept: mock.fn(),
    resetAutoAccept: mock.fn(),
  },
});

const mockLoadHydraConfig: any = mock.fn(() => ({
  agents: { customAgents: [] },
  routing: { mode: 'balanced' },
}));
const mockSaveHydraConfig: any = mock.fn();

mock.module('../lib/hydra-config.ts', {
  namedExports: {
    loadHydraConfig: mockLoadHydraConfig,
    saveHydraConfig: mockSaveHydraConfig,
    AFFINITY_PRESETS: {
      balanced: { implementation: 0.5, review: 0.5 },
      'code-focused': { implementation: 0.8, review: 0.2 },
      'review-focused': { implementation: 0.2, review: 0.8 },
      'research-focused': { implementation: 0.3, review: 0.3, research: 0.4 },
    },
    resolveProject: mock.fn(() => ({ projectRoot: '/tmp', projectName: 'test' })),
    getRoleConfig: mock.fn(() => ({})),
  },
});

const mockRegisterMcp: any = mock.fn(() => ({ status: 'added' }));

mock.module('../lib/hydra-setup.ts', {
  namedExports: {
    registerCustomAgentMcp: mockRegisterMcp,
    KNOWN_CLI_MCP_PATHS: {
      gh: '.github/copilot-config.json',
      aider: null,
    },
  },
});

// ── Import module under test ─────────────────────────────────────────────────

let validateAgentName: any;
let parseArgsTemplate: any;
let buildCustomAgentEntry: any;
let runAgentsWizard: any;

before(async () => {
  const mod = await import('../lib/hydra-agents-wizard.ts');
  validateAgentName = mod.validateAgentName;
  parseArgsTemplate = mod.parseArgsTemplate;
  buildCustomAgentEntry = mod.buildCustomAgentEntry;
  runAgentsWizard = mod.runAgentsWizard;
});

// ── Helper: build mock readline + prompt choice sequence ─────────────────────

function setupMockRl(
  answers: string[],
  promptReturns: Array<{ value: string | null }>,
): { mockRl: any } {
  let qIdx = 0;
  let pIdx = 0;
  mockPromptChoice.mock.mockImplementation(async (): Promise<any> => {
    const ret = promptReturns[pIdx] ?? { value: 'skip' };
    pIdx++;
    return ret;
  });
  const mockRl = {
    question: (_q: string, cb: (answer: string) => void): void => {
      cb(answers[qIdx++] ?? '');
    },
  };
  return { mockRl };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('validateAgentName', () => {
  it('returns error for empty string', () => {
    assert.equal(validateAgentName(''), 'Name cannot be empty');
  });

  it('returns error for whitespace-only string', () => {
    assert.equal(validateAgentName('   '), 'Name cannot be empty');
  });

  it('returns error for reserved names', () => {
    assert.ok(validateAgentName('claude')?.includes('reserved'));
    assert.ok(validateAgentName('gemini')?.includes('reserved'));
    assert.ok(validateAgentName('codex')?.includes('reserved'));
    assert.ok(validateAgentName('local')?.includes('reserved'));
  });

  it('returns error for reserved names case-insensitive', () => {
    assert.ok(validateAgentName('CLAUDE')?.includes('reserved'));
    assert.ok(validateAgentName('Gemini')?.includes('reserved'));
  });

  it('returns error for names starting with uppercase', () => {
    const result = validateAgentName('MyAgent');
    assert.ok(result !== null);
    assert.ok(result.includes('lowercase'));
  });

  it('returns error for names starting with number', () => {
    assert.ok(validateAgentName('123agent') !== null);
  });

  it('returns error for names with special characters', () => {
    assert.ok(validateAgentName('my_agent') !== null);
    assert.ok(validateAgentName('my.agent') !== null);
    assert.ok(validateAgentName('my agent') !== null);
  });

  it('returns null for valid names', () => {
    assert.equal(validateAgentName('my-agent'), null);
    assert.equal(validateAgentName('copilot'), null);
    assert.equal(validateAgentName('mixtral'), null);
    assert.equal(validateAgentName('a'), null);
    assert.equal(validateAgentName('agent-123'), null);
  });
});

describe('parseArgsTemplate', () => {
  it('splits space-separated args', () => {
    assert.deepEqual(parseArgsTemplate('copilot suggest -p {prompt}'), [
      'copilot',
      'suggest',
      '-p',
      '{prompt}',
    ]);
  });

  it('handles single arg', () => {
    assert.deepEqual(parseArgsTemplate('{prompt}'), ['{prompt}']);
  });

  it('trims whitespace', () => {
    assert.deepEqual(parseArgsTemplate('  hello  world  '), ['hello', 'world']);
  });

  it('handles empty string', () => {
    assert.deepEqual(parseArgsTemplate(''), []);
  });

  it('handles multiple spaces between args', () => {
    assert.deepEqual(parseArgsTemplate('a    b    c'), ['a', 'b', 'c']);
  });

  it('handles tabs and mixed whitespace', () => {
    assert.deepEqual(parseArgsTemplate('a\tb\t\tc'), ['a', 'b', 'c']);
  });
});

describe('buildCustomAgentEntry', () => {
  it('builds a CLI agent entry', () => {
    const entry = buildCustomAgentEntry({
      name: 'my-agent',
      type: 'cli',
      cmd: 'gh',
      argsTemplate: 'copilot suggest -p {prompt}',
      responseParser: 'plaintext',
      contextBudget: 16000,
      affinityPreset: 'balanced',
      councilRole: 'analyst',
    });
    assert.equal(entry.name, 'my-agent');
    assert.equal(entry.type, 'cli');
    assert.equal(entry.contextBudget, 16000);
    assert.equal(entry.councilRole, 'analyst');
    assert.ok(entry.invoke != null);
    assert.equal(entry.responseParser, 'plaintext');
    assert.equal(entry.enabled, true);
  });

  it('builds an API agent entry', () => {
    const entry = buildCustomAgentEntry({
      name: 'ollama',
      type: 'api',
      baseUrl: 'http://localhost:11434/v1',
      model: 'mixtral:8x7b',
      contextBudget: 32000,
      affinityPreset: 'code-focused',
      councilRole: null,
    });
    assert.equal(entry.name, 'ollama');
    assert.equal(entry.type, 'api');
    assert.equal(entry.baseUrl, 'http://localhost:11434/v1');
    assert.equal(entry.model, 'mixtral:8x7b');
    assert.equal(entry.councilRole, null);
  });

  it('uses default contextBudget when not provided', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api', affinityPreset: 'balanced' });
    assert.equal(entry.contextBudget, 32000);
  });

  it('uses default contextBudget for zero', () => {
    const entry = buildCustomAgentEntry({
      name: 'test',
      type: 'api',
      contextBudget: 0,
      affinityPreset: 'balanced',
    });
    assert.equal(entry.contextBudget, 32000);
  });

  it('uses default contextBudget for negative', () => {
    const entry = buildCustomAgentEntry({
      name: 'test',
      type: 'api',
      contextBudget: -100,
      affinityPreset: 'balanced',
    });
    assert.equal(entry.contextBudget, 32000);
  });

  it('uses default contextBudget for NaN', () => {
    const entry = buildCustomAgentEntry({
      name: 'test',
      type: 'api',
      contextBudget: Number.NaN,
      affinityPreset: 'balanced',
    });
    assert.equal(entry.contextBudget, 32000);
  });

  it('defaults to balanced affinity for unknown preset', () => {
    const entry = buildCustomAgentEntry({
      name: 'test',
      type: 'api',
      affinityPreset: 'nonexistent-preset',
    });
    assert.ok(entry.taskAffinity != null);
  });

  it('defaults to balanced when affinityPreset is undefined', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api' });
    assert.ok(entry.taskAffinity != null);
  });

  it('uses displayName when provided', () => {
    const entry = buildCustomAgentEntry({
      name: 'test',
      type: 'api',
      displayName: 'My Test Agent',
    });
    assert.equal(entry.displayName, 'My Test Agent');
  });

  it('falls back to name for displayName', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api' });
    assert.equal(entry.displayName, 'test');
  });

  it('defaults councilRole to null', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api' });
    assert.equal(entry.councilRole, null);
  });

  it('defaults enabled to true', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api' });
    assert.equal(entry.enabled, true);
  });

  it('respects enabled: false', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api', enabled: false });
    assert.equal(entry.enabled, false);
  });

  it('CLI entry defaults cmd to empty string', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'cli' });
    assert.equal(entry.invoke.nonInteractive.cmd, '');
  });

  it('CLI entry defaults argsTemplate to {prompt}', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'cli' });
    assert.deepEqual(entry.invoke.nonInteractive.args, ['{prompt}']);
  });

  it('API entry defaults baseUrl and model', () => {
    const entry = buildCustomAgentEntry({ name: 'test', type: 'api' });
    assert.equal(entry.baseUrl, 'http://localhost:11434/v1');
    assert.equal(entry.model, 'default');
  });
});

describe('runAgentsWizard', () => {
  it('runs the full CLI wizard flow', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    const { mockRl } = setupMockRl(
      ['my-test-agent', 'gh', 'copilot suggest -p {prompt}', '16000'],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'skip' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockSaveHydraConfig.mock.callCount() > 0, 'config saved');
  });

  it('retries on invalid agent name', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    const { mockRl } = setupMockRl(
      ['claude', 'my-valid-agent', 'aider', '{prompt}', ''],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'skip' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockSaveHydraConfig.mock.callCount() > 0);
  });

  it('runs the API wizard flow', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    const { mockRl } = setupMockRl(
      ['ollama-test', 'http://localhost:11434/v1', 'mixtral:8x7b', '64000'],
      [{ value: 'api' }, { value: 'research-focused' }, { value: 'analyst' }],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockSaveHydraConfig.mock.callCount() > 0);
  });

  it('handles MCP auto-detect with known CLI path', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    mockRegisterMcp.mock.mockImplementation((): any => ({ status: 'added' }));
    const { mockRl } = setupMockRl(
      ['test-mcp', 'gh', '{prompt}', ''],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'auto' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockRegisterMcp.mock.callCount() > 0);
  });

  it('handles MCP manual-path option', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    mockRegisterMcp.mock.mockImplementation((): any => ({ status: 'updated' }));
    const { mockRl } = setupMockRl(
      ['test-manual', 'my-cli', '{prompt}', '', '/home/user/.config/my-cli.json', 'json'],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'manual-path' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockRegisterMcp.mock.callCount() > 0);
  });

  it('handles existing agent (update path)', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockLoadHydraConfig.mock.mockImplementation((): any => ({
      agents: {
        customAgents: [{ name: 'existing-agent', type: 'api', baseUrl: 'http://old' }],
      },
      routing: { mode: 'balanced' },
    }));
    const { mockRl } = setupMockRl(
      ['existing-agent', 'http://localhost:11434/v1', 'new-model', ''],
      [{ value: 'api' }, { value: 'balanced' }, { value: null }],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockSaveHydraConfig.mock.callCount() > 0);
    // Reset default
    mockLoadHydraConfig.mock.mockImplementation((): any => ({
      agents: { customAgents: [] },
      routing: { mode: 'balanced' },
    }));
  });

  it('handles MCP exists status', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    mockRegisterMcp.mock.mockImplementation((): any => ({ status: 'exists' }));
    const { mockRl } = setupMockRl(
      ['test-exists', 'gh', '{prompt}', ''],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'auto' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockRegisterMcp.mock.callCount() > 0);
  });

  it('handles MCP error/manual instructions', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    mockRegisterMcp.mock.mockImplementation((): any => ({
      status: 'error',
      instructions: 'Run: npx hydra-setup\nThen restart',
    }));
    const { mockRl } = setupMockRl(
      ['test-err', 'gh', '{prompt}', ''],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'auto' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(true); // should complete without throwing
  });

  it('shows manual MCP instructions when skip chosen for CLI', async () => {
    mockSaveHydraConfig.mock.resetCalls();
    mockRegisterMcp.mock.resetCalls();
    mockRegisterMcp.mock.mockImplementation((): any => ({
      status: 'manual',
      instructions: 'Add to config manually',
    }));
    const { mockRl } = setupMockRl(
      ['test-skip', 'my-tool', '{prompt}', ''],
      [
        { value: 'cli' },
        { value: 'plaintext' },
        { value: 'balanced' },
        { value: null },
        { value: 'skip' },
      ],
    );
    await runAgentsWizard(mockRl);
    assert.ok(mockRegisterMcp.mock.callCount() > 0);
  });
});
