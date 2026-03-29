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
const WEB_RUNTIME_DIR = path.join(ROOT, 'dist', 'web-runtime');

// ── Step 1: Compile ──────────────────────────────────────────────────────────

console.log('[prepack] Compiling TypeScript for packaging…');

const tsc = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', 'tsconfig.build.json'],
  { cwd: ROOT, stdio: 'inherit' },
);

if (tsc.status !== 0) {
  console.error('[prepack] tsc compilation failed.');
  exit(1);
}

// ── Step 2: Collect emitted files ────────────────────────────────────────────

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

collectJsFiles(path.join(ROOT, 'lib'));
collectJsFiles(path.join(ROOT, 'bin'));

console.log(`[prepack] Emitted ${String(emitted.length)} .js files.`);

// ── Step 3: Post-process string-literal .ts references ───────────────────────

// tsc's rewriteRelativeImportExtensions rewrites import specifiers but NOT
// string literals used in path.join(), readFileSync(), endsWith(), etc.
// We do a safe global replacement: .ts followed by a closing quote character.
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

// ── Step 4: Write cleanup manifest ───────────────────────────────────────────

fs.writeFileSync(MANIFEST_PATH, `${emitted.join('\n')}\n`);
console.log(`[prepack] Manifest written to .packfiles (${String(emitted.length)} entries).`);

// ── Step 4: Bundle web runtime ───────────────────────────────────────────
// Creates dist/web-runtime/ with a bundled gateway server and browser assets.
// Skipped gracefully when workspace sources are unavailable (e.g. minimal clone).

const GATEWAY_ENTRY = path.join(ROOT, 'apps', 'web-gateway', 'src', 'server.ts');
const WEB_DIST = path.join(ROOT, 'apps', 'web', 'dist');

if (fs.existsSync(GATEWAY_ENTRY)) {
  console.log('[prepack] Building web runtime…');

  const serverOut = path.join(WEB_RUNTIME_DIR, 'server.js');
  fs.mkdirSync(WEB_RUNTIME_DIR, { recursive: true });

  // 4a. Bundle the gateway server entry with esbuild (self-contained ESM).
  // The banner sets the default static dir to ./web relative to the bundle
  // so the packaged layout resolves correctly without env var overrides.
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

  // 4b. Copy pre-built web frontend assets into dist/web-runtime/web/.
  const webAssetsDest = path.join(WEB_RUNTIME_DIR, 'web');
  if (fs.existsSync(WEB_DIST)) {
    fs.cpSync(WEB_DIST, webAssetsDest, { recursive: true });
    console.log('[prepack] Copied browser assets → dist/web-runtime/web/');
  } else {
    console.warn(
      '[prepack] ⚠ apps/web/dist/ not found — browser assets not included. ' +
        'Run `npm --workspace @hydra/web run build` before packing for full web support.',
    );
  }

  console.log('[prepack] Web runtime ready.');
} else {
  console.log('[prepack] apps/web-gateway not found — skipping web runtime build.');
}

// ── Step 5: Patch package.json for published artifact ────────────────────────
// Rewrite scripts that reference .ts entrypoints under lib/ or bin/ so that
// `npm run <script>` works from the installed package (which has only .js).

const PKG_PATH = path.join(ROOT, 'package.json');
const PKG_BACKUP = path.join(ROOT, '.package.json.bak');

console.log('[prepack] Patching package.json for published artifact…');
fs.copyFileSync(PKG_PATH, PKG_BACKUP);

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')) as {
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
};

// Rewrite bin entries (.ts → .js) so the published package points to compiled JS.
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
    // Only rewrite .ts references that live under lib/ or bin/ (shipped dirs).
    // Leave scripts/ references alone — those are dev-only and not in the tarball.
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
