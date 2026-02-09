#!/usr/bin/env node
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

import https from 'https';
import path from 'path';
import { spawnSync } from 'child_process';
import { loadHydraConfig } from './hydra-config.mjs';
import { getActiveModel, AGENT_NAMES, AGENTS } from './hydra-agents.mjs';
import pc from 'picocolors';

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers, timeout: 10_000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad JSON from API`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Strategy 1: REST API with env key ───────────────────────────────────────

async function apiClaude() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const data = await httpGet('https://api.anthropic.com/v1/models?limit=100', {
    'x-api-key': key, 'anthropic-version': '2023-06-01',
  });
  return (data.data || []).map((m) => m.id).sort();
}

async function apiCodex() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const data = await httpGet('https://api.openai.com/v1/models', {
    'Authorization': `Bearer ${key}`,
  });
  return (data.data || []).map((m) => m.id).sort();
}

async function apiGemini() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;
  const data = await httpGet(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`
  );
  return (data.models || []).map((m) => m.name.replace('models/', '')).sort();
}

// ── Strategy 2: Ask the CLI (cheap model, tiny prompt) ──────────────────────

const CLAUDE_PROMPT = 'List every Claude model ID currently available via the Anthropic API. Output ONLY the model IDs, one per line. No markdown, no commentary, no explanation.';
const GEMINI_PROMPT = 'List every Gemini model ID currently available. Output ONLY the model IDs, one per line. No markdown, no commentary, no explanation.';

function cliClaude() {
  // On Windows, shell: true mangles multi-word -p args. Pipe via stdin instead.
  const r = spawnSync('claude', [
    '-p', '--model', 'haiku', '--output-format', 'text',
  ], { input: CLAUDE_PROMPT, encoding: 'utf8', timeout: 30_000, shell: process.platform === 'win32', windowsHide: true });
  if (r.status !== 0 && !r.stdout) return null;
  return parseModelLines(r.stdout);
}

function cliGemini() {
  // On Windows, shell:true mangles multi-word -p args. Bypass the .cmd shim
  // by resolving the npm global entry point and calling node directly.
  if (process.platform === 'win32') {
    const npmPrefix = spawnSync('npm', ['prefix', '-g'], {
      encoding: 'utf8', timeout: 5_000, shell: true, windowsHide: true,
    }).stdout?.trim();
    if (!npmPrefix) return null;
    const entry = path.join(npmPrefix, 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');
    const r = spawnSync('node', [
      entry, '-p', GEMINI_PROMPT, '-o', 'text', '-m', 'gemini-2.5-flash',
    ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    if (r.status !== 0 && !r.stdout) return null;
    return parseModelLines(r.stdout);
  }
  // Unix: shell splitting isn't an issue
  const r = spawnSync('gemini', [
    '-p', GEMINI_PROMPT, '-o', 'text', '-m', 'gemini-2.5-flash',
  ], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.status !== 0 && !r.stdout) return null;
  return parseModelLines(r.stdout);
}

function cliCodex() {
  // Codex exec is too slow/expensive for a model listing — skip CLI strategy.
  // Falls back to API (OPENAI_API_KEY) or config-only display.
  return null;
}

/** Parse one-per-line model IDs from noisy CLI output. */
function parseModelLines(raw) {
  if (!raw) return null;
  const ids = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'))
    .filter((l) => !l.startsWith('Loaded') && !l.startsWith('Hook'))
    .filter((l) => !l.includes(' '))  // model IDs shouldn't have spaces
    .filter((l) => /^[a-z0-9]/.test(l));  // starts with lowercase/digit
  return ids.length > 0 ? ids.sort() : null;
}

// ── Orchestrate per agent ───────────────────────────────────────────────────

const STRATEGIES = {
  claude: { api: apiClaude, cli: cliClaude },
  codex:  { api: apiCodex,  cli: cliCodex },
  gemini: { api: apiGemini, cli: cliGemini },
};

async function fetchModels(agentName) {
  const strat = STRATEGIES[agentName];
  if (!strat) return { models: [], source: 'none' };

  // 1. Try API
  try {
    const models = await strat.api();
    if (models && models.length > 0) return { models, source: 'api' };
  } catch { /* fall through */ }

  // 2. Try CLI
  try {
    const models = strat.cli();
    if (models && models.length > 0) return { models, source: 'cli' };
  } catch { /* fall through */ }

  // 3. Config-only fallback
  return { models: [], source: 'config-only' };
}

// ── Display ─────────────────────────────────────────────────────────────────

function displayAgent(agentName, fetchResult) {
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agentName] || {};
  const aliases = cfg.aliases?.[agentName] || {};
  const activeModel = getActiveModel(agentName);
  const agentInfo = AGENTS[agentName];
  const mode = cfg.mode || 'performance';
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName] || 'default';

  console.log('');
  console.log(pc.bold(pc.cyan(`═══ ${agentInfo?.label || agentName} ═══`)));

  // Active model
  console.log(`  Active:  ${pc.green(activeModel || 'unknown')} ${pc.dim(`(mode: ${mode} → ${tierPreset})`)}`);

  // Presets
  const presetKeys = ['default', 'fast', 'cheap'];
  console.log(pc.bold('  Presets:'));
  for (const key of presetKeys) {
    if (agentModels[key]) {
      const marker = agentModels[key] === activeModel ? pc.green(' ◀') : '';
      console.log(`    ${pc.dim(key.padEnd(8))} ${agentModels[key]}${marker}`);
    }
  }

  // Aliases
  if (Object.keys(aliases).length > 0) {
    console.log(pc.bold('  Aliases:'));
    for (const [alias, modelId] of Object.entries(aliases)) {
      console.log(`    ${pc.dim(alias.padEnd(12))} → ${modelId}`);
    }
  }

  // Discovered models
  const { models, source } = fetchResult;
  const sourceLabel = source === 'api' ? 'REST API' : source === 'cli' ? 'CLI query' : 'config only';

  if (models.length === 0) {
    console.log(pc.bold(`  Available Models ${pc.dim(`(${sourceLabel})`)}:`));
    console.log(pc.yellow('    Set API key in env for full list, or use CLI aliases above'));
    console.log(pc.dim(`    Claude: ANTHROPIC_API_KEY  |  Codex: OPENAI_API_KEY  |  Gemini: GEMINI_API_KEY`));
    return;
  }

  // Build known-set for highlighting
  const knownIds = new Set();
  for (const key of presetKeys) {
    if (agentModels[key]) knownIds.add(agentModels[key]);
  }
  for (const modelId of Object.values(aliases)) knownIds.add(modelId);

  console.log(pc.bold(`  Available Models (${models.length}) ${pc.dim(`[${sourceLabel}]`)}:`));
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv[2]?.toLowerCase();

  const agents = arg && AGENT_NAMES.includes(arg)
    ? [arg]
    : AGENT_NAMES;

  if (arg && !AGENT_NAMES.includes(arg)) {
    console.error(pc.red(`Unknown agent: ${arg}`));
    console.error(`Available: ${AGENT_NAMES.join(', ')}`);
    process.exit(1);
  }

  console.log(pc.bold('Discovering models...'));

  // Fetch all in parallel
  const results = {};
  await Promise.all(agents.map(async (agent) => {
    results[agent] = await fetchModels(agent);
  }));

  for (const agent of agents) {
    displayAgent(agent, results[agent]);
  }

  console.log('');
}

main().catch((err) => {
  console.error(pc.red(`Error: ${err.message}`));
  process.exit(1);
});
