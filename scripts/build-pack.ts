/**
 * scripts/build-pack.ts — Prepack build for npm packaging.
 *
 * Compiles TypeScript source in lib/ and bin/ to runnable JavaScript so the
 * published tarball works on any supported Node version without native TS
 * strip-types support.
 *
 * Steps:
 *   1. Run tsc with tsconfig.build.json (emits .js alongside .ts source).
 *   2. Post-process emitted .js files: rewrite remaining string-literal
 *      ".ts" references (path.join segments, file filters, etc.) to ".js".
 *   3. Write a manifest of generated files for postpack cleanup.
 *   4. Bundle the web runtime into dist/web-runtime/ (gateway + browser assets).
 *   5. Patch package.json so published scripts also point to .js entrypoints.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { exit } from '../lib/hydra-process.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, '.packfiles');
const PKG_PATH = path.join(ROOT, 'package.json');
const PKG_BACKUP = path.join(ROOT, '.package.json.bak');
const WEB_RUNTIME_DIR = path.join(ROOT, 'dist', 'web-runtime');
const GATEWAY_ENTRY = path.join(ROOT, 'apps', 'web-gateway', 'src', 'server.ts');
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');
const PACKAGED_MARKER = '.packaged';

const emitted: string[] = [];

function collectJsFiles(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsFiles(full);
    } else if (entry.name.endsWith('.js')) {
      const tsCounterpart = full.replace(/\.js$/, '.ts');
      if (fs.existsSync(tsCounterpart)) {
        emitted.push(path.relative(ROOT, full));
      }
    }
  }
}

function cleanupFailedPrepack(): void {
  for (const rel of emitted) {
    try {
      fs.unlinkSync(path.join(ROOT, rel));
    } catch {
      // ignore cleanup misses
    }
  }

  if (fs.existsSync(MANIFEST_PATH)) {
    fs.unlinkSync(MANIFEST_PATH);
  }

  if (fs.existsSync(PKG_BACKUP)) {
    fs.copyFileSync(PKG_BACKUP, PKG_PATH);
    fs.unlinkSync(PKG_BACKUP);
  }

  if (fs.existsSync(WEB_RUNTIME_DIR)) {
    fs.rmSync(WEB_RUNTIME_DIR, { recursive: true, force: true });
  }
}

function fail(message: string): never {
  throw new Error(message);
}

try {
  // ── Step 1: Compile ────────────────────────────────────────────────────────

  console.log('[prepack] Compiling TypeScript for packaging…');

  const tsc = spawnSync(
    process.execPath,
    [path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', 'tsconfig.build.json'],
    { cwd: ROOT, stdio: 'inherit' },
  );

  if (tsc.status !== 0) {
    fail('tsc compilation failed.');
  }

  // ── Step 2: Collect emitted files ──────────────────────────────────────────

  collectJsFiles(path.join(ROOT, 'lib'));
  collectJsFiles(path.join(ROOT, 'bin'));

  console.log(`[prepack] Emitted ${String(emitted.length)} .js files.`);

  // ── Step 3: Post-process string-literal .ts references ─────────────────────

  const TS_EXT_IN_STRING = /\.ts(?=['"`])/g;

  let patchCount = 0;
  for (const rel of emitted) {
    const abs = path.join(ROOT, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const patched = src.replace(TS_EXT_IN_STRING, '.js');
    if (patched !== src) {
      fs.writeFileSync(abs, patched);
      patchCount += 1;
    }
  }

  console.log(`[prepack] Patched string literals in ${String(patchCount)} files.`);

  // ── Step 4: Write cleanup manifest ─────────────────────────────────────────

  fs.writeFileSync(MANIFEST_PATH, `${emitted.join('\n')}\n`);
  console.log(`[prepack] Manifest written to .packfiles (${String(emitted.length)} entries).`);

  // ── Step 5: Bundle web runtime ─────────────────────────────────────────────

  if (fs.existsSync(GATEWAY_ENTRY)) {
    console.log('[prepack] Building web runtime…');

    const serverOut = path.join(WEB_RUNTIME_DIR, 'server.js');
    fs.mkdirSync(WEB_RUNTIME_DIR, { recursive: true });

    const esbuildBanner = [
      'import { dirname as __pkgDir } from "node:path";',
      'import { fileURLToPath as __pkgUrl } from "node:url";',
      'process.env.HYDRA_WEB_STATIC_DIR ??= __pkgDir(__pkgUrl(import.meta.url)) + "/web";',
    ].join('\n');

    const { build } = await import('esbuild');
    await build({
      entryPoints: [GATEWAY_ENTRY],
      outfile: serverOut,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: ['node20'],
      legalComments: 'none',
      sourcemap: false,
      banner: { js: esbuildBanner },
    });

    console.log('[prepack] Bundled gateway entry → dist/web-runtime/server.js');

    if (!fs.existsSync(WEB_DIST)) {
      console.log('[prepack] apps/web/dist/ not found — building web workspace…');
      const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
      if (!fs.existsSync(viteBin)) {
        fail('vite not found — cannot build apps/web/. Run `npm install` first.');
      }
      const webBuild = spawnSync(process.execPath, [viteBin, 'build'], {
        cwd: path.join(ROOT, 'apps', 'web'),
        stdio: 'inherit',
      });
      if (webBuild.status !== 0) {
        fail('Web workspace build failed (vite build exited non-zero).');
      }
      if (!fs.existsSync(WEB_DIST)) {
        fail('apps/web/dist/ is still missing after the web build completed.');
      }
    }

    const webAssetsDest = path.join(WEB_RUNTIME_DIR, 'web');
    fs.cpSync(WEB_DIST, webAssetsDest, { recursive: true });
    fs.writeFileSync(path.join(WEB_RUNTIME_DIR, PACKAGED_MARKER), 'packaged\n');
    console.log('[prepack] Copied browser assets → dist/web-runtime/web/');
    console.log('[prepack] Wrote packaged runtime marker.');
    console.log('[prepack] Web runtime ready.');
  } else {
    console.log('[prepack] apps/web-gateway not found — skipping web runtime build.');
  }

  // ── Step 6: Patch package.json for published artifact ──────────────────────

  console.log('[prepack] Patching package.json for published artifact…');
  fs.copyFileSync(PKG_PATH, PKG_BACKUP);

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as {
    bin?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  if (pkg.bin) {
    let binPatchCount = 0;
    for (const [key, value] of Object.entries(pkg.bin)) {
      if (typeof value !== 'string') continue;
      const rewritten = value.replace(/\.ts$/, '.js');
      if (rewritten !== value) {
        pkg.bin[key] = rewritten;
        binPatchCount += 1;
      }
    }
    console.log(`[prepack] Rewrote ${String(binPatchCount)} bin entries (.ts → .js).`);
  }

  if (pkg.scripts) {
    let scriptPatchCount = 0;
    for (const [key, value] of Object.entries(pkg.scripts)) {
      if (typeof value !== 'string') continue;
      const rewritten = value.replace(/\b((?:lib|bin)\/[\w./-]*?)\.ts\b/g, '$1.js');
      if (rewritten !== value) {
        pkg.scripts[key] = rewritten;
        scriptPatchCount += 1;
      }
    }
    console.log(`[prepack] Rewrote ${String(scriptPatchCount)} script entries (.ts → .js).`);
  }

  fs.writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log('[prepack] Done.');
} catch (error) {
  cleanupFailedPrepack();
  if (error instanceof Error) {
    console.error(`[prepack] ${error.message}`);
  } else {
    console.error('[prepack] Packaging failed.', error);
  }
  exit(1);
}
