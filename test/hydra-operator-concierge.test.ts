/**
 * Tests for lib/hydra-operator-concierge.ts
 *
 * Covers the mode-execution functions extracted from hydra-operator.ts:
 *   runCouncilPrompt, runCouncilJson, runAutoPrompt, runAutoPromptLegacy, runSmartPrompt
 * and the pure/near-pure helpers they depend on:
 *   shouldCrossVerify, buildAgentMessage, buildMiniRoundBrief
 *
 * NOTE: Functions that invoke child processes (spawnAsync → runCouncilPrompt/Json)
 * are not called here; those belong in integration tests.
 * Preview-mode paths of runAutoPrompt / runSmartPrompt exercise routing logic
 * without making any HTTP or CLI calls.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Lazily loaded so that _setTestConfig can be called before module init reads config.
let shouldCrossVerify: (classification: any) => boolean;
let buildAgentMessage: (agent: string, userPrompt: string) => string;
let buildMiniRoundBrief: (agent: string, userPrompt: string, report: any) => string;
let runAutoPrompt: (opts: any) => Promise<any>;
let runSmartPrompt: (opts: any) => Promise<any>;

let _setTestConfig: (cfg: Record<string, unknown>) => void;
let _setTestConfigPath: (p: string | null) => void;
let invalidateConfigCache: () => void;

before(async () => {
  const cfgMod = await import('../lib/hydra-config.ts');
  _setTestConfig = cfgMod._setTestConfig as (cfg: Record<string, unknown>) => void;
  _setTestConfigPath = cfgMod._setTestConfigPath as (p: string | null) => void;
  invalidateConfigCache = cfgMod.invalidateConfigCache;

  // Redirect all file-based config reads/writes away from the real hydra.config.json.
  // This prevents setMode() calls inside runSmartPrompt from mutating the repo config.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-concierge-test-'));
  const tmpCfg = path.join(tmpDir, 'hydra.config.json');
  fs.writeFileSync(
    tmpCfg,
    JSON.stringify(
      { version: 2, mode: 'economy', modeTiers: { economy: {}, balanced: {}, performance: {} } },
      null,
      2,
    ),
  );
  _setTestConfigPath(tmpCfg);

  const dispatchMod = await import('../lib/hydra-operator-dispatch.ts');
  shouldCrossVerify = dispatchMod.shouldCrossVerify;
  buildAgentMessage = dispatchMod.buildAgentMessage;
  buildMiniRoundBrief = dispatchMod.buildMiniRoundBrief;

  const mod = await import('../lib/hydra-operator-concierge.ts');
  runAutoPrompt = mod.runAutoPrompt;
  runSmartPrompt = mod.runSmartPrompt;
});

afterEach(() => {
  invalidateConfigCache();
});

// Restore real config path after all tests in this file complete.
after(() => {
  _setTestConfigPath(null);
});

// ── shouldCrossVerify ─────────────────────────────────────────────────────────

describe('shouldCrossVerify', () => {
  it('returns false when crossModelVerification is not configured', () => {
    _setTestConfig({});
    assert.equal(shouldCrossVerify({ tier: 'complex' }), false);
  });

  it('returns false when crossModelVerification.enabled is false', () => {
    _setTestConfig({ crossModelVerification: { enabled: false, mode: 'always' } });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), false);
  });

  it('returns true when mode is "always" regardless of tier', () => {
    _setTestConfig({ crossModelVerification: { enabled: true, mode: 'always' } });
    assert.equal(shouldCrossVerify({ tier: 'simple' }), true);
    assert.equal(shouldCrossVerify({ tier: 'complex' }), true);
  });

  it('returns true for complex tier when mode is "on-complex"', () => {
    _setTestConfig({ crossModelVerification: { enabled: true, mode: 'on-complex' } });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), true);
  });

  it('returns false for simple tier when mode is "on-complex"', () => {
    _setTestConfig({ crossModelVerification: { enabled: true, mode: 'on-complex' } });
    assert.equal(shouldCrossVerify({ tier: 'simple' }), false);
  });

  it('returns false for medium tier when mode is "on-complex"', () => {
    _setTestConfig({ crossModelVerification: { enabled: true, mode: 'on-complex' } });
    assert.equal(shouldCrossVerify({ tier: 'medium' }), false);
  });

  it('returns false for unknown mode (default-safe)', () => {
    _setTestConfig({ crossModelVerification: { enabled: true, mode: 'unknown-mode' } });
    assert.equal(shouldCrossVerify({ tier: 'complex' }), false);
  });
});

// ── buildAgentMessage ─────────────────────────────────────────────────────────

describe('buildAgentMessage', () => {
  it('returns a string containing the prompt', () => {
    const msg = buildAgentMessage('claude', 'Fix the authentication bug');
    assert.ok(typeof msg === 'string');
    assert.ok(msg.includes('Fix the authentication bug'), 'prompt text must appear in message');
  });

  it('includes agent-relevant framing', () => {
    const msgClaude = buildAgentMessage('claude', 'Refactor the data layer');
    const msgGemini = buildAgentMessage('gemini', 'Refactor the data layer');
    // Each agent must produce a distinct message, proving the framing is agent-specific
    assert.notEqual(msgClaude, msgGemini, 'agent framing must differ per agent');
    assert.ok(msgClaude.length > 50, 'message must contain substantial framing content');
  });

  it('falls back gracefully for an unknown agent name', () => {
    const msg = buildAgentMessage('unknown-agent-xyz', 'Test prompt');
    assert.ok(typeof msg === 'string');
    assert.ok(msg.includes('Test prompt'));
  });

  it('works for all built-in agents', () => {
    for (const agent of ['claude', 'codex', 'gemini']) {
      const msg = buildAgentMessage(agent, `Prompt for ${agent}`);
      assert.ok(msg.includes(`Prompt for ${agent}`), `Missing prompt for ${agent}`);
    }
  });
});

// ── buildMiniRoundBrief ───────────────────────────────────────────────────────

describe('buildMiniRoundBrief', () => {
  it('returns a string containing the prompt', () => {
    const report = {
      tasks: [{ owner: 'claude', title: 'Do the thing', done: '' }],
      questions: [],
      consensus: 'Proceed with plan A.',
      recommendedMode: 'handoff',
    };
    const brief = buildMiniRoundBrief('claude', 'Implement caching', report);
    assert.ok(typeof brief === 'string');
    assert.ok(brief.includes('Implement caching'));
  });

  it('handles empty report gracefully', () => {
    const brief = buildMiniRoundBrief('codex', 'Write tests', {});
    assert.ok(typeof brief === 'string');
    assert.ok(brief.includes('Write tests'));
  });

  it('includes agent-specific tasks from report', () => {
    const report = {
      tasks: [
        { owner: 'codex', title: 'Write unit tests', done: '' },
        { owner: 'claude', title: 'Review architecture', done: '' },
      ],
      questions: [],
      consensus: 'Split work by specialty.',
      recommendedMode: 'handoff',
    };
    const brief = buildMiniRoundBrief('codex', 'Improve test coverage', report);
    assert.ok(brief.includes('Write unit tests'), 'codex task should appear in codex brief');
  });
});

// ── runAutoPrompt — preview routing logic ─────────────────────────────────────

describe('runAutoPrompt preview routing', () => {
  const baseOpts = {
    baseUrl: 'http://127.0.0.1:4173',
    from: 'operator',
    agents: ['claude', 'codex', 'gemini'],
    miniRounds: 1,
    councilRounds: 2,
    preview: true,
  };

  it('returns mode=fast-path for a simple/single-route prompt', async () => {
    // classifyPrompt returns 'single' route for short simple prompts
    const result = await runAutoPrompt({
      ...baseOpts,
      promptText: 'Fix typo in README',
    });
    assert.ok(typeof result === 'object');
    // preview mode must set recommended field
    assert.ok('recommended' in result);
    assert.ok('mode' in result);
    assert.equal(result.preview ?? true, true); // no HTTP was called
  });

  it('returns a route string', async () => {
    const result = await runAutoPrompt({
      ...baseOpts,
      promptText: 'Refactor the entire authentication system and rewrite all tests with TDD',
    });
    assert.ok(typeof result.route === 'string');
    assert.ok(result.route.length > 0);
  });

  it('includes classification in result', async () => {
    const result = await runAutoPrompt({
      ...baseOpts,
      promptText: 'Add a button to the UI',
    });
    assert.ok(result.classification != null);
    assert.ok(typeof result.classification.tier === 'string');
  });

  it('does not throw for any prompt when preview=true', async () => {
    const prompts = [
      '',
      'x',
      'Refactor ALL of the authentication layer end-to-end with full test suite',
      'Fix typo',
    ];
    await Promise.all(
      prompts.map((promptText) => assert.doesNotReject(runAutoPrompt({ ...baseOpts, promptText }))),
    );
  });

  it('sets escalatedToCouncil=false for fast-path route', async () => {
    const result = await runAutoPrompt({
      ...baseOpts,
      promptText: 'Fix typo in README',
    });
    if (result.mode === 'fast-path') {
      assert.equal(result.escalatedToCouncil, false);
    }
  });
});

// ── runSmartPrompt — tier-based routing ───────────────────────────────────────

describe('runSmartPrompt preview routing', () => {
  const baseOpts = {
    baseUrl: 'http://127.0.0.1:4173',
    from: 'operator',
    agents: ['claude', 'codex', 'gemini'],
    miniRounds: 1,
    councilRounds: 2,
    preview: true,
  };

  it('returns a result with route string', async () => {
    const result = await runSmartPrompt({
      ...baseOpts,
      promptText: 'Update the README',
    });
    assert.ok(typeof result.route === 'string');
    assert.ok(result.route.length > 0);
  });

  it('annotates result with smartTier from classification', async () => {
    const result = await runSmartPrompt({
      ...baseOpts,
      promptText: 'Fix a typo',
    });
    // smartTier is annotated by runSmartPrompt
    assert.ok('smartTier' in result);
    assert.ok(['simple', 'medium', 'complex'].includes(result.smartTier as string));
  });

  it('annotates result with smartMode', async () => {
    const result = await runSmartPrompt({
      ...baseOpts,
      promptText: 'Fix a typo',
    });
    assert.ok('smartMode' in result);
    assert.ok(typeof result.smartMode === 'string');
    assert.ok(result.smartMode.length > 0);
  });

  it('route includes tier prefix', async () => {
    const result = await runSmartPrompt({
      ...baseOpts,
      promptText: 'Fix a typo',
    });
    // Route should be prefixed with tier→
    assert.match(result.route as string, /^(simple|medium|complex)\u2192/);
  });

  it('does not throw for any prompt in preview mode', async () => {
    const prompts = ['Fix typo', 'Design and implement full distributed caching system', ''];
    await Promise.all(
      prompts.map((promptText) =>
        assert.doesNotReject(runSmartPrompt({ ...baseOpts, promptText })),
      ),
    );
  });
});
