// check-per-file-coverage.ts — Enforce per-module-group coverage floors.
//
// Reads the c8 JSON coverage report and checks that critical module groups
// don't regress below their statement-coverage floor. Exits non-zero on failure.
//
// Usage:
//   npm run test:coverage:per-file
//   node --experimental-strip-types scripts/check-per-file-coverage.ts
//
// Expects coverage data to have been generated already (e.g. via `npm run test:coverage`).
// Runs `c8 report --reporter=json` and then reads ./coverage/coverage-final.json.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const coverageJsonPath = path.join(repoRoot, 'coverage', 'coverage-final.json');

interface CoverageEntry {
  s: Record<string, number>;
  statementMap: Record<string, unknown>;
}

interface ModuleFloor {
  /** Path prefix used for matching coverage keys (e.g. 'lib/daemon/'). */
  prefix: string;
  /** Statement coverage floor as a percentage (0–100). */
  minStatementPct: number;
}

interface GroupResult {
  floor: ModuleFloor;
  totalStatements: number;
  coveredStatements: number;
  percentage: number;
  passed: boolean;
}

const MODULE_FLOORS: ModuleFloor[] = [
  { prefix: 'lib/daemon/', minStatementPct: 85 },
  { prefix: 'lib/hydra-shared/', minStatementPct: 73 },
];

function loadCoverageData(): Record<string, CoverageEntry> | undefined {
  // Generate the JSON coverage report from existing c8 data
  try {
    execFileSync('npx', ['--no-install', 'c8', 'report', '--reporter=json', '--all'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch (err_: unknown) {
    console.error('Failed to generate c8 JSON report.');
    console.error('Make sure you have run `npm run test:coverage` first.');
    if (err_ != null && typeof err_ === 'object') {
      const details = err_ as { message?: string; stderr?: string };
      if (details.message != null && details.message !== '')
        console.error(`c8 error: ${details.message}`);
      if (details.stderr != null && details.stderr !== '')
        console.error(`c8 stderr:\n${details.stderr}`);
    }
    return undefined;
  }

  // Read the JSON coverage data
  try {
    const raw = readFileSync(coverageJsonPath, 'utf8');
    return JSON.parse(raw) as Record<string, CoverageEntry>;
  } catch {
    console.error(`Failed to read coverage JSON at ${coverageJsonPath}`);
    console.error('Make sure you have run `npm run test:coverage` first.');
    return undefined;
  }
}

function computeResults(coverageData: Record<string, CoverageEntry>): GroupResult[] {
  const results: GroupResult[] = [];

  for (const floor of MODULE_FLOORS) {
    let totalStatements = 0;
    let coveredStatements = 0;

    for (const [filePath, entry] of Object.entries(coverageData)) {
      // Normalize paths for consistent matching:
      // - If the coverage key is absolute, make it relative to the repo root.
      // - If it's already relative, use it as-is.
      // - Normalize path separators to '/' to match floor.prefix on all platforms.
      const relativePath = path.isAbsolute(filePath) ? path.relative(repoRoot, filePath) : filePath;
      const normalizedPath = relativePath.split(path.sep).join('/');

      if (!normalizedPath.startsWith(floor.prefix)) continue;
      if (normalizedPath.endsWith('.d.ts')) continue;
      if (normalizedPath.endsWith('.test.ts')) continue;

      const statementCounts = Object.values(entry.s);
      totalStatements += statementCounts.length;
      coveredStatements += statementCounts.filter((count) => count > 0).length;
    }

    if (totalStatements === 0) {
      console.error(
        `WARNING: No files matched "${floor.prefix}" in coverage report. ` +
          'Check path normalization and c8 config.',
      );
    }

    const percentage = totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
    results.push({
      floor,
      totalStatements,
      coveredStatements,
      percentage,
      passed: totalStatements > 0 && percentage >= floor.minStatementPct,
    });
  }

  return results;
}

function printReport(results: GroupResult[]): boolean {
  console.log('\n--- Per-Module Coverage Floor Check ---\n');

  let allPassed = true;

  for (const result of results) {
    const icon = result.passed ? '[PASS]' : '[FAIL]';
    const pct = result.percentage.toFixed(2);

    console.log(
      `${icon} ${result.floor.prefix}: ${pct}% statements (floor: ${String(result.floor.minStatementPct)}%)`,
    );
    console.log(
      `      ${String(result.coveredStatements)}/${String(result.totalStatements)} statements covered`,
    );

    if (!result.passed) {
      allPassed = false;
      if (result.totalStatements === 0) {
        console.log('      NO FILES MATCHED — check coverage paths');
      } else {
        console.log(
          `      BELOW FLOOR by ${(result.floor.minStatementPct - result.percentage).toFixed(2)} percentage points`,
        );
      }
    }
    console.log();
  }

  if (allPassed) {
    console.log('All module groups meet their coverage floors.\n');
  } else {
    console.error('Some module groups are below their coverage floor. See above for details.\n');
  }

  return allPassed;
}

// Main
const coverageData = loadCoverageData();
if (coverageData) {
  const results = computeResults(coverageData);
  if (!printReport(results)) {
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
}
