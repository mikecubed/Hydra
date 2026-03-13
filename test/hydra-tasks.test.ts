import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { initAgentRegistry } from '../lib/hydra-agents.ts';
import { _setTestConfig, invalidateConfigCache } from '../lib/hydra-config.ts';
import {
  createUserTask,
  deduplicateTasks,
  prioritizeTasks,
  scanAllSources,
  scanTodoComments,
  scanTodoMd,
} from '../lib/hydra-tasks-scanner.ts';

const tempDirs = new Set<string>();
const tempModules = new Set<string>();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-tasks-test-'));
  tempDirs.add(dir);
  return dir;
}

function writeFixtureFiles(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

// Build a clean env without git overrides so test-spawned git commands use
// the cwd-local repo, not whatever GIT_DIR the parent process inherited.
const {
  GIT_DIR: _gitDir,
  GIT_WORK_TREE: _gitWorkTree,
  GIT_INDEX_FILE: _gitIndexFile,
  GIT_OBJECT_DIRECTORY: _gitObjDir,
  ...cleanEnv
} = process.env;

function initGitRepo(root: string): void {
  const opts = { cwd: root, stdio: 'ignore' as const, env: cleanEnv };
  execFileSync('git', ['init', '-b', 'main'], opts);
  execFileSync('git', ['config', 'user.name', 'Hydra Tests'], opts);
  execFileSync('git', ['config', 'user.email', 'hydra-tests@example.com'], opts);
  execFileSync('git', ['add', '.'], opts);
  execFileSync('git', ['commit', '-m', 'fixture'], opts);
}

async function loadHydraTasksInternals(): Promise<{
  BUDGET_THRESHOLDS: Array<{ pct: number; action: string; reason: string; once: boolean }>;
}> {
  const sourcePath = path.join(repoRoot, 'lib', 'hydra-tasks.ts');
  const tempModulePath = path.join(
    repoRoot,
    'lib',
    `.hydra-tasks.testable.${String(process.pid)}.${String(Date.now())}.ts`,
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const patchedSource = source.replace(
    /\nmain\(\)\.catch\([\s\S]*$/,
    '\nexport { BUDGET_THRESHOLDS };\n',
  );

  fs.writeFileSync(tempModulePath, patchedSource, 'utf8');
  tempModules.add(tempModulePath);

  return (await import(`${pathToFileURL(tempModulePath).href}?t=${String(Date.now())}`)) as {
    BUDGET_THRESHOLDS: Array<{ pct: number; action: string; reason: string; once: boolean }>;
  };
}

before(() => {
  initAgentRegistry();
});

afterEach(() => {
  invalidateConfigCache();

  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();

  for (const modulePath of tempModules) {
    fs.rmSync(modulePath, { force: true });
  }
  tempModules.clear();
});

describe('hydra-tasks scanner characterization', () => {
  it('parses TODO and FIXME comments with cleaned titles and stable priority heuristics', () => {
    const projectRoot = makeTempDir();
    writeFixtureFiles(projectRoot, {
      'src/parser.ts': [
        'export function parseValue() {',
        '  // TODO: add parser fallback for nested arrays',
        '  return 1;',
        '}',
        '',
      ].join('\n'),
      'src/auth.ts': [
        'export function authorize() {',
        '  return true; // FIXME harden auth retry after crash',
        '}',
        '',
      ].join('\n'),
      'src/noise.ts': '// TODO ok\n',
      'docs/coordination/ignored.ts': '// TODO: this file should be ignored\n',
    });
    initGitRepo(projectRoot);

    const tasks = scanTodoComments(projectRoot);
    const byRef = new Map(tasks.map((task) => [task.sourceRef, task]));

    assert.equal(tasks.length, 2);

    const todoTask = byRef.get('src/parser.ts:2');
    assert.ok(todoTask);
    assert.equal(todoTask.title, 'add parser fallback for nested arrays');
    assert.equal(todoTask.source, 'todo-comment');
    assert.equal(todoTask.priority, 'medium');
    assert.equal(todoTask.slug, 'add-parser-fallback-for-nested-arrays');

    const fixmeTask = byRef.get('src/auth.ts:2');
    assert.ok(fixmeTask);
    assert.equal(fixmeTask.title, 'harden auth retry after crash');
    assert.equal(fixmeTask.priority, 'high');
    assert.equal(fixmeTask.issueNumber, null);
  });

  it('parses docs TODO items in section-priority order and strips markdown formatting', () => {
    const projectRoot = makeTempDir();
    writeFixtureFiles(projectRoot, {
      'docs/TODO.md': [
        '## 4. Backlog - Tier 2',
        '- [ ] **Refactor** [task scheduler](https://example.test) for reuse',
        '',
        '## 1. Alpha Blockers',
        '- [ ] Fix crash in task runner',
        '',
        '## Misc',
        '- [ ] Docs cleanup for operators',
        '',
      ].join('\n'),
    });

    const tasks = scanTodoMd(projectRoot);

    assert.deepEqual(
      tasks.map((task) => task.title),
      [
        'Fix crash in task runner',
        'Refactor task scheduler for reuse',
        'Docs cleanup for operators',
      ],
    );
    assert.deepEqual(
      tasks.map((task) => task.sourceRef),
      ['Alpha Blockers', 'Backlog - Tier 2', 'Misc'],
    );
  });

  it('deduplicates tasks by slug and preserves the first occurrence', () => {
    const first = createUserTask('Fix auth retry bug');
    const duplicate = {
      ...createUserTask('fix auth retry bug!'),
      id: 'todo-comment:src/auth.ts:10',
      source: 'todo-comment' as const,
      sourceRef: 'src/auth.ts:10',
    };

    const deduped = deduplicateTasks([first, duplicate]);

    assert.equal(deduped.length, 1);
    assert.equal(deduped[0].id, first.id);
    assert.equal(deduped[0].source, 'user-input');
  });

  it('classifies priority bands and sorts tasks by priority then complexity', () => {
    assert.equal(createUserTask('Investigate security crash in auth flow').priority, 'high');
    assert.equal(createUserTask('Docs cleanup for README').priority, 'low');
    assert.equal(createUserTask('Implement queue retry policy').priority, 'medium');

    const prioritized = prioritizeTasks([
      { ...createUserTask('docs cleanup'), id: 'low', priority: 'low', complexity: 'simple' },
      {
        ...createUserTask('Fix crash'),
        id: 'high-complex',
        priority: 'high',
        complexity: 'complex',
      },
      { ...createUserTask('Fix bug'), id: 'high-simple', priority: 'high', complexity: 'simple' },
      {
        ...createUserTask('Implement cache warming'),
        id: 'medium',
        priority: 'medium',
        complexity: 'moderate',
      },
    ]);

    assert.deepEqual(
      prioritized.map((task) => task.id),
      ['high-simple', 'high-complex', 'medium', 'low'],
    );
  });

  it('honors config-enabled task sources when scanning all sources', () => {
    const projectRoot = makeTempDir();
    writeFixtureFiles(projectRoot, {
      'src/parser.ts': '// TODO: add tokenizer support\n',
      'docs/TODO.md': '## Alpha Blockers\n- [ ] Fix crash in task runner\n',
    });
    initGitRepo(projectRoot);

    _setTestConfig({
      tasks: {
        sources: {
          todoComments: true,
          todoMd: false,
          githubIssues: false,
        },
      },
    });

    const tasks = scanAllSources(projectRoot);

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].source, 'todo-comment');
    assert.equal(tasks[0].title, 'add tokenizer support');
  });

  it('lets explicit scan options override disabled task-source config', () => {
    const projectRoot = makeTempDir();
    writeFixtureFiles(projectRoot, {
      'src/parser.ts': '// TODO: add tokenizer support\n',
      'docs/TODO.md': '## Alpha Blockers\n- [ ] Fix crash in task runner\n',
    });
    initGitRepo(projectRoot);

    _setTestConfig({
      tasks: {
        sources: {
          todoComments: false,
          todoMd: false,
          githubIssues: false,
        },
      },
    });

    const tasks = scanAllSources(projectRoot, {
      todoComments: true,
      todoMd: true,
      githubIssues: false,
    });

    assert.deepEqual(
      tasks.map((task) => task.source),
      ['todo-md', 'todo-comment'],
    );
  });

  it('keeps the hydra-tasks budget thresholds in warn-to-stop order', async () => {
    const { BUDGET_THRESHOLDS } = await loadHydraTasksInternals();

    assert.deepEqual(
      BUDGET_THRESHOLDS.map((threshold) => [threshold.pct, threshold.action, threshold.once]),
      [
        [0.95, 'hard_stop', false],
        [0.85, 'soft_stop', true],
        [0.7, 'handoff_cheap', true],
        [0.5, 'warn', true],
      ],
    );
    assert.match(BUDGET_THRESHOLDS[0].reason, /hard stop/i);
    assert.match(BUDGET_THRESHOLDS[2].reason, /economy tier/i);
  });
});
