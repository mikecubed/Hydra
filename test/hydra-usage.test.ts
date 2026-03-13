import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _setTestConfig, invalidateConfigCache, loadHydraConfig } from '../lib/hydra-config.ts';
import { recordCallComplete, recordCallStart, resetMetrics } from '../lib/hydra-metrics.ts';
import { checkUsage, checkWindowBudget, parseStatsCache } from '../lib/hydra-usage.ts';

const tempDirs = new Set<string>();
const originalCwd = process.cwd();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-usage-test-'));
  tempDirs.add(dir);
  return dir;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(year)}-${month}-${day}`;
}

function localDateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
}

function createIsolatedProject(): string {
  const projectRoot = makeTempDir();
  fs.mkdirSync(path.join(projectRoot, 'docs', 'coordination'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'hydra-usage-test-fixture' }),
    'utf8',
  );
  process.chdir(projectRoot);
  return projectRoot;
}

function writeStatsCache(
  dir: string,
  entries: Array<{ date: string; model: string; tokens: number }>,
): string {
  const statsPath = path.join(dir, 'stats-cache.json');
  const dailyModelTokens = entries.map((entry) => ({
    date: entry.date,
    tokensByModel: { [entry.model]: entry.tokens },
  }));
  fs.writeFileSync(statsPath, `${JSON.stringify({ version: 'test', dailyModelTokens })}\n`, 'utf8');
  return statsPath;
}

function setUsageTestConfig(
  options: {
    model?: string;
    dailyBudget?: number;
    weeklyBudget?: number;
    windowBudget?: number;
    warningThresholdPercent?: number;
    criticalThresholdPercent?: number;
  } = {},
): string {
  const model = options.model ?? 'claude-test';
  _setTestConfig({
    models: {
      claude: {
        default: model,
        active: 'default',
      },
    },
    usage: {
      dailyTokenBudget: { [model]: options.dailyBudget ?? 1_000 },
      weeklyTokenBudget: { [model]: options.weeklyBudget ?? 4_000 },
      windowTokenBudget: { [model]: options.windowBudget ?? 500 },
      windowHours: 5,
      warningThresholdPercent: options.warningThresholdPercent ?? 80,
      criticalThresholdPercent: options.criticalThresholdPercent ?? 100,
      claudeStatsPath: 'auto',
    },
  });
  return model;
}

afterEach(() => {
  process.chdir(originalCwd);
  resetMetrics();
  invalidateConfigCache();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

describe('hydra-usage characterization', { concurrency: false }, () => {
  it('parses today separately and excludes data outside the rolling weekly window', () => {
    const projectRoot = createIsolatedProject();
    const model = setUsageTestConfig({ weeklyBudget: 10_000 });
    const statsPath = writeStatsCache(projectRoot, [
      { date: localDateOffset(0), model, tokens: 50 },
      { date: localDateOffset(-1), model, tokens: 500 },
      { date: localDateOffset(-6), model, tokens: 200 },
      { date: localDateOffset(-7), model, tokens: 700 },
    ]);

    const stats = parseStatsCache(statsPath);

    assert.equal(stats.found, true);
    assert.equal(stats.totalTokensToday, 50);
    assert.deepEqual(stats.tokensByModel, { [model]: 50 });
    assert.equal(stats.totalTokensWeekly, 750);
    assert.deepEqual(stats.weeklyTokensByModel, { [model]: 750 });
    assert.equal(stats.weeklyDayCount, 3);
  });

  it('allows usage that stays below the configured daily budget', () => {
    const projectRoot = createIsolatedProject();
    const model = setUsageTestConfig();
    const statsPath = writeStatsCache(projectRoot, [
      { date: localDateOffset(0), model, tokens: 799 },
    ]);

    const usage = checkUsage({ statsPath });

    assert.equal(usage.ok, true);
    assert.equal(usage.level, 'normal');
    assert.equal(usage.percent, 79.9);
    assert.equal(usage.model, model);
    assert.equal(usage.budget, 1_000);
    assert.equal(usage.used, 799);
    assert.equal(usage.remaining, 201);
    assert.equal(usage.todayTokens, 799);
    assert.equal(usage.agents['claude'].source, 'stats-cache');
    assert.equal(usage.agents['claude'].tracked, true);
  });

  it('treats exact daily budget exhaustion as a critical block', () => {
    const projectRoot = createIsolatedProject();
    const model = setUsageTestConfig();
    const statsPath = writeStatsCache(projectRoot, [
      { date: localDateOffset(0), model, tokens: 1_000 },
    ]);

    const usage = checkUsage({ statsPath });

    assert.equal(usage.ok, false);
    assert.equal(usage.level, 'critical');
    assert.equal(usage.percent, 100);
    assert.equal(usage.used, 1_000);
    assert.equal(usage.remaining, 0);
    assert.equal(usage.agents['claude'].level, 'critical');
  });

  it('escalates to the weekly budget when the rolling seven-day total is tighter than daily usage', () => {
    const projectRoot = createIsolatedProject();
    const model = setUsageTestConfig({ weeklyBudget: 3_000 });
    const statsPath = writeStatsCache(projectRoot, [
      { date: localDateOffset(0), model, tokens: 100 },
      { date: localDateOffset(-1), model, tokens: 500 },
      { date: localDateOffset(-2), model, tokens: 500 },
      { date: localDateOffset(-3), model, tokens: 500 },
      { date: localDateOffset(-4), model, tokens: 500 },
      { date: localDateOffset(-5), model, tokens: 500 },
      { date: localDateOffset(-6), model, tokens: 500 },
    ]);

    const usage = checkUsage({ statsPath });

    assert.equal(usage.ok, false);
    assert.equal(usage.level, 'critical');
    assert.equal(usage.weekly.level, 'critical');
    assert.equal(usage.weekly.percent, 103.3);
    assert.equal(usage.weekly.totalTokens, 3_100);
    assert.equal(usage.weekly.daysCovered, 7);
    assert.equal(usage.weekly.agents['claude'].weeklyBudget, 3_000);
    assert.equal(usage.weekly.agents['claude'].weeklyTokens, 3_100);
    assert.match(usage.message, /weekly usage 103\.3%/);
  });

  it('blocks sliding-window usage when recent real tokens exceed the configured window budget', () => {
    createIsolatedProject();
    const model = setUsageTestConfig({ windowBudget: 500 });
    const handle = recordCallStart('claude', model);
    recordCallComplete(handle, {
      output: '',
      tokenUsage: { inputTokens: 250, outputTokens: 350, totalTokens: 600 },
      outcome: 'success',
    });

    const window = checkWindowBudget({ windowHours: 5 });

    assert.equal(window.ok, false);
    assert.equal(window.level, 'critical');
    assert.equal(window.percent, 120);
    assert.ok(window.tightest);
    assert.equal(window.tightest.agent, 'claude');
    assert.equal(window.tightest.windowTokens, 600);
    assert.equal(window.agents['claude'].realTokens, 600);
    assert.equal(window.agents['claude'].estimatedTokens, 0);
    assert.equal(window.agents['claude'].windowBudget, 500);
  });

  it('uses session token metrics as the fallback source for totals and per-agent accounting', () => {
    createIsolatedProject();
    const model = setUsageTestConfig({
      dailyBudget: 1_000,
      weeklyBudget: 4_000,
      windowBudget: 500,
    });
    const handle = recordCallStart('claude', model);
    recordCallComplete(handle, {
      output: '',
      tokenUsage: { inputTokens: 120, outputTokens: 180, totalTokens: 300 },
      outcome: 'success',
    });

    const usage = checkUsage({ statsPath: path.join(process.cwd(), 'missing-stats-cache.json') });

    assert.equal(usage.ok, true);
    assert.equal(usage.todayTokens, 300);
    assert.equal(usage.used, 300);
    assert.equal(usage.budget, 1_000);
    assert.equal(usage.remaining, 700);
    assert.equal(usage.agents['claude'].todayTokens, 300);
    assert.equal(usage.agents['claude'].used, 300);
    assert.equal(usage.agents['claude'].source, 'hydra-metrics-real');
    assert.equal(usage.agents['claude'].confidence, 'medium');
    assert.equal(usage.agents['claude'].model, model);
  });

  it('falls back to hydra-config default budgets when usage overrides are absent', () => {
    const projectRoot = createIsolatedProject();
    _setTestConfig({});
    const config = loadHydraConfig();
    const budgetedModel = Object.keys(config.usage.dailyTokenBudget ?? {})[0];
    assert.ok(budgetedModel);
    const statsPath = writeStatsCache(projectRoot, [
      { date: localDateOffset(0), model: budgetedModel, tokens: 1 },
    ]);

    const usage = checkUsage({ statsPath });
    const dailyBudget = config.usage.dailyTokenBudget?.[budgetedModel];
    const weeklyBudget = config.usage.weeklyTokenBudget?.[budgetedModel];

    assert.equal(usage.model, budgetedModel);
    assert.equal(usage.budget, dailyBudget);
    assert.equal(usage.weekly.agents['claude'].weeklyBudget, weeklyBudget);
  });
});
