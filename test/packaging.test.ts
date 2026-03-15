/**
 * test/packaging.test.ts — Validate that `npm pack` produces a runnable artifact.
 *
 * Ensures the three public bin entries (hydra, hydra-client, hydra-daemon)
 * execute successfully from a fresh tarball install. This prevents regressions
 * where the published package exposes raw .ts entrypoints that Node cannot run
 * without native TypeScript support.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

describe('packaging', { timeout: 120_000 }, () => {
  let tmpDir: string;
  let tgzPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-pack-test-'));

    // Pack the project into a tarball
    execSync('npm pack', { cwd: ROOT, stdio: 'pipe', env: { ...process.env, HUSKY: '0' } });

    // Find the generated tarball (hydra-<version>.tgz)
    const tgzName = fs.readdirSync(ROOT).find((f) => f.startsWith('hydra-') && f.endsWith('.tgz'));
    assert.ok(tgzName, 'Expected a hydra-*.tgz file after npm pack');
    const srcTgz = path.join(ROOT, tgzName);
    tgzPath = path.join(tmpDir, tgzName);
    fs.renameSync(srcTgz, tgzPath);

    // Create a minimal package.json and install the tarball
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'pack-test', version: '0.0.0', private: true }),
    );
    execSync(`npm install "${tgzPath}" --no-save`, {
      cwd: tmpDir,
      stdio: 'pipe',
      env: { ...process.env, HUSKY: '0' },
    });
  });

  after(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tarball contains .js bin entrypoints alongside .ts source', () => {
    const binDir = path.join(tmpDir, 'node_modules', 'hydra', 'bin');
    const libDir = path.join(tmpDir, 'node_modules', 'hydra', 'lib');

    assert.ok(fs.existsSync(path.join(binDir, 'hydra-cli.js')), 'bin/hydra-cli.js missing');
    assert.ok(fs.existsSync(path.join(binDir, 'hydra-cli.ts')), 'bin/hydra-cli.ts missing');
    assert.ok(
      fs.existsSync(path.join(libDir, 'orchestrator-client.js')),
      'lib/orchestrator-client.js missing',
    );
    assert.ok(
      fs.existsSync(path.join(libDir, 'orchestrator-daemon.js')),
      'lib/orchestrator-daemon.js missing',
    );
  });

  it('.js bin files contain no .ts import specifiers', () => {
    const binJs = fs.readFileSync(
      path.join(tmpDir, 'node_modules', 'hydra', 'bin', 'hydra-cli.js'),
      'utf8',
    );
    const tsImports = binJs.match(/from\s+['"][^'"]*\.ts['"]/g);
    assert.equal(tsImports, null, `Found .ts import specifiers: ${tsImports?.join(', ')}`);
  });

  it('hydra --help exits 0', () => {
    const result = execSync('npx hydra --help', {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(result.includes('Hydra CLI'), 'Expected help output');
  });

  it('hydra-client help exits 0', () => {
    const result = execSync('npx hydra-client help', {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(result.includes('orchestrator'), 'Expected client help output');
  });

  it('hydra-daemon help exits 0', () => {
    const result = execSync('npx hydra-daemon help', {
      cwd: tmpDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(result.includes('Daemon'), 'Expected daemon help output');
  });

  it('package.json bin entries point to .js files', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'node_modules', 'hydra', 'package.json'), 'utf8'),
    );
    for (const [name, target] of Object.entries(pkg.bin as Record<string, string>)) {
      assert.ok(target.endsWith('.js'), `bin.${name} should end with .js, got: ${target}`);
    }
  });
});
