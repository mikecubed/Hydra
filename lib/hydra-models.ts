/**
 * Hydra Model Discovery — List all available models per agent.
 *
 * Strategy per agent (tries in order, stops at first success):
 *   1. Hit provider REST API with env key  (instant, complete)
 *   2. Ask the CLI with a cheap/fast model  (uses auth the CLI already has)
 *   3. Show only Hydra-configured models    (always available, incomplete)
 *
 * Usage:
 *   node lib/hydra-models.mjs               # all agents
 *   node lib/hydra-models.mjs claude         # one agent
 *   node lib/hydra-models.mjs codex
 *   node lib/hydra-models.mjs gemini
 *
 * npm scripts:
 *   npm run models                           # all
 *   npm run models -- claude                 # single
 */

import https from 'node:https';
import path from 'node:path';
// @ts-expect-error — cross-spawn has no bundled types; pre-existing across codebase
import spawn from 'cross-spawn';
import { loadHydraConfig } from './hydra-config.ts';
import { getActiveModel, getReasoningEffort, AGENT_NAMES, AGENTS } from './hydra-agents.ts';
import pc from 'picocolors';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, timeout: 10_000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += String(chunk)));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`Bad JSON from API`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

// ── Strategy 1: REST API with env key ───────────────────────────────────────

async function apiClaude(): Promise<string[] | null> {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (key == null || key === '') return null;
  const data = await httpGet('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  });
  return ((data as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id).sort();
}

async function apiCodex(): Promise<string[] | null> {
  const key = process.env['OPENAI_API_KEY'];
  if (key == null || key === '') return null;
  const data = await httpGet('https://api.openai.com/v1/models', {
    Authorization: `Bearer ${key}`,
  });
  return ((data as { data?: Array<{ id: string }> }).data ?? []).map((m) => m.id).sort();
}

async function apiGemini(): Promise<string[] | null> {
  const key = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'];
  if (key == null || key === '') return null;
  const data = await httpGet(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
  );
  return ((data as { models?: Array<{ name: string }> }).models ?? [])
    .map((m) => m.name.replace('models/', ''))
    .sort();
}

// ── Strategy 2: Ask the CLI (cheap model, tiny prompt) ──────────────────────

const CLAUDE_PROMPT =
  'List every Claude model ID currently available via the Anthropic API. Output ONLY the model IDs, one per line. No markdown, no commentary, no explanation.';
const GEMINI_PROMPT =
  'List every Gemini model ID currently available. Output ONLY the model IDs, one per line. No markdown, no commentary, no explanation.';

function cliClaude() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const r = spawn.sync('claude', ['-p', '--model', 'haiku', '--output-format', 'text'], {
    input: CLAUDE_PROMPT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (r.status !== 0 && r.stdout == null) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
  return parseModelLines(r.stdout);
}

function cliGemini() {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  const r = spawn.sync(
    'gemini',
    ['-p', GEMINI_PROMPT, '-o', 'text', '-m', 'gemini-3-flash-preview'],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  );
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (r.status !== 0 && r.stdout == null) return null;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
  return parseModelLines(r.stdout);
}

function cliCodex() {
  // Codex exec is too slow/expensive for a model listing — skip CLI strategy.
  // Falls back to API (OPENAI_API_KEY) or config-only display.
  return null;
}

/** Parse one-per-line model IDs from noisy CLI output. */
function parseModelLines(raw: string | null | undefined): string[] | null {
  if (raw == null || raw === '') return null;
  const ids = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'))
    .filter((l) => !l.startsWith('Loaded') && !l.startsWith('Hook'))
    .filter((l) => !l.includes(' ')) // model IDs shouldn't have spaces
    .filter((l) => /^[a-z0-9]/.test(l)); // starts with lowercase/digit
  return ids.length > 0 ? ids.sort() : null;
}

// ── Orchestrate per agent ───────────────────────────────────────────────────

const STRATEGIES = {
  claude: { api: apiClaude, cli: cliClaude },
  codex: { api: apiCodex, cli: cliCodex },
  gemini: { api: apiGemini, cli: cliGemini },
};

export async function fetchModels(
  agentName: string,
): Promise<{ models: string[]; source: string }> {
  const strat = (STRATEGIES as Record<string, typeof STRATEGIES.claude | undefined>)[agentName];
  if (!strat) return { models: [], source: 'none' };

  // 1. Try API
  try {
    const models = await strat.api();
    if (models && models.length > 0) return { models, source: 'api' };
  } catch {
    /* fall through */
  }

  // 2. Try CLI
  try {
    const models = strat.cli();
    if (models && models.length > 0) return { models, source: 'cli' };
  } catch {
    /* fall through */
  }

  // 3. Config-only fallback
  return { models: [], source: 'config-only' };
}

// ── Display ─────────────────────────────────────────────────────────────────

function displayPresetsSection(
  agentModels: Record<string, string | undefined>,
  activeModel: string | null | undefined,
): void {
  const presetKeys = ['default', 'fast', 'cheap'];
  console.log(pc.bold('  Presets:'));
  for (const key of presetKeys) {
    if (agentModels[key] != null && agentModels[key] !== '') {
      const marker = agentModels[key] === activeModel ? pc.green(' ◀') : '';
      console.log(`    ${pc.dim(key.padEnd(8))} ${agentModels[key] ?? ''}${marker}`);
    }
  }
}

function displayEffortSection(effort: string | null | undefined): void {
  const effortLevels = ['low', 'medium', 'high', 'xhigh'];
  console.log(pc.bold('  Effort:'));
  const effortLine = effortLevels
    .map((e) => (e === effort ? pc.green(e) + pc.green(' ◀') : pc.dim(e)))
    .join('  ');
  console.log(
    `    ${effort != null && effort !== '' ? effortLine : `${pc.dim('default')}  (${effortLevels.map((e) => pc.dim(e)).join(' | ')})`}`,
  );
}

function displayAliasesSection(aliases: Record<string, string>): void {
  if (Object.keys(aliases).length === 0) return;
  console.log(pc.bold('  Aliases:'));
  for (const [alias, modelId] of Object.entries(aliases)) {
    console.log(`    ${pc.dim(alias.padEnd(12))} → ${modelId}`);
  }
}

function displayAvailableModelsSection(
  models: string[],
  source: string,
  agentModels: Record<string, string | undefined>,
  activeModel: string | null | undefined,
  aliases: Record<string, string>,
): void {
  const presetKeys = ['default', 'fast', 'cheap'];
  let sourceLabel: string;
  if (source === 'api') {
    sourceLabel = 'REST API';
  } else if (source === 'cli') {
    sourceLabel = 'CLI query';
  } else {
    sourceLabel = 'config only';
  }

  if (models.length === 0) {
    console.log(pc.bold(`  Available Models ${pc.dim(`(${sourceLabel})`)}:`));
    console.log(pc.yellow('    Set API key in env for full list, or use CLI aliases above'));
    console.log(
      pc.dim(`    Claude: ANTHROPIC_API_KEY  |  Codex: OPENAI_API_KEY  |  Gemini: GEMINI_API_KEY`),
    );
    return;
  }

  // Build known-set for highlighting
  const knownIds = new Set();
  for (const key of presetKeys) {
    if (agentModels[key] !== '') knownIds.add(agentModels[key]);
  }
  for (const modelId of Object.values(aliases)) knownIds.add(modelId);

  console.log(
    pc.bold(`  Available Models (${String(models.length)}) ${pc.dim(`[${sourceLabel}]`)}:`),
  );
  for (const model of models) {
    const isActive = model === activeModel;
    const isConfigured = knownIds.has(model);
    if (isActive) {
      console.log(`    ${pc.green(model)} ${pc.green('◀ active')}`);
    } else if (isConfigured) {
      console.log(`    ${pc.blue(model)} ${pc.dim('(configured)')}`);
    } else {
      console.log(`    ${model}`);
    }
  }
}

function displayAgent(agentName: string, fetchResult: { models: string[]; source: string }) {
  const cfg = loadHydraConfig();
  const agentModels =
    (cfg.models as Record<string, Record<string, string> | undefined>)[agentName] ?? {};
  const aliases =
    (cfg.aliases as Record<string, Record<string, string> | undefined>)[agentName] ?? {};
  const activeModel = getActiveModel(agentName);
  const agentInfo = (AGENTS as Record<string, { label?: string }>)[agentName];
  const mode = cfg.mode;
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName] ?? 'default';

  console.log('');
  console.log(pc.bold(pc.cyan(`═══ ${agentInfo.label ?? agentName} ═══`)));

  // Active model + reasoning effort
  const effort = getReasoningEffort(agentName);
  const effortStr = effort != null && effort !== '' ? pc.yellow(` [${effort}]`) : '';
  console.log(
    `  Active:  ${pc.green(activeModel ?? 'unknown')}${effortStr} ${pc.dim(`(mode: ${mode} → ${tierPreset})`)}`,
  );

  displayPresetsSection(agentModels, activeModel);
  displayEffortSection(effort);
  displayAliasesSection(aliases);
  displayAvailableModelsSection(
    fetchResult.models,
    fetchResult.source,
    agentModels,
    activeModel,
    aliases,
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  const agents = arg !== '' && AGENT_NAMES.includes(arg) ? [arg] : AGENT_NAMES;

  if (arg !== '' && !AGENT_NAMES.includes(arg)) {
    console.error(pc.red(`Unknown agent: ${arg}`));
    console.error(`Available: ${AGENT_NAMES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(pc.bold('Discovering models...'));

  // Fetch all in parallel
  const results: Record<string, { models: string[]; source: string }> = {};
  await Promise.all(
    agents.map(async (agent) => {
      results[agent] = await fetchModels(agent);
    }),
  );

  for (const agent of agents) {
    displayAgent(agent, results[agent] ?? { models: [], source: 'none' });
  }

  console.log('');
}

// Only run when invoked directly (not when imported by hydra-models-select.mjs)
const __self = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const __argv1 = path.resolve(process.argv[1] === '' ? '' : process.argv[1]);
if (__argv1 === path.resolve(__self)) {
  main().catch((err: unknown) => {
    console.error(pc.red(`Error: ${(err as Error).message}`));
    process.exitCode = 1;
  });
}
