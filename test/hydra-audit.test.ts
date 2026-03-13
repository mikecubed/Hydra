import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { transformSync } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';


interface AuditFinding {
  file: string;
  line: number | null;
  severity: string;
  category: string;
  title: string;
  detail: string;
  effort: string;
  _score?: number;
}

interface AuditFileEntry {
  path: string;
  size: number;
  ext: string;
  priority?: string;
  score?: number;
}

interface ManifestStats {
  candidates: number;
  selected: number;
  changed: number;
  recent: number;
}

interface ReportMeta {
  runId: string;
  projectName: string;
  categories: string[];
  agents: string[];
  elapsedSec: string;
  manifestStats: ManifestStats;
}

interface AgentParseOutput {
  output: string;
}

interface AuditAgentStub {
  parseOutput?: (stdout: string) => AgentParseOutput;
}

interface AuditInternals {
  parseCsv(value: string): string[];
  parsePositiveInt(...values: unknown[]): number;
  resolveReportPath(projectPath: string, reportArg: string): string;
  buildManifest(projectPath: string, maxFiles: number): {
    files: AuditFileEntry[];
    stats: ManifestStats;
  };
  rankManifest(
    files: AuditFileEntry[],
    prioritySets: { changed: Set<string>; recent: Set<string> },
  ): AuditFileEntry[];
  formatManifest(files: AuditFileEntry[]): string;
  parseFindings(
    agentResponse: {
      agent: string;
      stdout: string;
      stderr: string;
      code: number | null;
      signal: string | null;
      elapsedSec: string;
    },
    fallbackCategory: string,
  ): AuditFinding[];
  normalizeFinding(raw: unknown, fallbackCategory: string): AuditFinding | null;
  deduplicateFindings(findings: AuditFinding[]): AuditFinding[];
  scoreAndSort(findings: AuditFinding[]): Array<AuditFinding & { _score: number }>;
  generateReport(
    findings: Array<AuditFinding & { _score: number }>,
    manifest: AuditFileEntry[],
    reportMeta: ReportMeta,
  ): string;
}

interface LoadAuditOptions {
  agents?: Record<string, AuditAgentStub>;
  argv?: string[];
  cwd?: string;
  auditConfig?: Record<string, unknown>;
}

const tempDirs = new Set<string>();
const testDir = fileURLToPath(new URL('.', import.meta.url));
const worktreeRoot = path.resolve(testDir, '..');
const hydraAuditPath = path.join(worktreeRoot, 'lib', 'hydra-audit.ts');

const rawAuditSource = fs.readFileSync(hydraAuditPath, 'utf8');
const auditSourceWithoutImports = rawAuditSource.replace(/^import [^\n]+;\n/gm, '');
const mainInvocationIndex = auditSourceWithoutImports.lastIndexOf('\nmain().catch(');
assert.notEqual(mainInvocationIndex, -1, 'Expected hydra-audit main() invocation');

const transpiledAuditSource = transformSync(auditSourceWithoutImports.slice(0, mainInvocationIndex), {
  format: 'esm',
  loader: 'ts',
  target: 'node24',
}).code;

const transformedAuditSource = `${transpiledAuditSource}
;globalThis.__hydraAuditTestExports = {
  buildManifest,
  deduplicateFindings,
  formatManifest,
  generateReport,
  normalizeFinding,
  parseCsv,
  parseFindings,
  parsePositiveInt,
  rankManifest,
  resolveReportPath,
  scoreAndSort,
};`;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-audit-test-'));
  tempDirs.add(dir);
  return dir;
}

function loadHydraAuditInternals(options: LoadAuditOptions = {}): AuditInternals {
  const context = vm.createContext({
    __hydraAuditTestExports: undefined,
    _spawn: () => { throw new Error('spawn not supported in test harness'); },
    basename: (value: string) => path.basename(value),
    clearTimeout,
    console,
    dirname: (value: string) => path.dirname(value),
    execFileSync,
    existsSync: fs.existsSync,
    expandInvokeArgs: (args: string[]) => args,
    getAgent: (agent: string) => options.agents?.[agent] ?? null,
    isAbsolute: (value: string) => path.isAbsolute(value),
    join: (...parts: string[]) => path.join(...parts),
    JSON,
    loadHydraConfig: () => ({ audit: options.auditConfig ?? {} }),
    Map,
    Math,
    mkdirSync: fs.mkdirSync,
    Number,
    Object,
    process: {
      argv: options.argv ?? ['node', hydraAuditPath],
      cwd: () => options.cwd ?? worktreeRoot,
      env: process.env,
      exit: (code: number) => {
        throw new Error(`Unexpected process.exit(${String(code)}) in test harness`);
      },
    },
    readdirSync: fs.readdirSync,
    relative: (from: string, to: string) => path.relative(from, to),
    resolve: (...parts: string[]) => path.resolve(...parts),
    Set,
    setTimeout,
    statSync: fs.statSync,
    String,
    writeFileSync: fs.writeFileSync,
  });

  vm.runInContext(transformedAuditSource, context, { filename: hydraAuditPath });
  return context['__hydraAuditTestExports'] as AuditInternals;
}

function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeFakeCli(binDir: string, name: string): void {
  const executablePath = path.join(binDir, name);
  writeFile(
    executablePath,
    '#!/usr/bin/env node\nprocess.stdout.write(process.env.HYDRA_AUDIT_FIXTURE_STDOUT ?? "[]");\n',
  );
  fs.chmodSync(executablePath, 0o755);
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('hydra-audit characterization', () => {
  it('normalizeFinding_withValidFields_returnsNormalizedFinding', () => {
    const audit = loadHydraAuditInternals();

    const finding = audit.normalizeFinding(
      {
        file: 'src\\audit\\worker.ts',
        line: 17,
        severity: 'MAJOR',
        category: 'inconsistency',
        title: '  Missing branch coverage  ',
        detail: '  Add timeout-path coverage.  ',
        effort: 'SMALL',
      },
      'tests',
    );

    assert.deepEqual(toPlain(finding), {
      file: 'src/audit/worker.ts',
      line: 17,
      severity: 'major',
      category: 'inconsistencies',
      title: 'Missing branch coverage',
      detail: 'Add timeout-path coverage.',
      effort: 'small',
    });
  });

  it('normalizeFinding_withInvalidFields_appliesDefaultsAndFallbacks', () => {
    const audit = loadHydraAuditInternals();

    const finding = audit.normalizeFinding(
      {
        file: 42,
        line: 0,
        severity: 'urgent',
        category: '',
        title: '   ',
        detail: '   ',
        effort: 'instant',
      },
      '',
    );

    assert.deepEqual(toPlain(finding), {
      file: '',
      line: null,
      severity: 'minor',
      category: 'uncategorized',
      title: 'Untitled finding',
      detail: 'No detail provided.',
      effort: 'medium',
    });
    assert.equal(audit.normalizeFinding(null, 'tests'), null);
  });

  it('parseFindings_withAgentWrappedJson_returnsNormalizedFindings', () => {
    const audit = loadHydraAuditInternals({
      agents: {
        codex: {
          parseOutput: (stdout) => ({
            output: JSON.parse(stdout).response as string,
          }),
        },
      },
    });

    const findings = audit.parseFindings(
      {
        agent: 'codex',
        stdout: JSON.stringify({
          response:
            '```json\n[{"file":"src\\\\suite.ts","line":8,"severity":"CRITICAL","title":"Exercise retry path","detail":"Cover the failing branch.","effort":"TRIVIAL"}]\n```',
        }),
        stderr: '',
        code: 0,
        signal: null,
        elapsedSec: '0.1',
      },
      'tests',
    );

    assert.deepEqual(toPlain(findings), [
      {
        file: 'src/suite.ts',
        line: 8,
        severity: 'critical',
        category: 'tests',
        title: 'Exercise retry path',
        detail: 'Cover the failing branch.',
        effort: 'trivial',
      },
    ]);
    assert.deepEqual(
      toPlain(
        audit.parseFindings(
        {
          agent: 'codex',
          stdout: 'not-json',
          stderr: '',
          code: 0,
          signal: null,
          elapsedSec: '0.1',
        },
        'tests',
        ),
      ),
      [],
    );
  });

  it('deduplicateFindings_withDuplicateIdentity_keepsHigherSeverityFinding', () => {
    const audit = loadHydraAuditInternals();

    const findings: AuditFinding[] = [
      {
        file: 'src/audit.ts',
        line: 4,
        severity: 'minor',
        category: 'tests',
        title: 'Missing branch test',
        detail: 'Add one assertion.',
        effort: 'small',
      },
      {
        file: 'src/audit.ts',
        line: 9,
        severity: 'critical',
        category: 'TESTS',
        title: 'missing branch test',
        detail: 'Protect the crash path.',
        effort: 'medium',
      },
      {
        file: 'src/other.ts',
        line: 2,
        severity: 'major',
        category: 'tests',
        title: 'Different finding',
        detail: 'Keep this result.',
        effort: 'small',
      },
    ];

    assert.deepEqual(toPlain(audit.deduplicateFindings(findings)), [findings[1], findings[2]]);
  });

  it('scoreAndSort_withMixedSeverityAndEffort_ordersByComputedScore', () => {
    const audit = loadHydraAuditInternals();

    const scored = audit.scoreAndSort([
      {
        file: 'src/minor.ts',
        line: 1,
        severity: 'minor',
        category: 'tests',
        title: 'Minor coverage gap',
        detail: 'Low impact.',
        effort: 'trivial',
      },
      {
        file: 'src/major.ts',
        line: 2,
        severity: 'major',
        category: 'tests',
        title: 'Major retry gap',
        detail: 'Exercise retry loop.',
        effort: 'trivial',
      },
      {
        file: 'src/critical.ts',
        line: 3,
        severity: 'critical',
        category: 'tests',
        title: 'Critical crash path',
        detail: 'Protect the fatal branch.',
        effort: 'large',
      },
    ]);

    assert.deepEqual(
      toPlain(scored).map((finding) => ({ title: finding.title, score: finding._score })),
      [
        { title: 'Major retry gap', score: 200 },
        { title: 'Critical crash path', score: 100 },
        { title: 'Minor coverage gap', score: 40 },
      ],
    );
  });

  it('buildManifest_withMixedProjectFiles_filtersUnsupportedAndIgnoredFiles', () => {
    const audit = loadHydraAuditInternals();
    const projectRoot = makeTempDir();

    writeFile(path.join(projectRoot, 'src', 'main.ts'), 'export const main = 1;\n');
    writeFile(path.join(projectRoot, 'src', 'config.json'), '{"mode":"test"}\n');
    writeFile(path.join(projectRoot, 'README.md'), '# ignored\n');
    writeFile(path.join(projectRoot, 'node_modules', 'pkg', 'skip.ts'), 'export const skip = 1;\n');
    writeFile(path.join(projectRoot, '.hidden', 'secret.ts'), 'export const hidden = 1;\n');

    const manifest = audit.buildManifest(projectRoot, 10);

    assert.deepEqual(
      toPlain(manifest.files).map((file) => file.path),
      ['src/config.json', 'src/main.ts'],
    );
    assert.deepEqual(toPlain(manifest.stats), {
      candidates: 2,
      selected: 2,
      changed: 0,
      recent: 0,
    });
  });

  it('buildManifest_withNoSupportedFiles_returnsEmptySelection', () => {
    const audit = loadHydraAuditInternals();
    const projectRoot = makeTempDir();

    writeFile(path.join(projectRoot, 'README.md'), '# no code here\n');

    const manifest = audit.buildManifest(projectRoot, 10);

    assert.deepEqual(toPlain(manifest.files), []);
    assert.deepEqual(toPlain(manifest.stats), {
      candidates: 0,
      selected: 0,
      changed: 0,
      recent: 0,
    });
  });

  it('main_withFakeCodexReport_roundTripsMarkdownInPriorityOrder', () => {
    const projectRoot = makeTempDir();
    const fakeBinDir = makeTempDir();
    const reportPath = path.join(projectRoot, 'reports', 'audit.md');
    const findings = [
      {
        file: 'src/sample.ts',
        line: 14,
        severity: 'major',
        category: 'tests',
        title: 'Add empty-input coverage',
        detail: 'Exercise the empty prompt branch.',
        effort: 'small',
      },
      {
        file: 'src/sample.ts',
        line: 4,
        severity: 'critical',
        category: 'tests',
        title: 'Protect timeout failure path',
        detail: 'Missing regression coverage for timeouts.',
        effort: 'trivial',
      },
    ];

    writeFile(path.join(projectRoot, 'src', 'sample.ts'), 'export function sample() { return 1; }\n');
    makeFakeCli(fakeBinDir, 'codex');

    const result = spawnSync(
      'node',
      [
        path.join(worktreeRoot, 'lib', 'hydra-audit.ts'),
        `project=${projectRoot}`,
        'categories=tests',
        'agents=codex',
        `report=${reportPath}`,
      ],
      {
        cwd: worktreeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HYDRA_AUDIT_FIXTURE_STDOUT: JSON.stringify(findings),
          PATH: `${fakeBinDir}:${process.env['PATH'] ?? ''}`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(reportPath), true);
    assert.match(result.stdout, /Report saved:/);

    const report = fs.readFileSync(reportPath, 'utf8');
    const criticalIndex = report.indexOf('1. [CRIT] **Protect timeout failure path**');
    const majorIndex = report.indexOf('2. [MAJOR] **Add empty-input coverage**');

    assert.equal(criticalIndex >= 0, true);
    assert.equal(majorIndex >= 0, true);
    assert.equal(criticalIndex < majorIndex, true);
    assert.match(report, /\*\*Findings:\*\* 2 \(1 critical, 1 major, 0 minor\)/);
    assert.match(report, /\| Critical \| 1 \|/);
    assert.match(report, /\| Major {4}\| 1 \|/);
    assert.match(report, /## Quick Wins/);
    assert.match(report, /File: `src\/sample.ts`:4/);
    assert.match(report, /File: `src\/sample.ts`:14/);
  });
});
