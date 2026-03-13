import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _setTestConfig,
  _setTestConfigPath,
  getProviderTier,
  getRoleConfig,
  invalidateConfigCache,
  loadHydraConfig,
  resolveProject,
  saveHydraConfig,
} from '../lib/hydra-config.ts';

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
