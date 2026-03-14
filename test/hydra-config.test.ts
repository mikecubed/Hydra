import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AFFINITY_PRESETS,
  _setTestConfig,
  _setTestConfigPath,
  diffConfig,
  getProviderPresets,
  getProviderTier,
  getRoleConfig,
  invalidateConfigCache,
  loadHydraConfig,
  resolveProject,
  saveHydraConfig,
} from '../lib/hydra-config.ts';
import {
  _resetRegistry,
  getActiveModel,
  getAgent,
  initAgentRegistry,
} from '../lib/hydra-agents.ts';

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-config-test-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  invalidateConfigCache();
  _setTestConfigPath(null);
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
  // Restore the registry to the default physical-agents-only state so custom
  // agents registered within a test don't bleed into subsequent tests.
  _resetRegistry();
  initAgentRegistry();
});

describe('hydra-config core behavior', () => {
  it('loads merged defaults when the redirected config file does not exist', () => {
    const tempDir = makeTempDir();
    _setTestConfigPath(path.join(tempDir, 'missing.config.json'));

    const config = loadHydraConfig();

    assert.equal(config.version, 2);
    assert.ok(config.models);
    assert.ok(config.roles);
    assert.ok(config.routing);
  });

  it('saves merged config and reloads it from the redirected config path', () => {
    const tempDir = makeTempDir();
    const configPath = path.join(tempDir, 'hydra.config.json');
    _setTestConfigPath(configPath);

    const saved = saveHydraConfig({
      mode: 'balanced',
      providers: {
        openai: { tier: 3 },
      },
    });

    invalidateConfigCache();
    const reloaded = loadHydraConfig();
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;

    assert.equal(saved.mode, 'balanced');
    assert.equal(reloaded.mode, 'balanced');
    assert.equal(getProviderTier('openai'), 3);
    assert.equal(raw['version'], 2);
  });

  it('merges role overrides with defaults', () => {
    _setTestConfig({
      roles: {
        architect: { model: 'custom-architect-model' },
      },
    });

    const role = getRoleConfig('architect');

    assert.ok(role);
    assert.equal(role.model, 'custom-architect-model');
    assert.ok(role.agent);
  });

  it('returns provider-tier defaults and respects provider overrides', () => {
    _setTestConfig({});
    assert.equal(getProviderTier('google'), 'free');
    assert.equal(getProviderTier('openai'), 1);

    invalidateConfigCache();
    _setTestConfig({
      providers: {
        openai: { tier: 2 },
      },
    });

    assert.equal(getProviderTier('openai'), 2);
  });

  it('resolves project metadata and derived coordination paths from an explicit project root', () => {
    const projectRoot = makeTempDir();
    fs.writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'hydra-config-fixture' }),
      'utf8',
    );

    const project = resolveProject({ project: projectRoot });

    assert.equal(project.projectRoot, projectRoot);
    assert.equal(project.projectName, 'hydra-config-fixture');
    assert.equal(project.coordDir, path.join(projectRoot, 'docs', 'coordination'));
    assert.equal(project.runsDir, path.join(project.coordDir, 'runs'));
    assert.ok(project.hydraRoot.length > 0);
  });

  it('rejects invalid project directories unless validation is skipped', () => {
    const projectRoot = makeTempDir();

    assert.throws(() => {
      resolveProject({ project: projectRoot });
    }, /Not a valid project directory/);

    const skipped = resolveProject({ project: projectRoot, skipValidation: true });
    assert.equal(skipped.projectRoot, projectRoot);
  });
});

// ── Provider tier merging ─────────────────────────────────────────────────────

describe('getActiveModel — provider tier merging', () => {
  it("resolves the 'default' tier model when active is 'default'", () => {
    _setTestConfig({
      mode: 'performance',
      models: {
        claude: {
          default: 'claude-sonnet-4-6',
          fast: 'claude-sonnet-4-5-20250929',
          cheap: 'claude-haiku-4-5-20251001',
          active: 'default',
        },
      },
    });

    assert.equal(getActiveModel('claude'), 'claude-sonnet-4-6');
  });

  it("resolves the 'fast' tier model when active is 'fast'", () => {
    _setTestConfig({
      mode: 'performance',
      models: {
        claude: {
          default: 'claude-sonnet-4-6',
          fast: 'claude-sonnet-4-5-20250929',
          cheap: 'claude-haiku-4-5-20251001',
          active: 'fast',
        },
      },
    });

    assert.equal(getActiveModel('claude'), 'claude-sonnet-4-5-20250929');
  });

  it("resolves the 'cheap' tier model when active is 'cheap'", () => {
    _setTestConfig({
      mode: 'performance',
      models: {
        claude: {
          default: 'claude-sonnet-4-6',
          fast: 'claude-sonnet-4-5-20250929',
          cheap: 'claude-haiku-4-5-20251001',
          active: 'cheap',
        },
      },
    });

    assert.equal(getActiveModel('claude'), 'claude-haiku-4-5-20251001');
  });

  it('returns null for an agent not present in models', () => {
    _setTestConfig({ models: {} });

    assert.equal(getActiveModel('nonexistent-agent'), null);
  });
});

// ── Role config lookups ───────────────────────────────────────────────────────

describe('getRoleConfig — role config lookups', () => {
  it("returns architect default: agent 'claude', model null", () => {
    _setTestConfig({});

    const role = getRoleConfig('architect');

    assert.ok(role, 'architect role must exist');
    assert.equal(role.agent, 'claude');
    assert.equal(role.model, null);
    assert.equal(role.reasoningEffort, null);
  });

  it("returns analyst default: agent 'gemini', model null", () => {
    _setTestConfig({});

    const role = getRoleConfig('analyst');

    assert.ok(role, 'analyst role must exist');
    assert.equal(role.agent, 'gemini');
    assert.equal(role.model, null);
    assert.equal(role.reasoningEffort, null);
  });

  it("returns implementer default: agent 'codex', model null", () => {
    _setTestConfig({});

    const role = getRoleConfig('implementer');

    assert.ok(role, 'implementer role must exist');
    assert.equal(role.agent, 'codex');
    assert.equal(role.model, null);
    assert.equal(role.reasoningEffort, null);
  });

  it('returns undefined for an unknown role name', () => {
    _setTestConfig({});

    assert.equal(getRoleConfig('totally-unknown-role'), undefined);
  });
});

// ── Project context resolution ────────────────────────────────────────────────

describe('loadHydraConfig — project context resolution', () => {
  it('reads a redirected temp config file and returns its merged values', () => {
    const tempDir = makeTempDir();
    const cfgPath = path.join(tempDir, 'local.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ version: 2, mode: 'economy' }), 'utf8');
    _setTestConfigPath(cfgPath);

    const config = loadHydraConfig();

    assert.equal(config.mode, 'economy');
    assert.equal(config.version, 2);
    // Defaults are still merged in
    assert.ok(config.models, 'models section must be present from defaults');
    assert.ok(config.routing, 'routing section must be present from defaults');
  });

  it('returns version:2 defaults when redirected file contains invalid JSON', () => {
    const tempDir = makeTempDir();
    const cfgPath = path.join(tempDir, 'broken.config.json');
    fs.writeFileSync(cfgPath, '{ this is not valid json', 'utf8');
    _setTestConfigPath(cfgPath);

    // Must not throw — graceful degradation
    const config = loadHydraConfig();

    assert.equal(config.version, 2);
    assert.ok(config.models);
    assert.ok(config.routing);
  });
});

// ── Budget gate thresholds ────────────────────────────────────────────────────

describe('getRoleConfig — budget gate thresholds', () => {
  it('returns the same role shape regardless of dailyTokenBudget=0 (blocked)', () => {
    _setTestConfig({ usage: { dailyTokenBudget: { 'claude-opus-4-6': 0 } } });

    const role = getRoleConfig('architect');

    // getRoleConfig exposes the structural config only; budget enforcement is
    // handled by the dispatcher, not here. Shape must stay stable.
    assert.ok(role);
    assert.equal(role.agent, 'claude');
    // model is null by default (agent uses its own active model)
    assert.equal(role.model, null);
  });

  it('returns the same role shape when dailyTokenBudget is set to a large value (open)', () => {
    _setTestConfig({ usage: { dailyTokenBudget: { 'claude-opus-4-6': 999_999_999 } } });

    const role = getRoleConfig('architect');

    assert.ok(role);
    assert.equal(role.agent, 'claude');
  });

  it('exposes usage.dailyTokenBudget values through loadHydraConfig', () => {
    _setTestConfig({ usage: { dailyTokenBudget: { 'claude-opus-4-6': 0 } } });

    const cfg = loadHydraConfig();

    assert.equal(cfg.usage.dailyTokenBudget?.['claude-opus-4-6'], 0);
  });
});

// ── Custom agent resolution ───────────────────────────────────────────────────

describe('getAgent — custom agent resolution', () => {
  it('resolves a custom CLI agent registered via agents.customAgents', () => {
    _setTestConfig({
      agents: {
        customAgents: [
          {
            name: 'myagent',
            type: 'cli',
            invoke: { headless: { cmd: 'myagent', args: [] } },
          },
        ],
      },
    });
    _resetRegistry();
    initAgentRegistry();

    const agent = getAgent('myagent');

    assert.ok(agent, 'custom agent must be found');
    assert.equal(agent.name, 'myagent');
    assert.equal(agent.type, 'physical');
    assert.equal(agent.customType, 'cli');
    assert.equal(agent.cli, 'myagent');
    assert.equal(agent.enabled, true);
  });

  it('returns null for an agent name absent from config and registry', () => {
    _setTestConfig({});
    _resetRegistry();
    initAgentRegistry();

    assert.equal(getAgent('no-such-agent'), null);
  });
});

// ── Missing/invalid config graceful degradation ───────────────────────────────

describe('loadHydraConfig — missing config graceful degradation', () => {
  it('returns defaults without throwing when config file is missing', () => {
    const tempDir = makeTempDir();
    _setTestConfigPath(path.join(tempDir, 'does-not-exist.json'));

    let config: ReturnType<typeof loadHydraConfig> | undefined;
    assert.doesNotThrow(() => {
      config = loadHydraConfig();
    });

    assert.ok(config);
    assert.equal(config.version, 2);
    assert.ok(typeof config.mode === 'string', 'mode must default to a string');
    assert.ok(Object.keys(config.models).length > 0);
    assert.ok(Object.keys(config.roles as object).length > 0);
    assert.ok(typeof config.routing.mode === 'string');
    assert.ok(typeof config.usage.sessionBudget === 'number');
  });

  it('returns defaults without throwing when config file contains invalid JSON', () => {
    const tempDir = makeTempDir();
    const cfgPath = path.join(tempDir, 'invalid.json');
    fs.writeFileSync(cfgPath, '<<not json>>', 'utf8');
    _setTestConfigPath(cfgPath);

    let config: ReturnType<typeof loadHydraConfig> | undefined;
    assert.doesNotThrow(() => {
      config = loadHydraConfig();
    });

    assert.ok(config);
    assert.equal(config.version, 2);
  });

  it('default mode is a recognised HydraMode string', () => {
    const tempDir = makeTempDir();
    _setTestConfigPath(path.join(tempDir, 'missing.json'));

    const config = loadHydraConfig();

    const validModes = ['performance', 'balanced', 'economy', 'custom'];
    assert.ok(validModes.includes(config.mode), `unexpected default mode: ${config.mode}`);
  });
});

// ── diffConfig — missing keys ─────────────────────────────────────────────────

describe('diffConfig — missing keys', () => {
  it('reports a key present in defaults but absent from userConfig as missing', () => {
    const result = diffConfig({ version: 2 }, { version: 2, mode: 'balanced', extra: 'foo' });
    const paths = result.missing.map((m) => m.path);
    assert.ok(paths.includes('mode'), '"mode" must appear in missing');
    assert.ok(paths.includes('extra'), '"extra" must appear in missing');
  });

  it('returns empty missing array when userConfig matches all default top-level keys', () => {
    const ref = { version: 2 };
    const result = diffConfig({ version: 2 }, ref);
    assert.deepEqual(result.missing, []);
  });

  it('includes the defaultValue in each missing entry', () => {
    const result = diffConfig({}, { mode: 'balanced' });
    const modeEntry = result.missing.find((m) => m.path === 'mode');
    assert.ok(modeEntry, '"mode" must be in missing');
    assert.equal(modeEntry.defaultValue, 'balanced');
  });
});

// ── diffConfig — stale keys ───────────────────────────────────────────────────

describe('diffConfig — stale keys', () => {
  it('reports a key present in userConfig but absent from defaults as stale', () => {
    const result = diffConfig({ version: 2, obsoleteKey: 'old' }, { version: 2 });
    const paths = result.stale.map((s) => s.path);
    assert.ok(paths.includes('obsoleteKey'), '"obsoleteKey" must appear in stale');
  });

  it('returns empty stale array when no extra keys exist in userConfig', () => {
    const ref = { version: 2 };
    const result = diffConfig({ version: 2 }, ref);
    assert.deepEqual(result.stale, []);
  });

  it('includes the userValue in each stale entry', () => {
    const result = diffConfig({ extra: 42 }, {});
    const entry = result.stale.find((s) => s.path === 'extra');
    assert.ok(entry, '"extra" must be in stale');
    assert.equal(entry.userValue, 42);
  });
});

// ── diffConfig — type mismatches ──────────────────────────────────────────────

describe('diffConfig — type mismatches', () => {
  it('reports a type mismatch when user value type differs from default type', () => {
    const result = diffConfig({ version: 'two' }, { version: 2 });
    const mismatches = result.typeMismatches;
    assert.ok(mismatches.length > 0, 'must have at least one mismatch');
    const entry = mismatches.find((m) => m.path === 'version');
    assert.ok(entry, 'version must appear in typeMismatches');
    assert.equal(entry.expectedType, 'number');
    assert.equal(entry.gotType, 'string');
  });

  it('returns empty typeMismatches when types match', () => {
    const result = diffConfig({ version: 99 }, { version: 2 });
    assert.deepEqual(result.typeMismatches, []);
  });

  it('returns all three arrays in the result', () => {
    const result = diffConfig({}, {});
    assert.ok(Array.isArray(result.missing));
    assert.ok(Array.isArray(result.stale));
    assert.ok(Array.isArray(result.typeMismatches));
  });
});

// ── getProviderPresets — shape ────────────────────────────────────────────────

describe('getProviderPresets', () => {
  it('returns an array', () => {
    const presets = getProviderPresets();
    assert.ok(Array.isArray(presets));
  });

  it('every preset is a plain object', () => {
    const presets = getProviderPresets();
    for (const preset of presets) {
      assert.ok(preset !== null && typeof preset === 'object' && !Array.isArray(preset));
    }
  });
});

// ── AFFINITY_PRESETS — exported constant ──────────────────────────────────────

describe('AFFINITY_PRESETS', () => {
  it('exports a "balanced" preset', () => {
    assert.ok(AFFINITY_PRESETS['balanced'], '"balanced" preset must exist');
  });

  it('exports a "code-focused" preset', () => {
    assert.ok(AFFINITY_PRESETS['code-focused'], '"code-focused" preset must exist');
  });

  it('"balanced" preset has implementation key', () => {
    assert.ok(
      typeof AFFINITY_PRESETS['balanced']['implementation'] === 'number',
      '"implementation" must be a number',
    );
  });

  it('"code-focused" preset has implementation affinity > 0.5', () => {
    assert.ok(
      (AFFINITY_PRESETS['code-focused']['implementation'] ?? 0) > 0.5,
      '"code-focused" implementation affinity must favour code',
    );
  });

  it('all preset affinities are numbers between 0 and 1', () => {
    for (const [presetName, preset] of Object.entries(AFFINITY_PRESETS)) {
      for (const [key, value] of Object.entries(preset)) {
        assert.ok(
          typeof value === 'number' && value >= 0 && value <= 1,
          `${presetName}.${key} = ${String(value)} must be a number in [0,1]`,
        );
      }
    }
  });
});
