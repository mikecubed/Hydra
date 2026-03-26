// check-new-file-tests.ts — Enforce that newly added lib/ files have tests.
//
// Compares the current branch against a base branch (default: main) and checks
// that every new .ts file added under lib/ has a corresponding test file in test/.
//
// Usage:
//   npm run test:new-file-policy                    # defaults to main
//   npm run test:new-file-policy -- origin/main     # explicit base
//   node --experimental-strip-types scripts/check-new-file-tests.ts [base]

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const baseBranch = process.argv[2] ?? 'main';

if (baseBranch.startsWith('-') || /\s/.test(baseBranch)) {
  console.error(`Invalid base branch ref: "${baseBranch}"`);
  console.error('The base branch name must not start with "-" or contain whitespace.');
  process.exitCode = 1;
}

function getNewFiles(): string[] | undefined {
  // Get list of newly added files (diff-filter=A means "added only")
  // Uses execFileSync with argument array to avoid command injection via baseBranch.
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=A', `${baseBranch}...HEAD`],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch {
    // If the three-dot syntax fails, try two-dot
  }

  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=A', baseBranch, 'HEAD'],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to get diff against ${baseBranch}: ${message}`);
    console.error('Make sure the base branch is available (fetch-depth: 0 in CI).');
    return undefined;
  }
}

function isExcluded(filePath: string): boolean {
  // Skip type declaration files
  if (filePath.endsWith('.d.ts')) return true;

  // Skip test files themselves
  if (filePath.endsWith('.test.ts')) return true;

  const basename = path.basename(filePath);

  // Skip index re-export files
  if (basename === 'index.ts') return true;

  // Skip files under 10 lines
  try {
    const fullPath = path.join(repoRoot, filePath);
    const content = readFileSync(fullPath, 'utf8');
    const lineCount = content.split('\n').length;
    if (lineCount < 10) return true;
  } catch {
    // File may have been deleted after being added; skip it
    return true;
  }

  return false;
}

function findExpectedTestPath(libPath: string): string {
  // lib/foo/bar.ts -> test/foo/bar.test.ts
  // lib/hydra-utils.ts -> test/hydra-utils.test.ts
  const relativeTail = libPath.replace(/^lib\//, '');
  const parsed = path.parse(relativeTail);
  return path.join('test', parsed.dir, `${parsed.name}.test.ts`);
}

function testExists(testPath: string): boolean {
  try {
    statSync(path.join(repoRoot, testPath));
    return true;
  } catch {
    return false;
  }
}

// Main
const newFiles = getNewFiles();
if (newFiles) {
  // Filter to lib/ TypeScript files only
  const libFiles = newFiles.filter((f) => f.startsWith('lib/') && f.endsWith('.ts'));
  const testableFiles = libFiles.filter((f) => !isExcluded(f));

  const missingTests: Array<{ source: string; expectedTest: string }> = [];

  for (const file of testableFiles) {
    const expectedTest = findExpectedTestPath(file);
    if (!testExists(expectedTest)) {
      missingTests.push({ source: file, expectedTest });
    }
  }

  // Report results
  console.log('\n--- New File Test Policy Check ---\n');
  console.log(`Base branch: ${baseBranch}`);
  console.log(`New lib/ files found: ${String(libFiles.length)}`);
  console.log(`Testable files (after exclusions): ${String(testableFiles.length)}`);
  console.log();

  if (missingTests.length === 0) {
    console.log('All new lib/ files have corresponding test files.\n');
  } else {
    console.error(`${String(missingTests.length)} new file(s) are missing tests:\n`);
    for (const { source, expectedTest } of missingTests) {
      console.error(`  ${source}`);
      console.error(`    expected: ${expectedTest}\n`);
    }
    console.error('Every new lib/ file must have a corresponding test file in test/.');
    console.error('See CLAUDE.md for test conventions.\n');
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
}
