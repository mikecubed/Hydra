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
console.log('[prepack] Done.');
