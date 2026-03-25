// check-per-file-coverage.ts — Enforce per-module-group coverage floors.
//
// Reads the c8 JSON coverage report and checks that critical module groups
// don't regress below their statement-coverage floor. Exits non-zero on failure.
//
// Usage:
//   npm run test:coverage:per-file
//   node --experimental-strip-types scripts/check-per-file-coverage.ts
//
// Expects c8 coverage data in ./coverage/tmp/ (the default v8 output directory).
// Generates a JSON summary via `c8 report --reporter=json`.

import { execSync } from 'node:child_process';
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
  glob: string;
  prefix: string;
  minStatements: number;
}

interface GroupResult {
  floor: ModuleFloor;
  totalStatements: number;
  coveredStatements: number;
  percentage: number;
  passed: boolean;
}

const MODULE_FLOORS: ModuleFloor[] = [
  { glob: 'lib/daemon/**/*.ts', prefix: 'lib/daemon/', minStatements: 85 },
  { glob: 'lib/hydra-shared/**/*.ts', prefix: 'lib/hydra-shared/', minStatements: 73 },
];

function loadCoverageData(): Record<string, CoverageEntry> | undefined {
  // Generate the JSON coverage report from existing c8 data
  try {
    execSync('npx c8 report --reporter=json', {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
  } catch {
    console.error('Failed to generate c8 JSON report.');
    console.error('Make sure you have run `npm run test:coverage` first.');
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
      // Normalize absolute paths to relative from repo root
      const relativePath = path.relative(repoRoot, filePath);

      if (!relativePath.startsWith(floor.prefix)) continue;
      if (relativePath.endsWith('.d.ts')) continue;
      if (relativePath.endsWith('.test.ts')) continue;

      const statementCounts = Object.values(entry.s);
      totalStatements += statementCounts.length;
      coveredStatements += statementCounts.filter((count) => count > 0).length;
    }

    const percentage = totalStatements > 0 ? (coveredStatements / totalStatements) * 100 : 0;
    results.push({
      floor,
      totalStatements,
      coveredStatements,
      percentage,
      passed: percentage >= floor.minStatements,
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
      `${icon} ${result.floor.glob}: ${pct}% statements (floor: ${String(result.floor.minStatements)}%)`,
    );
    console.log(
      `      ${String(result.coveredStatements)}/${String(result.totalStatements)} statements covered`,
    );

    if (!result.passed) {
      allPassed = false;
      console.log(
        `      BELOW FLOOR by ${(result.floor.minStatements - result.percentage).toFixed(2)} percentage points`,
      );
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
