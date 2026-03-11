/**
 * Hydra Eval Harness — Routing accuracy evaluation against golden corpora.
 *
 * Evaluates classifyPrompt() and bestAgentFor() against labeled test cases.
 * Generates JSON + Markdown reports to docs/coordination/eval/.
 *
 * Usage:
 *   node lib/hydra-eval.ts                     # Run with default corpus
 *   node lib/hydra-eval.ts path/to/corpus.json  # Run with custom corpus
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyPrompt } from './hydra-utils.ts';
import { bestAgentFor, classifyTask, initAgentRegistry } from './hydra-agents.ts';
import { loadHydraConfig, HYDRA_ROOT } from './hydra-config.ts';

const EVAL_DIR = path.join(HYDRA_ROOT, 'docs', 'coordination', 'eval');

interface CorpusEntry {
  prompt: string;
  expected: {
    routeStrategy?: string;
    taskType?: string;
    agent?: string;
  };
}

interface StratCounter {
  correct: number;
  total: number;
}

interface StratResult extends StratCounter {
  accuracy: number;
}

interface RoutingMismatch {
  prompt: string;
  expectedRoute: string | undefined;
  actualRoute: string;
  expectedTaskType: string | undefined;
  actualTaskType: string;
  routeMatch: boolean;
  taskTypeMatch: boolean;
  confidence: number | undefined;
  reason: string | undefined;
}

interface RoutingResults {
  total: number;
  correct: number;
  accuracy: number;
  perStrategy: Record<string, StratResult>;
  perTaskType: Record<string, StratResult>;
  mismatches: RoutingMismatch[];
}

interface AgentMismatch {
  prompt: string;
  expectedAgent: string;
  actualAgent: string;
  taskType: string;
}

interface AgentSelectionResults {
  total: number;
  correct: number;
  accuracy: number;
  mismatches: AgentMismatch[];
}

/**
 * Load a golden corpus from a JSON file.
 * @param {string[]} paths - Paths to corpus JSON files
 * @returns {Array<{prompt: string, expected: object}>}
 */
export function loadGoldenCorpus(paths: string[]): CorpusEntry[] {
  const corpus: CorpusEntry[] = [];
  for (const p of paths) {
    const resolved = path.isAbsolute(p) ? p : path.join(HYDRA_ROOT, p);
    try {
      const raw = fs.readFileSync(resolved, 'utf8');
      const data = JSON.parse(raw) as unknown;
      const asRecord =
        typeof data === 'object' && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : null;
      if (asRecord && Array.isArray(asRecord['corpus'])) {
        corpus.push(...(asRecord['corpus'] as CorpusEntry[]));
      } else if (Array.isArray(data)) {
        corpus.push(...(data as CorpusEntry[]));
      }
    } catch (err) {
      console.error(`Failed to load corpus ${p}: ${(err as Error).message}`);
    }
  }
  return corpus;
}

/**
 * Evaluate routing classification accuracy.
 * @param {CorpusEntry[]} corpus
 * @returns {RoutingResults} Evaluation results
 */
export function evaluateRouting(corpus: CorpusEntry[]): RoutingResults {
  let correct = 0;
  const perStrategy: Record<string, StratCounter> = {
    single: { correct: 0, total: 0 },
    tandem: { correct: 0, total: 0 },
    council: { correct: 0, total: 0 },
  };
  const perTaskType: Record<string, StratCounter> = {};
  const mismatches: RoutingMismatch[] = [];

  for (const entry of corpus) {
    const result = classifyPrompt(entry.prompt);
    const expectedRoute = entry.expected.routeStrategy;
    const expectedTaskType = entry.expected.taskType;

    // Route strategy match
    const routeMatch = result.routeStrategy === expectedRoute;

    // Task type match (use classifyTask as fallback)
    const actualTaskType = result.taskType || classifyTask(entry.prompt);
    const taskTypeMatch = actualTaskType === expectedTaskType;

    if (routeMatch) correct++;

    // Per-strategy tracking
    if (expectedRoute && Object.hasOwn(perStrategy, expectedRoute)) {
      perStrategy[expectedRoute].total++;
      if (routeMatch) perStrategy[expectedRoute].correct++;
    }

    // Per-task-type tracking
    if (expectedTaskType) {
      if (!Object.hasOwn(perTaskType, expectedTaskType))
        perTaskType[expectedTaskType] = { correct: 0, total: 0 };
      perTaskType[expectedTaskType].total++;
      if (taskTypeMatch) perTaskType[expectedTaskType].correct++;
    }

    if (!routeMatch || !taskTypeMatch) {
      mismatches.push({
        prompt: entry.prompt.slice(0, 100),
        expectedRoute,
        actualRoute: result.routeStrategy ?? '',
        expectedTaskType,
        actualTaskType,
        routeMatch,
        taskTypeMatch,
        confidence: result.confidence,
        reason: result.reason,
      });
    }
  }

  const total = corpus.length;
  return {
    total,
    correct,
    accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    perStrategy: Object.fromEntries(
      Object.entries(perStrategy).map(([k, v]) => [
        k,
        { ...v, accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 1000) / 10 : 0 },
      ]),
    ) as Record<string, StratResult>,
    perTaskType: Object.fromEntries(
      Object.entries(perTaskType).map(([k, v]) => [
        k,
        { ...v, accuracy: v.total > 0 ? Math.round((v.correct / v.total) * 1000) / 10 : 0 },
      ]),
    ) as Record<string, StratResult>,
    mismatches,
  };
}

/**
 * Evaluate agent selection accuracy.
 * @param {CorpusEntry[]} corpus
 * @returns {AgentSelectionResults}
 */
export function evaluateAgentSelection(corpus: CorpusEntry[]): AgentSelectionResults {
  let correct = 0;
  const mismatches: AgentMismatch[] = [];

  for (const entry of corpus) {
    if (!entry.expected.agent) continue;
    const taskType = entry.expected.taskType ?? classifyTask(entry.prompt);
    const actual = bestAgentFor(taskType);
    const match = actual === entry.expected.agent;
    if (match) correct++;
    else {
      mismatches.push({
        prompt: entry.prompt.slice(0, 100),
        expectedAgent: entry.expected.agent,
        actualAgent: actual,
        taskType,
      });
    }
  }

  const withAgent = corpus.filter((e) => e.expected.agent).length;
  return {
    total: withAgent,
    correct,
    accuracy: withAgent > 0 ? Math.round((correct / withAgent) * 1000) / 10 : 0,
    mismatches,
  };
}

/**
 * Generate eval reports (JSON + Markdown).
 * @param {RoutingResults} routingResults
 * @param {AgentSelectionResults} [agentResults]
 * @returns {{ jsonPath: string, mdPath: string }}
 */
export function generateEvalReport(
  routingResults: RoutingResults,
  agentResults: AgentSelectionResults | null,
): { jsonPath: string; mdPath: string } {
  if (!fs.existsSync(EVAL_DIR)) fs.mkdirSync(EVAL_DIR, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const data = {
    timestamp: new Date().toISOString(),
    routing: routingResults,
    agentSelection: agentResults ?? null,
  };

  const jsonPath = path.join(EVAL_DIR, `eval_${timestamp}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(data, null, 2)}\n`);

  // Markdown report
  const lines = [
    `# Eval Report — ${new Date().toISOString().slice(0, 16)}`,
    '',
    '## Routing Classification',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total prompts | ${String(routingResults.total)} |`,
    `| Correct routes | ${String(routingResults.correct)} |`,
    `| **Accuracy** | **${String(routingResults.accuracy)}%** |`,
    '',
    '### Per Strategy',
    '',
    `| Strategy | Correct | Total | Accuracy |`,
    `|----------|---------|-------|----------|`,
  ];
  for (const [strategy, stats] of Object.entries(routingResults.perStrategy)) {
    lines.push(
      `| ${strategy} | ${String(stats.correct)} | ${String(stats.total)} | ${String(stats.accuracy)}% |`,
    );
  }

  if (Object.keys(routingResults.perTaskType).length > 0) {
    lines.push(
      '',
      '### Per Task Type',
      '',
      '| Type | Correct | Total | Accuracy |',
      '|------|---------|-------|----------|',
    );
    for (const [type, stats] of Object.entries(routingResults.perTaskType)) {
      lines.push(
        `| ${type} | ${String(stats.correct)} | ${String(stats.total)} | ${String(stats.accuracy)}% |`,
      );
    }
  }

  if (routingResults.mismatches.length > 0) {
    lines.push('', '### Mismatches', '');
    for (const m of routingResults.mismatches.slice(0, 15)) {
      const routeIcon = m.routeMatch ? '' : ` route: ${String(m.expectedRoute)}!=${m.actualRoute}`;
      const typeIcon = m.taskTypeMatch
        ? ''
        : ` type: ${String(m.expectedTaskType)}!=${m.actualTaskType}`;
      lines.push(`- "${m.prompt}"${routeIcon}${typeIcon}`);
    }
    if (routingResults.mismatches.length > 15) {
      lines.push(`- ... and ${String(routingResults.mismatches.length - 15)} more`);
    }
  }

  if (agentResults && agentResults.total > 0) {
    lines.push(
      '',
      '## Agent Selection',
      '',
      `Accuracy: ${String(agentResults.accuracy)}% (${String(agentResults.correct)}/${String(agentResults.total)})`,
    );
    if (agentResults.mismatches.length > 0) {
      lines.push('', '### Mismatches', '');
      for (const m of agentResults.mismatches.slice(0, 10)) {
        lines.push(
          `- "${m.prompt}" — expected ${m.expectedAgent}, got ${m.actualAgent} (${m.taskType})`,
        );
      }
    }
  }

  lines.push('');
  const mdPath = path.join(EVAL_DIR, `eval_${timestamp}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'));

  return { jsonPath, mdPath };
}

// ── CLI Entry Point ──────────────────────────────────────────────────────────

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  // Initialize agent registry
  initAgentRegistry();

  const cfg = loadHydraConfig();
  const argPaths = process.argv.slice(2);
  const cfgEval = cfg.eval as Record<string, unknown> | undefined;
  const cfgPaths = cfgEval?.['corpusPaths'];
  let corpusPaths: string[];
  if (argPaths.length > 0) {
    corpusPaths = argPaths;
  } else if (Array.isArray(cfgPaths)) {
    corpusPaths = cfgPaths as string[];
  } else {
    corpusPaths = ['test/golden/routing-corpus.json'];
  }

  console.log(`Loading corpus from: ${corpusPaths.join(', ')}`);
  const corpus = loadGoldenCorpus(corpusPaths);
  console.log(`Loaded ${String(corpus.length)} test cases`);

  if (corpus.length === 0) {
    console.error('No test cases found.');
    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  }

  console.log('\nEvaluating routing classification...');
  const routingResults = evaluateRouting(corpus);
  console.log(
    `  Route accuracy: ${String(routingResults.accuracy)}% (${String(routingResults.correct)}/${String(routingResults.total)})`,
  );
  for (const [strategy, stats] of Object.entries(routingResults.perStrategy)) {
    if (stats.total > 0) {
      console.log(
        `    ${strategy}: ${String(stats.accuracy)}% (${String(stats.correct)}/${String(stats.total)})`,
      );
    }
  }

  console.log('\nEvaluating agent selection...');
  const agentResults = evaluateAgentSelection(corpus);
  if (agentResults.total > 0) {
    console.log(
      `  Agent accuracy: ${String(agentResults.accuracy)}% (${String(agentResults.correct)}/${String(agentResults.total)})`,
    );
  } else {
    console.log('  (no agent labels in corpus — skipped)');
  }

  if (routingResults.mismatches.length > 0) {
    console.log(`\nMismatches (${String(routingResults.mismatches.length)}):`);
    for (const m of routingResults.mismatches.slice(0, 10)) {
      const parts: string[] = [];
      if (!m.routeMatch) parts.push(`route: ${String(m.expectedRoute)}→${m.actualRoute}`);
      if (!m.taskTypeMatch) parts.push(`type: ${String(m.expectedTaskType)}→${m.actualTaskType}`);
      console.log(`  "${m.prompt.slice(0, 60)}" — ${parts.join(', ')}`);
    }
  }

  const { jsonPath, mdPath } = generateEvalReport(routingResults, agentResults);
  console.log(`\nReports saved:`);
  console.log(`  JSON: ${path.relative(HYDRA_ROOT, jsonPath)}`);
  console.log(`  MD:   ${path.relative(HYDRA_ROOT, mdPath)}`);
}
