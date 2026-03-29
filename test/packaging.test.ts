/**
 * test/packaging.test.ts — Validate that `npm pack` produces a runnable artifact.
 *
 * Ensures the three public bin entries (hydra, hydra-client, hydra-daemon)
 * execute successfully from a fresh tarball install, and that the packed
 * package.json scripts reference .js entrypoints so `npm run` works.
 * This prevents regressions where the published package exposes raw .ts
 * entrypoints that Node cannot run without native TypeScript support.
 *
 * Also validates that the packaged web runtime (dist/web-runtime/) is included
 * with a bundled gateway server entry and built browser assets, and that
 * post-pack cleanup restores the source repo to its clean TypeScript-only state.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

describe('packaging', { timeout: 120_000 }, () => {
  let tmpDir: string;
  let tgzPath: string;
  /** Resolved path to the installed hydra package inside tmpDir. */
  let hydraPkgDir: string;
  /** Disposable repo copy where npm pack runs (prepack/postpack mutations stay here). */
  let repoClone: string;

  before(() => {
    // ── Isolation: copy the repo to a temp dir so prepack/postpack side-effects
    // (generated .js files, .packfiles, .package.json.bak) never touch the real
    // working tree.  This prevents races with other tests running concurrently.
    // We include apps/ and packages/ so the web runtime can be built and bundled
    // during prepack, but exclude nested node_modules (deps resolve via symlink).
    const excludeTopLevel = new Set([
      'node_modules',
      '.git',
      'test',
      'coverage',
      'dist',
      '.tsbuild',
      '.build-exe',
      '.pkg-cache',
    ]);

    repoClone = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-pack-repo-'));
    fs.cpSync(ROOT, repoClone, {
      recursive: true,
      filter: (src: string) => {
        const rel = path.relative(ROOT, src);
        if (rel === '') return true; // root dir itself
        const topSegment = rel.split(path.sep)[0];
        if (excludeTopLevel.has(topSegment)) return false;
        // Exclude nested node_modules inside workspace packages
        const segments = rel.split(path.sep);
        if (segments.length > 1 && segments.includes('node_modules')) return false;
        return true;
      },
    });

    // Symlink node_modules from the real repo (too heavy to copy).
    const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(
      path.join(ROOT, 'node_modules'),
      path.join(repoClone, 'node_modules'),
      symlinkType,
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-pack-test-'));

    // Pack from the isolated clone — all prepack/postpack mutations stay there
    const packOutput = execSync('npm pack', {
      cwd: repoClone,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env, HUSKY: '0' },
    });

    // npm pack prints the tarball filename on its last stdout line
    const tgzName = packOutput.trim().split('\n').pop()?.trim() ?? '';
    assert.ok(
      tgzName.endsWith('.tgz'),
      `Expected npm pack to output a .tgz filename, got: ${packOutput}`,
    );
    const srcTgz = path.join(repoClone, tgzName);
    tgzPath = path.join(tmpDir, tgzName);
    fs.renameSync(srcTgz, tgzPath);

    // Keep clone alive so tests can verify postpack cleanup ran correctly.

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

    hydraPkgDir = path.join(tmpDir, 'node_modules', 'hydra');
  });

  after(() => {
    if (repoClone) {
      fs.rmSync(repoClone, { recursive: true, force: true });
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('tarball contains .js bin entrypoints alongside .ts source', () => {
    const binDir = path.join(hydraPkgDir, 'bin');
    const libDir = path.join(hydraPkgDir, 'lib');

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
    const binJs = fs.readFileSync(path.join(hydraPkgDir, 'bin', 'hydra-cli.js'), 'utf8');
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
    const pkg = JSON.parse(fs.readFileSync(path.join(hydraPkgDir, 'package.json'), 'utf8'));
    for (const [name, target] of Object.entries(pkg.bin as Record<string, string>)) {
      assert.ok(target.endsWith('.js'), `bin.${name} should end with .js, got: ${target}`);
    }
  });

  it('packed package.json scripts reference .js for lib/bin entrypoints', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(hydraPkgDir, 'package.json'), 'utf8'));
    const libBinScripts = Object.entries(pkg.scripts as Record<string, string>).filter(([, v]) =>
      /\b(?:lib|bin)\//.test(v),
    );
    assert.ok(libBinScripts.length > 0, 'Expected at least one script referencing lib/ or bin/');
    for (const [name, cmd] of libBinScripts) {
      assert.ok(
        !/\b(?:lib|bin)\/[\w./-]*?\.ts\b/.test(cmd),
        `scripts.${name} still references .ts: ${cmd}`,
      );
    }
  });

  it('installed package "start" script runs daemon help via .js', () => {
    // Run the daemon's .js entrypoint directly with "help" — validates that
    // the compiled .js file and its import graph are functional.
    const result = execSync('node lib/orchestrator-daemon.js help', {
      cwd: hydraPkgDir,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    assert.ok(result.includes('Daemon'), 'Expected daemon help output from .js entrypoint');
  });

  it('source repo package.json is restored after pack (not mutated)', () => {
    // With isolated packing the real package.json was never touched, but verify
    // it still references .ts entrypoints as a belt-and-suspenders check.
    const repoPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(
      (repoPkg.scripts.start as string).includes('.ts'),
      'Repo scripts.start should reference .ts after postpack restore',
    );
    assert.ok(
      (repoPkg.scripts.go as string).includes('.ts'),
      'Repo scripts.go should reference .ts after postpack restore',
    );
  });

  // ── Web runtime packaging ────────────────────────────────────────────────

  it('tarball contains dist/web-runtime/server.js gateway entry', () => {
    const serverJs = path.join(hydraPkgDir, 'dist', 'web-runtime', 'server.js');
    assert.ok(fs.existsSync(serverJs), 'dist/web-runtime/server.js missing from tarball');
    const content = fs.readFileSync(serverJs, 'utf8');
    assert.ok(content.length > 0, 'dist/web-runtime/server.js is empty');
  });

  it('bundled gateway entry remains an ESM artifact', () => {
    const serverJs = path.join(hydraPkgDir, 'dist', 'web-runtime', 'server.js');
    const content = fs.readFileSync(serverJs, 'utf8');
    assert.ok(/\bimport\b/.test(content) || /\bexport\b/.test(content));
  });

  it('bundled gateway sets default HYDRA_WEB_STATIC_DIR for packaged layout', () => {
    const serverJs = path.join(hydraPkgDir, 'dist', 'web-runtime', 'server.js');
    const content = fs.readFileSync(serverJs, 'utf8');
    assert.ok(
      content.includes('HYDRA_WEB_STATIC_DIR'),
      'dist/web-runtime/server.js should reference HYDRA_WEB_STATIC_DIR for packaged static dir',
    );
  });

  it('tarball contains dist/web-runtime/web/ browser assets', () => {
    const webDir = path.join(hydraPkgDir, 'dist', 'web-runtime', 'web');
    assert.ok(fs.existsSync(webDir), 'dist/web-runtime/web/ missing from tarball');
    assert.ok(
      fs.existsSync(path.join(webDir, 'index.html')),
      'dist/web-runtime/web/index.html missing from tarball',
    );
  });

  it('tarball contains the packaged runtime marker', () => {
    const marker = path.join(hydraPkgDir, 'dist', 'web-runtime', '.packaged');
    assert.ok(fs.existsSync(marker), 'dist/web-runtime/.packaged missing from tarball');
  });

  it('bundled gateway entry is runnable', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-pack-state-'));
    const port = String(45_000 + Math.floor(Math.random() * 1000));
    const child = spawn(process.execPath, ['dist/web-runtime/server.js'], {
      cwd: hydraPkgDir,
      env: {
        ...process.env,
        HYDRA_WEB_GATEWAY_PORT: port,
        HYDRA_WEB_STATE_DIR: stateDir,
        HYDRA_DAEMON_URL: 'http://127.0.0.1:9',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for startup. Output: ${output}`));
        }, 10_000);
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (output.includes('Hydra web gateway listening on')) {
            clearTimeout(timer);
            resolve(undefined);
          }
        });
        child.stderr.on('data', (chunk) => {
          output += chunk.toString();
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Packaged server exited early with code ${String(code)}. Output: ${output}`));
        });
      });
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', () => resolve(undefined)));
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('tarball includes dist/web-runtime/ in package.json files', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(hydraPkgDir, 'package.json'), 'utf8'));
    const files = pkg.files as string[];
    assert.ok(
      files.some((f: string) => f.includes('dist/web-runtime')),
      `Expected "dist/web-runtime/" in files array, got: ${JSON.stringify(files)}`,
    );
  });

  it('postpack cleans dist/web-runtime/ in the packed clone', () => {
    // Verify that clean-pack.ts (postpack) actually removed dist/web-runtime/
    // inside the repo clone where npm pack ran — not in the untouched source repo.
    assert.ok(repoClone, 'repoClone should still exist for cleanup verification');
    const cloneWebRuntime = path.join(repoClone, 'dist', 'web-runtime');
    assert.ok(
      !fs.existsSync(cloneWebRuntime),
      'dist/web-runtime/ should be cleaned from the clone after postpack',
    );
  });

  it('packaging aborts when gateway exists but browser assets cannot be produced', () => {
    // Create a minimal clone where the gateway entry exists but apps/web/ has
    // no buildable source, verifying that build-pack.ts fails instead of
    // silently producing a tarball with server.js but no browser assets.
    const failClone = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-pack-fail-'));
    try {
      // Copy only the structural essentials — no apps/web/src/ so vite build fails
      fs.cpSync(ROOT, failClone, {
        recursive: true,
        filter: (src: string) => {
          const rel = path.relative(ROOT, src);
          if (rel === '') return true;
          const topSegment = rel.split(path.sep)[0];
          if (['node_modules', '.git', 'test', 'coverage', 'dist', '.tsbuild'].includes(topSegment))
            return false;
          const segments = rel.split(path.sep);
          if (segments.length > 1 && segments.includes('node_modules')) return false;
          // Exclude apps/web/src so vite build has nothing to compile
          if (rel.startsWith(path.join('apps', 'web', 'src'))) return false;
          return true;
        },
      });

      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(
        path.join(ROOT, 'node_modules'),
        path.join(failClone, 'node_modules'),
        symlinkType,
      );

      let exitCode: number | null = null;
      try {
        execSync('npm pack', {
          cwd: failClone,
          stdio: 'pipe',
          encoding: 'utf8',
          env: { ...process.env, HUSKY: '0' },
        });
        exitCode = 0;
      } catch {
        exitCode = 1;
      }

      assert.notEqual(
        exitCode,
        0,
        'npm pack should fail when apps/web/dist cannot be produced (gateway exists but web source is missing)',
      );

      // ── Verify prepack failure cleanup ──────────────────────────────────
      // build-pack.ts should have cleaned up all generated artifacts so the
      // tree stays clean even though npm skipped postpack.

      assert.ok(
        !fs.existsSync(path.join(failClone, '.packfiles')),
        '.packfiles should be cleaned up after prepack failure',
      );
      assert.ok(
        !fs.existsSync(path.join(failClone, '.package.json.bak')),
        '.package.json.bak should be cleaned up after prepack failure',
      );
      assert.ok(
        !fs.existsSync(path.join(failClone, 'dist', 'web-runtime')),
        'dist/web-runtime/ should be cleaned up after prepack failure',
      );

      // No stale .js files should remain alongside .ts sources
      const staleJs: string[] = [];
      function scanStaleJs(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanStaleJs(full);
          } else if (entry.name.endsWith('.js') && fs.existsSync(full.replace(/\.js$/, '.ts'))) {
            staleJs.push(path.relative(failClone, full));
          }
        }
      }
      try {
        scanStaleJs(path.join(failClone, 'lib'));
      } catch {
        /* lib/ may not exist */
      }
      try {
        scanStaleJs(path.join(failClone, 'bin'));
      } catch {
        /* bin/ may not exist */
      }
      assert.deepStrictEqual(
        staleJs,
        [],
        `Stale .js files found after prepack failure: ${staleJs.join(', ')}`,
      );

      // package.json should not be mutated (no .ts → .js rewrite persisted)
      const failPkg = JSON.parse(
        fs.readFileSync(path.join(failClone, 'package.json'), 'utf8'),
      );
      assert.ok(
        (failPkg.scripts.start as string).includes('.ts'),
        'package.json scripts.start should still reference .ts after failed prepack cleanup',
      );
    } finally {
      fs.rmSync(failClone, { recursive: true, force: true });
    }
  });
});
