// complexity-report.ts — Visibility report for code complexity and size.
//
// Runs ESLint with complexity/size rules as WARN on lib/ sources and prints a
// human-readable summary. Intentionally NOT part of the main `npm run lint` so
// that known hotspots (e.g. hydra-operator.ts, 6630 lines) don't flood CI
// output while they are being refactored in rf-op01..rf-op05 / rf-ev01..rf-ev03.
//
// Usage:
//   npm run lint:complexity
//   node scripts/complexity-report.ts
//
// See docs/plan/refactoring-task-breakdown.md (rf-tl03) for context.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Thresholds — generous for existing code; tighten over time as hotspots shrink
const COMPLEXITY_THRESHOLD = 20;
const MAX_LINES_THRESHOLD = 500;
const MAX_LINES_PER_FUNCTION_THRESHOLD = 80;

const RULES = [
  `complexity: ["warn", ${String(COMPLEXITY_THRESHOLD)}]`,
  `max-lines: ["warn", ${String(MAX_LINES_THRESHOLD)}]`,
  `max-lines-per-function: ["warn", ${String(MAX_LINES_PER_FUNCTION_THRESHOLD)}]`,
];

interface EslintMessage {
  ruleId: string | null;
  severity: number;
  message: string;
  line: number;
  column: number;
}

interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
  errorCount: number;
  warningCount: number;
}

function run(): void {
  const ruleFlags = RULES.flatMap((r) => ['--rule', r]);

  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules', '.bin', 'eslint'),
      'lib/**/*.ts',
      '--format',
      'json',
      '--no-error-on-unmatched-pattern',
      ...ruleFlags,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024, // ESLint JSON output can be large on big codebases
      // eslint exits non-zero when warnings/errors exist; that's expected here
      shell: false,
    },
  );

  if (result.error) {
    console.error('Failed to spawn eslint:', result.error.message);
    process.exitCode = 1;
    return;
  }

  let files: EslintFileResult[];
  try {
    // ESLint --format json may prefix non-JSON text on stderr; stdout is the JSON
    files = JSON.parse(result.stdout) as EslintFileResult[];
  } catch {
    console.error('Could not parse ESLint JSON output.');
    console.error('stdout:', result.stdout.slice(0, 500));
    console.error('stderr:', result.stderr.slice(0, 500));
    process.exitCode = 1;
    return;
  }

  // Only keep files that have complexity/size warnings from OUR extra rules
  const ruleIds = new Set(['complexity', 'max-lines', 'max-lines-per-function']);
  const violatingFiles = files
    .map((f) => ({
      filePath: path.relative(repoRoot, f.filePath),
      messages: f.messages.filter((m) => m.ruleId !== null && ruleIds.has(m.ruleId)),
    }))
    .filter((f) => f.messages.length > 0)
    .sort((a, b) => b.messages.length - a.messages.length);

  // Aggregate by rule
  const counts: Record<string, number> = {};
  for (const f of violatingFiles) {
    for (const m of f.messages) {
      if (m.ruleId !== null) counts[m.ruleId] = (counts[m.ruleId] ?? 0) + 1;
    }
  }

  const totalViolations = Object.values(counts).reduce((s, c) => s + c, 0);

  console.log('\n─── Complexity / Size Visibility Report ─────────────────────────────────');
  console.log(
    `Thresholds: complexity>${String(COMPLEXITY_THRESHOLD)}  max-lines>${String(MAX_LINES_THRESHOLD)}  max-lines-per-function>${String(MAX_LINES_PER_FUNCTION_THRESHOLD)}`,
  );
  console.log(
    `\nTotal violations: ${String(totalViolations)}  |  Files affected: ${String(violatingFiles.length)}`,
  );

  if (totalViolations === 0) {
    console.log('\n✓ No complexity or size violations found — great shape!\n');
    return;
  }

  console.log('\nBy rule:');
  for (const [rule, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(30)} ${String(count)}`);
  }

  console.log('\nTop offending files (by violation count):');
  const TOP_N = 20;
  for (const f of violatingFiles.slice(0, TOP_N)) {
    console.log(`  ${String(f.messages.length).padStart(3)}  ${f.filePath}`);
    for (const m of f.messages) {
      console.log(`       L${String(m.line)}  [${m.ruleId ?? 'unknown'}]  ${m.message}`);
    }
  }
  if (violatingFiles.length > TOP_N) {
    console.log(`  ... and ${String(violatingFiles.length - TOP_N)} more files`);
  }

  console.log(
    '\nNote: These are WARN-only. Fix by refactoring per docs/plan/refactoring-task-breakdown.md.\n',
  );

  // Always exit 0 — this is a visibility tool, not a gate
  process.exitCode = 0;
}

run();
