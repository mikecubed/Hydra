#!/usr/bin/env node
/**
 * Hydra Configuration & Project Detection
 *
 * Central config module that replaces all hardcoded ROOT/COORD_DIR/project references.
 * Detects the target project from CLI args, env vars, or cwd.
 * Manages recent project history for quick switching.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the Hydra installation root (E:\Dev\Hydra) */
export const HYDRA_ROOT = path.resolve(__dirname, '..');

const RECENT_PROJECTS_PATH = path.join(HYDRA_ROOT, 'recent-projects.json');
const CONFIG_PATH = path.join(HYDRA_ROOT, 'hydra.config.json');
const MAX_RECENT = 10;

// ── Hydra Config (models, usage, stats) ─────────────────────────────────────

const DEFAULT_CONFIG = {
  version: 2,
  mode: 'performance',
  models: {
    gemini: { default: 'gemini-2.5-pro', fast: 'gemini-2.5-flash', cheap: 'gemini-2.5-flash', active: 'default' },
    codex:  { default: 'gpt-5.3', fast: 'o4-mini', cheap: 'o4-mini', active: 'default' },
    claude: { default: 'claude-opus-4-6', fast: 'claude-sonnet-4-5-20250929', cheap: 'claude-haiku-4-5-20251001', active: 'default' },
  },
  aliases: {
    gemini: { pro: 'gemini-2.5-pro', flash: 'gemini-2.5-flash' },
    codex:  { gpt5: 'gpt-5', 'gpt-5': 'gpt-5', 'gpt-5.3': 'gpt-5.3', 'o4-mini': 'o4-mini', o4mini: 'o4-mini' },
    claude: { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' },
  },
  modeTiers: {
    performance: { gemini: 'default', codex: 'default', claude: 'default' },
    balanced:    { gemini: 'default', codex: 'fast',    claude: 'default' },
    economy:     { gemini: 'fast',    codex: 'cheap',   claude: 'fast' },
  },
  usage: {
    warningThresholdPercent: 80,
    criticalThresholdPercent: 90,
    claudeStatsPath: 'auto',
    dailyTokenBudget: { 'claude-opus-4-6': 2_000_000, 'claude-sonnet-4-5-20250929': 5_000_000 },
    // Claude Max 20x: 5-hour sliding window, ~900K tokens/window for opus
    plan: 'max_20x',
    windowHours: 5,
    windowTokenBudget: { 'claude-opus-4-6': 900_000, 'claude-sonnet-4-5-20250929': 2_500_000 },
  },
  verification: {
    onTaskDone: true,
    command: 'auto',
    timeoutMs: 60_000,
  },
  stats: { retentionDays: 30 },
};

function deepMergeSection(def, user) {
  if (!user || typeof user !== 'object') {
    return { ...def };
  }
  const merged = { ...def };
  for (const [k, v] of Object.entries(user)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object') {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

function mergeWithDefaults(config) {
  const parsed = config && typeof config === 'object' ? config : {};
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    models: deepMergeSection(DEFAULT_CONFIG.models, parsed.models),
    aliases: deepMergeSection(DEFAULT_CONFIG.aliases, parsed.aliases),
    modeTiers: deepMergeSection(DEFAULT_CONFIG.modeTiers, parsed.modeTiers),
    usage: { ...DEFAULT_CONFIG.usage, ...parsed.usage },
    verification: { ...DEFAULT_CONFIG.verification, ...parsed.verification },
    stats: { ...DEFAULT_CONFIG.stats, ...parsed.stats },
  };
}

/**
 * Migrate v1 config to v2 schema. Backfills missing sections from defaults.
 */
function migrateConfig(parsed) {
  if (!parsed.mode) parsed.mode = DEFAULT_CONFIG.mode;
  if (!parsed.aliases) parsed.aliases = { ...DEFAULT_CONFIG.aliases };
  if (!parsed.modeTiers) parsed.modeTiers = { ...DEFAULT_CONFIG.modeTiers };
  if (!parsed.verification) parsed.verification = { ...DEFAULT_CONFIG.verification };
  // Backfill cheap tier for agents that didn't have it in v1
  for (const agent of ['gemini', 'codex']) {
    if (parsed.models?.[agent] && !parsed.models[agent].cheap) {
      parsed.models[agent].cheap = DEFAULT_CONFIG.models[agent].cheap;
    }
  }
  parsed.version = 2;
  return parsed;
}

let _configCache = null;

export function loadHydraConfig() {
  if (_configCache) return _configCache;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Migrate v1 → v2 if needed
    if (!parsed.version || parsed.version < 2) {
      migrateConfig(parsed);
    }
    _configCache = mergeWithDefaults(parsed);
    return _configCache;
  } catch {
    _configCache = mergeWithDefaults({});
    return _configCache;
  }
}

export function saveHydraConfig(config) {
  const merged = mergeWithDefaults(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  _configCache = merged;
  return merged;
}

export function invalidateConfigCache() {
  _configCache = null;
}

// ── Recent Projects ──────────────────────────────────────────────────────────

export function getRecentProjects() {
  try {
    const raw = fs.readFileSync(RECENT_PROJECTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function addRecentProject(projectPath) {
  const normalized = path.resolve(projectPath);
  const recent = getRecentProjects().filter((p) => path.resolve(p) !== normalized);
  recent.unshift(normalized);
  const trimmed = recent.slice(0, MAX_RECENT);
  fs.writeFileSync(RECENT_PROJECTS_PATH, JSON.stringify(trimmed, null, 2) + '\n', 'utf8');
}

// ── Project Detection ────────────────────────────────────────────────────────

function detectProjectName(projectRoot) {
  // Try package.json name first
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }

  // Fall back to directory name
  return path.basename(projectRoot);
}

function isValidProject(dir) {
  const markers = ['package.json', '.git', 'CLAUDE.md', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

/**
 * Resolve the target project.
 *
 * Priority:
 * 1. options.project (explicit path)
 * 2. --project=<path> CLI arg
 * 3. HYDRA_PROJECT env var
 * 4. process.cwd()
 *
 * @param {object} [options]
 * @param {string} [options.project] - Explicit project path
 * @param {boolean} [options.skipValidation] - Skip project marker check
 * @returns {object} Project config with all derived paths
 */
export function resolveProject(options = {}) {
  let projectRoot = options.project || '';

  // Check CLI args for --project=<path> or project=<path>
  if (!projectRoot) {
    for (const arg of process.argv.slice(2)) {
      const match = arg.match(/^(?:--)?project=(.+)$/);
      if (match) {
        projectRoot = match[1];
        break;
      }
    }
  }

  // Check env var
  if (!projectRoot && process.env.HYDRA_PROJECT) {
    projectRoot = process.env.HYDRA_PROJECT;
  }

  // Fall back to cwd
  if (!projectRoot) {
    projectRoot = process.cwd();
  }

  projectRoot = path.resolve(projectRoot);

  if (!options.skipValidation && !isValidProject(projectRoot)) {
    throw new Error(
      `Not a valid project directory: ${projectRoot}\n` +
      'Expected one of: package.json, .git, CLAUDE.md, Cargo.toml, pyproject.toml, go.mod'
    );
  }

  const projectName = detectProjectName(projectRoot);
  const coordDir = path.join(projectRoot, 'docs', 'coordination');

  return {
    projectRoot,
    projectName,
    coordDir,
    statePath: path.join(coordDir, 'AI_SYNC_STATE.json'),
    logPath: path.join(coordDir, 'AI_SYNC_LOG.md'),
    statusPath: path.join(coordDir, 'AI_ORCHESTRATOR_STATUS.json'),
    eventsPath: path.join(coordDir, 'AI_ORCHESTRATOR_EVENTS.ndjson'),
    archivePath: path.join(coordDir, 'AI_SYNC_ARCHIVE.json'),
    runsDir: path.join(coordDir, 'runs'),
    hydraRoot: HYDRA_ROOT,
  };
}

/**
 * Interactive project selection.
 * Prompts user to confirm cwd or pick from recent/enter a path.
 *
 * @returns {Promise<object>} Project config
 */
export async function selectProjectInteractive() {
  const cwd = process.cwd();
  const cwdValid = isValidProject(cwd);
  const recent = getRecentProjects().filter((p) => p !== cwd && fs.existsSync(p));

  if (cwdValid) {
    const name = detectProjectName(cwd);
    const answer = await askLine(`Detected project: ${name} (${cwd}). Work here? (Y/n/browse) `);
    const trimmed = answer.trim().toLowerCase();

    if (!trimmed || trimmed === 'y' || trimmed === 'yes') {
      addRecentProject(cwd);
      return resolveProject({ project: cwd });
    }

    if (trimmed !== 'n' && trimmed !== 'no' && trimmed !== 'browse') {
      // Treat as path
      addRecentProject(trimmed);
      return resolveProject({ project: trimmed });
    }
  }

  // Show recent projects
  if (recent.length > 0) {
    console.log('\nRecent projects:');
    recent.forEach((p, i) => {
      const name = detectProjectName(p);
      console.log(`  ${i + 1}) ${name} (${p})`);
    });
    console.log(`  ${recent.length + 1}) Enter a new path`);

    const choice = await askLine('Select project: ');
    const idx = parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < recent.length) {
      addRecentProject(recent[idx]);
      return resolveProject({ project: recent[idx] });
    }
  }

  // Manual path entry
  const manualPath = await askLine('Enter project path: ');
  if (!manualPath.trim()) {
    throw new Error('No project path provided.');
  }
  addRecentProject(manualPath.trim());
  return resolveProject({ project: manualPath.trim() });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function askLine(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
