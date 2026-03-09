/**
 * scripts/setup-hooks.mjs
 *
 * Installs Hydra's git hooks (husky) and verifies the quality toolchain.
 * Run this after cloning the repo or when hooks need to be re-installed:
 *
 *   node scripts/setup-hooks.mjs
 *   # or via npm:
 *   npm run prepare
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const pc = await import('picocolors').then((m) => m.default);

function run(cmd, label) {
  process.stdout.write(`  ${pc.dim('→')} ${label}…`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: 'pipe' });
    console.log(` ${pc.green('✓')}`);
    return true;
  } catch (err) {
    console.log(` ${pc.red('✗')}`);
    console.error(`     ${pc.red(err.stderr?.toString().trim() ?? err.message)}`);
    return false;
  }
}

function check(label, condition) {
  const icon = condition ? pc.green('✓') : pc.red('✗');
  console.log(`  ${icon} ${label}`);
  return condition;
}

console.log();
console.log(pc.bold(pc.cyan('Hydra — Code Quality Hook Setup')));
console.log(pc.dim('─'.repeat(40)));
console.log();

// ── 1. Install husky hooks ────────────────────────────────────────────────────
console.log(pc.bold('1. Installing git hooks (husky)'));
const huskyOk = run('npx husky', 'husky install');

// ── 2. Verify hook files exist ────────────────────────────────────────────────
console.log();
console.log(pc.bold('2. Verifying hook files'));
const preCommit = join(ROOT, '.husky', 'pre-commit');
const prePush = join(ROOT, '.husky', 'pre-push');
check('pre-commit hook', existsSync(preCommit));
check('pre-push hook', existsSync(prePush));

// ── 3. Verify toolchain ───────────────────────────────────────────────────────
console.log();
console.log(pc.bold('3. Verifying quality toolchain'));
const eslintOk = run('npx eslint --version', 'ESLint');
const prettierOk = run('npx prettier --version', 'Prettier');
const tscOk = run('npx tsc --version', 'TypeScript');
const lintStagedOk = run('npx lint-staged --version', 'lint-staged');

// ── Summary ───────────────────────────────────────────────────────────────────
console.log();
console.log(pc.dim('─'.repeat(40)));

const allOk = huskyOk && eslintOk && prettierOk && tscOk && lintStagedOk;

if (allOk) {
  console.log(pc.green(pc.bold('✓ All hooks and tools are configured.')));
  console.log();
  console.log(pc.dim('Hooks active:'));
  console.log(pc.dim('  pre-commit  → lint-staged (ESLint + Prettier on staged files)'));
  console.log(pc.dim('  pre-push    → npm test (full test suite)'));
  console.log();
  console.log(pc.dim('Useful commands:'));
  console.log(pc.dim('  npm run lint          — ESLint on entire codebase'));
  console.log(pc.dim('  npm run lint:fix      — ESLint with auto-fix'));
  console.log(pc.dim('  npm run format        — Prettier format all files'));
  console.log(pc.dim('  npm run format:check  — Prettier check (no write)'));
  console.log(pc.dim('  npm run typecheck     — tsc --noEmit type check'));
  console.log(pc.dim('  npm run quality       — lint + format:check + typecheck'));
} else {
  console.log(pc.red(pc.bold('✗ Setup completed with errors. See above.')));
  process.exitCode = 1;
}

console.log();
