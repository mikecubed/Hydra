import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import pc from 'picocolors';
import ts from 'typescript';

import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import { _resetRegistry, initAgentRegistry } from '../lib/hydra-agents.ts';
import { ensureDir } from '../lib/hydra-utils.ts';
import { createUserTask, deduplicateTasks, prioritizeTasks, taskToSlug } from '../lib/hydra-tasks-scanner.ts';
import { runDiscovery } from '../lib/hydra-nightly-discovery.ts';
import type { ScannedTask } from '../lib/hydra-tasks-scanner.ts';
import type { CustomAgentDef, NightlyConfig } from '../lib/types.ts';

const tempDirs = new Set<string>();
const nightlySourcePath = new URL('../lib/hydra-nightly.ts', import.meta.url);

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-nightly-test-'));
  tempDirs.add(dir);
  return dir;
}

function readSource(fileUrl: URL): string {
  return fs.readFileSync(fileUrl, 'utf8');
}

function extractFunction(source: string, name: string): string {
  const sourceFile = ts.createSourceFile(
    'inline.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile);
    }
  }
  throw new Error(`Function ${name} not found`);
}

function extractConst(source: string, name: string): string {
  const sourceFile = ts.createSourceFile(
    'inline.ts',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
      )
    ) {
      return printer.printNode(ts.EmitHint.Unspecified, statement, sourceFile);
    }
  }
  throw new Error(`Const ${name} not found`);
}

function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function loadHelper(
  fileUrl: URL,
  name: string,
  {
    functions = [],
    consts = [],
    context = {},
  }: {
    functions?: string[];
    consts?: string[];
    context?: Record<string, unknown>;
  } = {},
): unknown {
  const source = readSource(fileUrl);
  const declarations = [
    ...consts.map((constName) => extractConst(source, constName)),
    ...functions.map((functionName) => extractFunction(source, functionName)),
    extractFunction(source, name),
  ].join('\n\n');
  const sandbox: Record<string, unknown> = { result: undefined, ...context };
  const transpiled = ts.transpileModule(`${declarations}\nresult = ${name};`, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  vm.runInNewContext(transpiled, sandbox, {
    filename: fileUrl.pathname,
  });
  return sandbox['result'];
}

function makeTask(
  title: string,
  overrides: Partial<ScannedTask> = {},
  source: ScannedTask['source'] = 'todo-comment',
): ScannedTask {
  return {
    id: `${source}:${taskToSlug(title)}`,
    title,
    slug: taskToSlug(title),
    source,
    sourceRef: `${source}:1`,
    taskType: overrides.taskType ?? 'testing',
    suggestedAgent: overrides.suggestedAgent ?? 'codex',
    complexity: overrides.complexity ?? 'small',
    priority: overrides.priority ?? 'medium',
    body: overrides.body ?? null,
    issueNumber: overrides.issueNumber ?? null,
    ...overrides,
  };
}

function writeDiscoveryAgent(
  dir: string,
  mode: 'success' | 'invalid' | 'error',
): string {
  const scriptPath = path.join(dir, `fake-discovery-${mode}.mjs`);
  fs.writeFileSync(
    scriptPath,
    `import fs from 'node:fs';
const [, , promptFile, prompt] = process.argv;
fs.writeFileSync(promptFile, prompt, 'utf8');
if (${JSON.stringify(mode)} === 'invalid') {
  process.stdout.write('not-json');
  process.exit(0);
}
if (${JSON.stringify(mode)} === 'error') {
  process.stderr.write('boom');
  process.exit(1);
}
process.stdout.write(JSON.stringify([
  {
    title: 'Add flaky nightly coverage',
    description: 'Exercise flaky nightly paths.',
    priority: 'high',
    taskType: 'testing'
  },
  {
    title: 'Tighten budget handoff logging',
    description: 'Capture threshold decisions in reports.',
    priority: 'medium',
    taskType: 'refactor'
  },
  {
    title: 'Document nightly dry run output',
    description: 'Keep dry-run summary stable.',
    priority: 'low',
    taskType: 'documentation'
  }
]));`,
    'utf8',
  );
  return scriptPath;
}

function makeCustomAgent(name: string, scriptPath: string, promptPath: string): CustomAgentDef {
  return {
    name,
    type: 'cli',
    enabled: true,
    invoke: {
      headless: {
        cmd: 'node',
        args: [scriptPath, promptPath, '{prompt}'],
      },
    },
  } as CustomAgentDef;
}

afterEach(() => {
  invalidateConfigCache();
  _resetRegistry();
  initAgentRegistry();

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('hydra-nightly helper behavior', () => {
  const formatDuration = loadHelper(nightlySourcePath, 'formatDuration') as (ms: number) => string;
  const buildThresholds = loadHelper(nightlySourcePath, 'buildThresholds') as (
    budgetCfg: Record<string, unknown>,
  ) => Array<{ pct: number; action: string; once?: boolean }>;
  const truncate = loadHelper(nightlySourcePath, 'truncate') as (
    text: string,
    maxLen: number,
  ) => string;
  const sourceRank = loadHelper(nightlySourcePath, 'sourceRank', {
    consts: ['SOURCE_ORDER'],
  }) as (source: string) => number;
  const generateReportJSON = loadHelper(nightlySourcePath, 'generateReportJSON') as (
    results: Array<Record<string, unknown>>,
    budgetSummary: Record<string, unknown>,
    runMeta: Record<string, unknown>,
  ) => Record<string, unknown>;
  const generateReportMd = loadHelper(nightlySourcePath, 'generateReportMd', {
    functions: ['formatDuration'],
  }) as (
    results: Array<Record<string, unknown>>,
    budgetSummary: Record<string, unknown>,
    runMeta: Record<string, unknown>,
  ) => string;
  const buildTaskPrompt = loadHelper(nightlySourcePath, 'buildTaskPrompt', {
    context: {
      getAgentInstructionFile: () => 'COPILOT.md',
      buildSafetyPrompt: () => '[[SAFETY]]',
      BASE_PROTECTED_FILES: ['README.md'],
      BLOCKED_COMMANDS: ['rm -rf'],
      Set,
    },
  }) as (
    task: ScannedTask,
    branchName: string,
    projectRoot: string,
    agent: string,
    opts?: { isHandoff?: boolean },
  ) => string;

  it('formats durations in seconds, minutes, and hours', () => {
    assert.equal(formatDuration(999), '0s');
    assert.equal(formatDuration(61_000), '1m 1s');
    assert.equal(formatDuration(3_660_000), '1h 1m');
  });

  it('builds budget thresholds with a configurable handoff threshold', () => {
    const defaults = buildThresholds({});
    const custom = buildThresholds({ handoffThreshold: 0.62 });

    assert.deepEqual(
      normalize(defaults.map((entry) => entry.action)),
      ['hard_stop', 'soft_stop', 'handoff', 'warn'],
    );
    assert.equal(defaults[2]?.pct, 0.7);
    assert.equal(defaults[2]?.once, true);
    assert.equal(custom[2]?.pct, 0.62);
  });

  it('orders source groups predictably and places unknown sources last', () => {
    assert.equal(sourceRank('todo-md'), 0);
    assert.equal(sourceRank('ai-discovery'), 4);
    assert.equal(sourceRank('something-else'), 5);
  });

  it('truncates long labels with a single ellipsis', () => {
    assert.equal(truncate('nightly', 10), 'nightly');
    assert.equal(truncate('nightly characterization', 10), 'nightly c…');
  });

  it('builds task prompts with handoff context and source references', () => {
    const prompt = buildTaskPrompt(
      makeTask('Audit nightly branch cleanup', {
        source: 'todo-comment',
        sourceRef: 'lib/hydra-nightly.ts:10',
        body: 'Keep the change minimal.',
      }),
      'nightly/2026-01-01/audit-nightly',
      '/repo',
      'codex',
      { isHandoff: true },
    );

    assert.match(prompt, /Read the project's COPILOT\.md/);
    assert.match(prompt, /\*\*Source:\*\* todo-comment \(lib\/hydra-nightly\.ts:10\)/);
    assert.match(prompt, /taking over from a previous agent/);
    assert.match(prompt, /\[\[SAFETY\]\]/);
  });

  it('serializes report JSON with nightly result fields only', () => {
    const json = generateReportJSON(
      [
        {
          slug: 'nightly-task',
          title: 'Nightly task',
          branch: 'nightly/2026-01-01/nightly-task',
          source: 'ai-discovery',
          taskType: 'testing',
          status: 'partial',
          agent: 'codex',
          tokensUsed: 42,
          durationMs: 3_200,
          commits: 1,
          filesChanged: 2,
          verification: 'FAIL',
          violations: [{ severity: 'warn', detail: 'kept branch dirty' }],
          error: 'ignored in report',
        },
      ],
      { consumed: 42, hardLimit: 500 },
      {
        startedAt: 1,
        finishedAt: 2,
        date: '2026-01-01',
        baseBranch: 'dev',
        totalTasks: 1,
        processedTasks: 1,
      },
    );

    assert.equal(json['date'], '2026-01-01');
    assert.deepEqual(normalize(json['budget']), { consumed: 42, hardLimit: 500 });
    assert.deepEqual(normalize(json['results']), [
      {
        slug: 'nightly-task',
        title: 'Nightly task',
        branch: 'nightly/2026-01-01/nightly-task',
        source: 'ai-discovery',
        taskType: 'testing',
        status: 'partial',
        agent: 'codex',
        tokensUsed: 42,
        durationMs: 3_200,
        commits: 1,
        filesChanged: 2,
        verification: 'FAIL',
        violations: [{ severity: 'warn', detail: 'kept branch dirty' }],
      },
    ]);
  });

  it('renders markdown reports with stop reasons, violations, and quick commands', () => {
    const markdown = generateReportMd(
      [
        {
          slug: 'nightly-task',
          branch: 'nightly/2026-01-01/nightly-task',
          source: 'ai-discovery',
          taskType: 'testing',
          status: 'success',
          agent: 'codex',
          tokensUsed: 1_234,
          commits: 2,
          filesChanged: 4,
          verification: 'PASS',
          violations: [{ severity: 'warn', detail: 'protected file touched' }],
          durationMs: 62_000,
        },
      ],
      {
        consumed: 1_234,
        hardLimit: 5_000,
        avgPerTask: 1_234,
        taskDeltas: [{ label: 'nightly-task', tokens: 1_234, durationMs: 62_000 }],
      },
      {
        startedAt: Date.UTC(2026, 0, 1, 1, 0, 0),
        finishedAt: Date.UTC(2026, 0, 1, 1, 2, 2),
        date: '2026-01-01',
        baseBranch: 'dev',
        sources: { 'ai-discovery': 1 },
        totalTasks: 1,
        processedTasks: 1,
        stopReason: 'soft budget limit',
      },
    );

    assert.match(markdown, /Nightly Run - 2026-01-01/);
    assert.match(markdown, /stopped: soft budget limit/);
    assert.match(markdown, /\*\*Violations:\*\* 1/);
    assert.match(markdown, /git diff dev\.\.\.nightly\/2026-01-01\/<slug>/);
    assert.match(markdown, /\| nightly-task \| 1,234 \| 1m 2s \|/);
  });
});

describe('hydra-nightly phase contracts', () => {
  const noopLog = {
    phase: () => {},
    info: () => {},
    warn: () => {},
    ok: () => {},
    error: () => {},
    dim: () => {},
    task: () => {},
  };

  it('phaseScan merges scanner output with config-defined tasks when enabled', () => {
    const phaseScan = loadHelper(nightlySourcePath, 'phaseScan', {
      context: {
        log: noopLog,
        scanAllSources: () => [
          makeTask('First TODO', {}, 'todo-comment'),
          makeTask('Tracked issue', { source: 'github-issue', sourceRef: '#123' }, 'github-issue'),
        ],
        createUserTask,
      },
    }) as (
      projectRoot: string,
      nightlyCfg: NightlyConfig,
    ) => { tasks: ScannedTask[]; sourceCounts: Record<string, number> };

    const result = phaseScan('/repo', {
      sources: { configTasks: true },
      tasks: ['Stabilize nightly dry run', 'Review nightly summary output'],
    } as NightlyConfig);

    assert.equal(result.tasks.length, 4);
    assert.deepEqual(normalize(result.sourceCounts), {
      'todo-comment': 1,
      'github-issue': 1,
      config: 2,
    });
    assert.deepEqual(
      normalize(result.tasks.slice(-2).map((task) => task.title)),
      ['Stabilize nightly dry run', 'Review nightly summary output'],
    );
  });

  it('phaseDiscover short-circuits when AI discovery is disabled', async () => {
    let called = false;
    const phaseDiscover = loadHelper(nightlySourcePath, 'phaseDiscover', {
      context: {
        log: noopLog,
        runDiscovery: () => {
          called = true;
          return Promise.resolve([]);
        },
      },
    }) as (
      projectRoot: string,
      existingTasks: ScannedTask[],
      nightlyCfg: NightlyConfig,
    ) => Promise<ScannedTask[]>;

    const result = await phaseDiscover(
      '/repo',
      [makeTask('Queued nightly task')],
      { sources: { aiDiscovery: false } } as NightlyConfig,
    );

    assert.deepEqual(normalize(result), []);
    assert.equal(called, false);
  });

  it('phaseDiscover forwards config-driven options and existing task titles to discovery', async () => {
    let received: Record<string, unknown> | null = null;
    const discoveredTask = makeTask('Discovery task', { source: 'ai-discovery' as ScannedTask['source'] });
    const phaseDiscover = loadHelper(nightlySourcePath, 'phaseDiscover', {
      context: {
        log: noopLog,
        runDiscovery: (_projectRoot: string, options: Record<string, unknown>) => {
          received = options;
          return Promise.resolve([discoveredTask]);
        },
      },
    }) as (
      projectRoot: string,
      existingTasks: ScannedTask[],
      nightlyCfg: NightlyConfig,
    ) => Promise<ScannedTask[]>;

    const result = await phaseDiscover(
      '/repo',
      [makeTask('Queued nightly task'), makeTask('Another queued task')],
      {
        sources: { aiDiscovery: true },
        aiDiscovery: {
          agent: 'gemini',
          maxSuggestions: 3,
          focus: ['tests', 'budgets'],
          timeoutMs: 15_000,
        },
      } as NightlyConfig,
    );

    assert.deepEqual(normalize(result), [normalize(discoveredTask)]);
    assert.deepEqual(normalize(received), {
      agent: 'gemini',
      maxSuggestions: 3,
      focus: ['tests', 'budgets'],
      timeoutMs: 15_000,
      existingTasks: ['Queued nightly task', 'Another queued task'],
    });
  });

  it('phasePrioritize deduplicates, sorts, and caps nightly tasks', () => {
    const phasePrioritize = loadHelper(nightlySourcePath, 'phasePrioritize', {
      context: {
        log: noopLog,
        deduplicateTasks,
        prioritizeTasks,
        pc,
      },
    }) as (allTasks: ScannedTask[], maxTasks: number) => ScannedTask[];

    const prioritized = phasePrioritize(
      [
        makeTask('Refactor old branch cleanup', { priority: 'low' }),
        makeTask('Fix nightly crash in review summary', { priority: 'high' }),
        makeTask('Fix nightly crash in review summary', { priority: 'high' }),
        makeTask('Improve nightly logging', { priority: 'medium' }),
      ],
      2,
    );

    assert.deepEqual(
      prioritized.map((task) => task.title),
      ['Fix nightly crash in review summary', 'Improve nightly logging'],
    );
  });

  it('phaseExecute halts before work starts when the hard budget limit is reached', async () => {
    const buildThresholds = loadHelper(nightlySourcePath, 'buildThresholds') as (
      budgetCfg: Record<string, unknown>,
    ) => unknown[];
    const phaseExecute = loadHelper(nightlySourcePath, 'phaseExecute', {
      functions: ['formatDuration', 'buildThresholds'],
      context: {
        log: noopLog,
        renderProgress: () => {},
        getCurrentBranch: () => 'dev',
        buildThresholds,
        BudgetTracker: class {
          hardLimit: number;

          constructor(options: Record<string, number>) {
            this.hardLimit = options['hardLimit'] ?? 0;
          }

          recordStart() {}

          getSummary() {
            return { consumed: this.hardLimit, hardLimit: this.hardLimit };
          }

          check() {
            return {
              action: 'hard_stop',
              reason: 'Hard limit reached: 95% of budget used',
              canFitNextTask: false,
            };
          }
        },
      },
    }) as (
      tasks: ScannedTask[],
      projectRoot: string,
      nightlyCfg: NightlyConfig,
      startedAt: number,
    ) => Promise<{ results: unknown[]; stopReason: string | null }>;

    const result = await phaseExecute(
      [makeTask('Guard budget stop')],
      '/repo',
      {
        baseBranch: 'dev',
        branchPrefix: 'nightly',
        budget: { hardLimit: 100 },
      } as NightlyConfig,
      Date.now(),
    );

    assert.deepEqual(normalize(result.results), []);
    assert.equal(result.stopReason, 'hard budget limit');
  });

  it('phaseReport writes paired markdown and json reports for review tooling', () => {
    const formatDuration = loadHelper(nightlySourcePath, 'formatDuration') as (ms: number) => string;
    const generateReportJSON = loadHelper(nightlySourcePath, 'generateReportJSON') as (
      results: Array<Record<string, unknown>>,
      budgetSummary: Record<string, unknown>,
      runMeta: Record<string, unknown>,
    ) => Record<string, unknown>;
    const generateReportMd = loadHelper(nightlySourcePath, 'generateReportMd', {
      context: { formatDuration },
    }) as (
      results: Array<Record<string, unknown>>,
      budgetSummary: Record<string, unknown>,
      runMeta: Record<string, unknown>,
    ) => string;
    const phaseReport = loadHelper(nightlySourcePath, 'phaseReport', {
      context: {
        log: noopLog,
        ensureDir,
        fs,
        path,
        generateReportJSON,
        generateReportMd,
      },
    }) as (
      results: Array<Record<string, unknown>>,
      budget: { getSummary: () => Record<string, unknown> },
      runMeta: Record<string, unknown>,
      coordDir: string,
    ) => { mdPath: string; jsonPath: string; budgetSummary: Record<string, unknown> };

    const coordDir = path.join(makeTempDir(), 'docs', 'coordination');
    const result = phaseReport(
      [
        {
          slug: 'nightly-task',
          title: 'Nightly task',
          branch: 'nightly/2026-01-01/nightly-task',
          source: 'ai-discovery',
          taskType: 'testing',
          status: 'success',
          agent: 'codex',
          tokensUsed: 5,
          durationMs: 1_000,
          commits: 1,
          filesChanged: 1,
          verification: 'PASS',
          violations: [],
        },
      ],
      {
        getSummary: () => ({ consumed: 5, hardLimit: 500, avgPerTask: 5 }),
      },
      {
        startedAt: Date.UTC(2026, 0, 1, 0, 0, 0),
        finishedAt: Date.UTC(2026, 0, 1, 0, 0, 1),
        date: '2026-01-01',
        baseBranch: 'dev',
        sources: { 'ai-discovery': 1 },
        totalTasks: 1,
        processedTasks: 1,
      },
      coordDir,
    );

    assert.ok(fs.existsSync(result.mdPath));
    assert.ok(fs.existsSync(result.jsonPath));
    assert.equal(result.budgetSummary['consumed'], 5);

    const json = JSON.parse(fs.readFileSync(result.jsonPath, 'utf8')) as Record<string, unknown>;
    assert.equal(json['baseBranch'], 'dev');
    assert.equal((json['results'] as Array<Record<string, unknown>>)[0]?.['slug'], 'nightly-task');

    const markdown = fs.readFileSync(result.mdPath, 'utf8');
    assert.match(markdown, /npm run nightly:review/);
    assert.match(markdown, /nightly-task \[SUCCESS]/);
  });
});

describe('runDiscovery characterization', () => {
  before(() => {
    _resetRegistry();
    initAgentRegistry();
  });

  it('uses config defaults and maps parsed agent suggestions into scanned tasks', async () => {
    const tempDir = makeTempDir();
    const promptPath = path.join(tempDir, 'prompt.txt');
    const agentName = 'fakecli';
    const scriptPath = writeDiscoveryAgent(tempDir, 'success');

    _setTestConfig({
      nightly: {
        aiDiscovery: {
          agent: agentName,
          maxSuggestions: 2,
          focus: ['tests', 'budget'],
          timeoutMs: 5_000,
        },
      },
      agents: {
        customAgents: [makeCustomAgent(agentName, scriptPath, promptPath)],
      },
    });
    _resetRegistry();
    initAgentRegistry();

    const tasks = await runDiscovery(tempDir, {
      existingTasks: ['Already queued nightly fix'],
    });

    assert.equal(tasks.length, 2);
    assert.deepEqual(
      tasks.map((task) => task.source),
      ['ai-discovery', 'ai-discovery'],
    );
    assert.equal(tasks[0]?.sourceRef, `${agentName}-discovery`);
    assert.equal(tasks[0]?.slug, 'add-flaky-nightly-coverage');
    assert.equal(tasks[0]?.priority, 'high');
    assert.equal(tasks[0]?.issueNumber, null);

    const prompt = fs.readFileSync(promptPath, 'utf8');
    assert.match(prompt, /Prioritize tasks related to: tests, budget/);
    assert.match(prompt, /Already queued nightly fix/);
  });

  it('returns an empty result when agent output cannot be parsed as a JSON task array', async () => {
    const tempDir = makeTempDir();
    const promptPath = path.join(tempDir, 'prompt.txt');
    const agentName = 'invalidcli';
    const scriptPath = writeDiscoveryAgent(tempDir, 'invalid');

    _setTestConfig({
      agents: {
        customAgents: [makeCustomAgent(agentName, scriptPath, promptPath)],
      },
    });
    _resetRegistry();
    initAgentRegistry();

    const tasks = await runDiscovery(tempDir, { agent: agentName });

    assert.deepEqual(tasks, []);
  });

  it('returns an empty result when the discovery agent fails', async () => {
    const tempDir = makeTempDir();
    const promptPath = path.join(tempDir, 'prompt.txt');
    const agentName = 'errorcli';
    const scriptPath = writeDiscoveryAgent(tempDir, 'error');

    _setTestConfig({
      agents: {
        customAgents: [makeCustomAgent(agentName, scriptPath, promptPath)],
      },
    });
    _resetRegistry();
    initAgentRegistry();

    const tasks = await runDiscovery(tempDir, { agent: agentName, timeoutMs: 5_000 });

    assert.deepEqual(tasks, []);
  });
});
