import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENTS,
  AGENT_NAMES,
  KNOWN_OWNERS,
  TASK_TYPES,
  getAgent,
  bestAgentFor,
  classifyTask,
} from '../lib/hydra-agents.mjs';

// ── AGENTS registry ──────────────────────────────────────────────────────────

test('AGENTS has exactly three agents: gemini, codex, claude', () => {
  assert.deepEqual(new Set(Object.keys(AGENTS)), new Set(['gemini', 'codex', 'claude']));
});

test('AGENT_NAMES matches AGENTS keys', () => {
  assert.deepEqual(AGENT_NAMES.sort(), Object.keys(AGENTS).sort());
});

test('KNOWN_OWNERS includes all agents plus human and unassigned', () => {
  for (const agent of AGENT_NAMES) {
    assert.ok(KNOWN_OWNERS.has(agent), `${agent} should be a known owner`);
  }
  assert.ok(KNOWN_OWNERS.has('human'));
  assert.ok(KNOWN_OWNERS.has('unassigned'));
});

test('TASK_TYPES has all seven types', () => {
  assert.equal(TASK_TYPES.length, 7);
  const expected = ['planning', 'architecture', 'review', 'refactor', 'implementation', 'analysis', 'testing'];
  assert.deepEqual(TASK_TYPES, expected);
});

// ── Agent structure ──────────────────────────────────────────────────────────

test('each agent has required fields', () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    assert.ok(agent.label, `${name} should have a label`);
    assert.ok(agent.cli, `${name} should have a cli command`);
    assert.ok(agent.invoke, `${name} should have invoke methods`);
    assert.ok(typeof agent.invoke.nonInteractive === 'function', `${name} should have nonInteractive invoke`);
    assert.ok(typeof agent.invoke.interactive === 'function', `${name} should have interactive invoke`);
    assert.ok(typeof agent.contextBudget === 'number', `${name} should have contextBudget`);
    assert.ok(agent.contextTier, `${name} should have contextTier`);
    assert.ok(Array.isArray(agent.strengths), `${name} should have strengths array`);
    assert.ok(Array.isArray(agent.weaknesses), `${name} should have weaknesses array`);
    assert.ok(agent.councilRole, `${name} should have councilRole`);
    assert.ok(agent.taskAffinity, `${name} should have taskAffinity`);
    assert.ok(agent.rolePrompt, `${name} should have rolePrompt`);
    assert.ok(typeof agent.timeout === 'number', `${name} should have timeout`);
  }
});

test('all agents have affinity scores for all task types', () => {
  for (const [name, agent] of Object.entries(AGENTS)) {
    for (const taskType of TASK_TYPES) {
      const score = agent.taskAffinity[taskType];
      assert.ok(typeof score === 'number', `${name} should have affinity for ${taskType}`);
      assert.ok(score >= 0 && score <= 1, `${name}.taskAffinity.${taskType} should be 0-1, got ${score}`);
    }
  }
});

test('agent context tiers are assigned correctly', () => {
  assert.equal(AGENTS.claude.contextTier, 'medium');
  assert.equal(AGENTS.gemini.contextTier, 'large');
  assert.equal(AGENTS.codex.contextTier, 'minimal');
});

test('agent council roles are distinct', () => {
  const roles = AGENT_NAMES.map((n) => AGENTS[n].councilRole);
  assert.equal(new Set(roles).size, roles.length, 'Council roles should be unique');
});

// ── getAgent ─────────────────────────────────────────────────────────────────

test('getAgent returns agent config for known agents', () => {
  for (const name of AGENT_NAMES) {
    const agent = getAgent(name);
    assert.ok(agent, `getAgent(${name}) should return agent`);
    assert.equal(agent.cli, name === 'claude' ? 'claude' : name);
  }
});

test('getAgent returns null for unknown agents', () => {
  assert.equal(getAgent('nonexistent'), null);
  assert.equal(getAgent(''), null);
  assert.equal(getAgent(null), null);
});

// ── bestAgentFor ─────────────────────────────────────────────────────────────

test('bestAgentFor returns correct agents for each task type', () => {
  // Claude excels at planning and architecture
  assert.equal(bestAgentFor('planning'), 'claude');
  assert.equal(bestAgentFor('architecture'), 'claude');

  // Gemini excels at analysis and review
  assert.equal(bestAgentFor('analysis'), 'gemini');
  assert.equal(bestAgentFor('review'), 'gemini');

  // Codex excels at implementation and testing
  assert.equal(bestAgentFor('implementation'), 'codex');
  assert.equal(bestAgentFor('testing'), 'codex');
});

test('bestAgentFor returns a valid agent name for all task types', () => {
  for (const taskType of TASK_TYPES) {
    const agent = bestAgentFor(taskType);
    assert.ok(AGENT_NAMES.includes(agent), `${agent} should be a valid agent for ${taskType}`);
  }
});

// ── classifyTask ─────────────────────────────────────────────────────────────

test('classifyTask detects planning tasks', () => {
  assert.equal(classifyTask('Plan the new authentication system'), 'planning');
  assert.equal(classifyTask('Design a strategy for migration'), 'planning');
  assert.equal(classifyTask('Break down the refactoring work'), 'planning');
});

test('classifyTask detects review tasks', () => {
  assert.equal(classifyTask('Review the PR for login flow'), 'review');
  assert.equal(classifyTask('Audit the security module'), 'review');
  assert.equal(classifyTask('Check for memory leaks'), 'review');
});

test('classifyTask detects refactor tasks', () => {
  assert.equal(classifyTask('Refactor the auth module'), 'refactor');
  assert.equal(classifyTask('Rename the handler class'), 'refactor');
  assert.equal(classifyTask('Extract shared utilities'), 'refactor');
});

test('classifyTask detects testing tasks', () => {
  assert.equal(classifyTask('Write tests for the API'), 'testing');
  assert.equal(classifyTask('Add coverage for the utils module'), 'testing');
  assert.equal(classifyTask('Create test spec for validation'), 'testing');
});

test('classifyTask detects analysis tasks', () => {
  assert.equal(classifyTask('Analyze the performance bottleneck'), 'analysis');
  assert.equal(classifyTask('Investigate the crash in production'), 'analysis');
  assert.equal(classifyTask('Find all usages of deprecated API'), 'analysis');
});

test('classifyTask detects architecture tasks', () => {
  // "design" matches planning before architecture; "schema" and "structure" match architecture
  assert.equal(classifyTask('Define the database schema migration'), 'architecture');
  assert.equal(classifyTask('Build the module structure layout'), 'architecture');
});

test('classifyTask defaults to implementation', () => {
  assert.equal(classifyTask('Add the login button'), 'implementation');
  assert.equal(classifyTask('Build the new feature'), 'implementation');
  assert.equal(classifyTask('Random text with no signals'), 'implementation');
});

test('classifyTask uses notes for classification', () => {
  assert.equal(classifyTask('Do the thing', 'review all changes carefully'), 'review');
  assert.equal(classifyTask('Work on it', 'write comprehensive tests'), 'testing');
});

// ── invoke methods ───────────────────────────────────────────────────────────

test('claude invoke produces correct CLI args', () => {
  const [cmd, args] = AGENTS.claude.invoke.nonInteractive('hello world');
  assert.equal(cmd, 'claude');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('hello world'));
  assert.ok(args.includes('--output-format'));
});

test('gemini invoke produces correct CLI args', () => {
  const [cmd, args] = AGENTS.gemini.invoke.nonInteractive('test prompt');
  assert.equal(cmd, 'gemini');
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('test prompt'));
});

test('codex invoke requires cwd option', () => {
  assert.throws(() => {
    AGENTS.codex.invoke.nonInteractive('test prompt');
  }, /cwd/i);
});

test('codex invoke produces correct CLI args with cwd', () => {
  const [cmd, args] = AGENTS.codex.invoke.nonInteractive('test prompt', { cwd: '/tmp/project' });
  assert.equal(cmd, 'codex');
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('-C'));
  assert.ok(args.includes('/tmp/project'));
});
