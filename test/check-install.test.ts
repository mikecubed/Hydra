import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { checkInstall, REQUIRED_JS_ARTIFACTS } from '../lib/check-install.ts';

describe('check-install guard', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-check-install-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes when all JS artifacts are present (tarball/registry install)', () => {
    for (const rel of REQUIRED_JS_ARTIFACTS) {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, '// stub');
    }

    const result = checkInstall(tmpDir, '/some/other/project');
    assert.equal(result.ok, true);
    assert.equal(result.reason, undefined);
  });

  it('passes for dev install when artifacts are missing but INIT_CWD matches root', () => {
    const result = checkInstall(tmpDir, tmpDir);
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'dev-install');
  });

  it('passes when INIT_CWD is undefined (not running under npm lifecycle)', () => {
    const result = checkInstall(tmpDir, null);
    assert.equal(result.ok, true);
    assert.equal(result.reason, 'dev-install');
  });

  it('fails for folder install when artifacts missing and INIT_CWD differs', () => {
    const result = checkInstall(tmpDir, '/some/other/project');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-artifacts');
  });

  it('fails when only some artifacts are present and INIT_CWD differs', () => {
    const firstArtifact = REQUIRED_JS_ARTIFACTS[0];
    assert.ok(firstArtifact, 'expected at least one required artifact');
    const full = path.join(tmpDir, firstArtifact);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// stub');

    const result = checkInstall(tmpDir, '/some/other/project');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-artifacts');
  });

  it('REQUIRED_JS_ARTIFACTS contains the expected bin entry points', () => {
    assert.ok(REQUIRED_JS_ARTIFACTS.length >= 3, 'should have at least 3 entries');
    assert.ok(
      REQUIRED_JS_ARTIFACTS.every((r) => r.endsWith('.js')),
      'all artifacts should be .js files',
    );
  });
});
