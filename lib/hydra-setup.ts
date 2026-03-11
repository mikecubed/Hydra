/**
 * Hydra Setup — CLI detection, MCP registration, and project initialization.
 *
 * Detects installed AI CLIs (claude, gemini, codex), registers Hydra's MCP
 * server with each, and provides a project init workflow for HYDRA.md.
 *
 * Usage:
 *   node lib/hydra-setup.ts setup [--force] [--uninstall]
 *   node lib/hydra-setup.ts init [--project-name=MyProject]
 *   node lib/hydra-setup.ts --help
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore — cross-spawn has no bundled types; pre-existing across codebase
import crossSpawn from 'cross-spawn';
import { fileURLToPath } from 'node:url';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RegisterMcpOptions {
  configPath?: string | null;
  format?: string;
  force?: boolean;
}

interface MergeConfigOptions {
  configPath?: string;
  force?: boolean;
}

interface SetupFlags {
  uninstall?: boolean;
  force?: boolean;
  help?: boolean;
  'project-name'?: string;
  [key: string]: boolean | string | undefined;
}

/** Cross-platform spawnSync — uses cross-spawn on Windows for .cmd/.bat shim support. */
const spawnSync = (cmd: string, args: string[], opts: Record<string, unknown>) =>
  crossSpawn.sync(cmd, args, opts as Parameters<typeof crossSpawn.sync>[2]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Path Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve the Hydra installation root (one level above lib/).
 * @returns {string}
 */
export function resolveHydraRoot() {
  return path.resolve(__dirname, '..');
}

/**
 * Resolve the absolute path to hydra-mcp-server.ts with forward slashes.
 * Node >=22.18 runs .ts files directly; no .mjs build artifact is needed.
 * Forward slashes ensure cross-platform MCP config compatibility.
 * @returns {string}
 */
export function resolveMcpServerPath() {
  return path.join(resolveHydraRoot(), 'lib', 'hydra-mcp-server.ts').replace(/\\/g, '/');
}

/**
 * Resolve the path to the node binary.
 * @returns {string}
 */
export function resolveNodePath() {
  return process.execPath;
}

// ── CLI Detection ───────────────────────────────────────────────────────────
// Implementations live in hydra-cli-detect.ts; re-exported here for backward compatibility.
export { commandExists, detectInstalledCLIs } from './hydra-cli-detect.ts';
import { detectInstalledCLIs } from './hydra-cli-detect.ts';

// ── MCP Server Entry Builders ───────────────────────────────────────────────

/**
 * Build the MCP server entry object for a given agent's config format.
 *
 * @param {'claude'|'gemini'|'codex'} agent
 * @returns {object|string[]} Entry object for claude/gemini, or args array for codex
 */
export function buildMcpServerEntry(agent: string): Record<string, unknown> | string[] {
  const mcpPath = resolveMcpServerPath();

  switch (agent) {
    case 'claude':
      return {
        type: 'stdio',
        command: resolveNodePath(),
        args: [mcpPath],
        env: {},
      };

    case 'gemini':
      return {
        command: resolveNodePath(),
        args: [mcpPath],
        timeout: 600000,
        description: 'Hydra multi-agent orchestration',
      };

    case 'codex':
      // Codex uses `codex mcp add hydra -- node /path/to/mcp-server.mjs`
      // Return the args portion after `--`
      return [resolveNodePath(), mcpPath];

    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}

// ── JSON File Helpers ───────────────────────────────────────────────────────

/**
 * Read a JSON file, returning {} on any error (missing, invalid, empty).
 * @param {string} filePath
 * @returns {object}
 */
export function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Write a JSON object to a file with 2-space indentation.
 * Creates parent directories if needed.
 * @param {string} filePath
 * @param {object} data
 */
function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// ── Claude Code Config ──────────────────────────────────────────────────────

/**
 * Default path to Claude Code's config file.
 * @returns {string}
 */
function defaultClaudeConfigPath() {
  return path.join(os.homedir(), '.claude.json');
}

/**
 * Merge Hydra MCP entry into Claude Code's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @param {boolean} [opts.force] Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated' }}
 */
export function mergeClaudeConfig(opts: MergeConfigOptions = {}) {
  const configPath = opts.configPath ?? defaultClaudeConfigPath();
  const force = Boolean(opts.force);

  const config = readJsonFile(configPath);
  if (!config['mcpServers']) {
    config['mcpServers'] = {};
  }
  const mcpServers = config['mcpServers'] as Record<string, unknown>;

  if (mcpServers['hydra'] && !force) {
    return { status: 'exists' as const };
  }

  const status = mcpServers['hydra'] ? ('updated' as const) : ('added' as const);
  mcpServers['hydra'] = buildMcpServerEntry('claude');
  writeJsonFile(configPath, config);

  return { status };
}

/**
 * Remove Hydra MCP entry from Claude Code's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @returns {{ status: 'removed'|'not_found' }}
 */
export function unmergeClaudeConfig(opts: MergeConfigOptions = {}) {
  const configPath = opts.configPath ?? defaultClaudeConfigPath();

  if (!fs.existsSync(configPath)) {
    return { status: 'not_found' as const };
  }

  const config = readJsonFile(configPath);
  const mcpServers = config['mcpServers'] as Record<string, unknown> | undefined;
  if (!mcpServers?.['hydra']) {
    return { status: 'not_found' as const };
  }

  delete mcpServers['hydra'];
  writeJsonFile(configPath, config);

  return { status: 'removed' as const };
}

// ── Gemini CLI Config ───────────────────────────────────────────────────────

/**
 * Default path to Gemini CLI's settings file.
 * @returns {string}
 */
function defaultGeminiConfigPath() {
  return path.join(os.homedir(), '.gemini', 'settings.json');
}

/**
 * Merge Hydra MCP entry into Gemini CLI's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @param {boolean} [opts.force] Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated' }}
 */
export function mergeGeminiConfig(opts: MergeConfigOptions = {}) {
  const configPath = opts.configPath ?? defaultGeminiConfigPath();
  const force = Boolean(opts.force);

  const config = readJsonFile(configPath);
  if (!config['mcpServers']) {
    config['mcpServers'] = {};
  }
  const mcpServers = config['mcpServers'] as Record<string, unknown>;

  if (mcpServers['hydra'] && !force) {
    return { status: 'exists' as const };
  }

  const status = mcpServers['hydra'] ? ('updated' as const) : ('added' as const);
  mcpServers['hydra'] = buildMcpServerEntry('gemini');
  writeJsonFile(configPath, config);

  return { status };
}

/**
 * Remove Hydra MCP entry from Gemini CLI's config.
 *
 * @param {object} [opts]
 * @param {string} [opts.configPath] Override config path (for testing)
 * @returns {{ status: 'removed'|'not_found' }}
 */
export function unmergeGeminiConfig(opts: MergeConfigOptions = {}) {
  const configPath = opts.configPath ?? defaultGeminiConfigPath();

  if (!fs.existsSync(configPath)) {
    return { status: 'not_found' as const };
  }

  const config = readJsonFile(configPath);
  const mcpServers = config['mcpServers'] as Record<string, unknown> | undefined;
  if (!mcpServers?.['hydra']) {
    return { status: 'not_found' as const };
  }

  delete mcpServers['hydra'];
  writeJsonFile(configPath, config);

  return { status: 'removed' as const };
}

// ── Codex CLI Config ────────────────────────────────────────────────────────

/**
 * Register Hydra MCP server with Codex CLI via `codex mcp add`.
 *
 * @returns {{ status: 'added'|'error', error?: string }}
 */
export function registerCodexMcp() {
  const codexEntry = buildMcpServerEntry('codex') as string[];
  const [nodePath, mcpPath] = codexEntry;
  try {
    const result = spawnSync('codex', ['mcp', 'add', 'hydra', '--', nodePath, mcpPath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return { status: 'added' as const };
    }
    return {
      status: 'error' as const,
      error: String(result.stderr ?? '').trim() || `exit code ${String(result.status)}`,
    };
  } catch (err: unknown) {
    return { status: 'error' as const, error: (err as Error).message };
  }
}

/**
 * Unregister Hydra MCP server from Codex CLI via `codex mcp remove`.
 *
 * @returns {{ status: 'removed'|'not_found'|'error', error?: string }}
 */
export function unregisterCodexMcp() {
  try {
    const result = spawnSync('codex', ['mcp', 'remove', 'hydra'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      return { status: 'removed' as const };
    }
    const stderr = String(result.stderr ?? '').trim();
    if (stderr.includes('not found') || stderr.includes('does not exist')) {
      return { status: 'not_found' as const };
    }
    return { status: 'error' as const, error: stderr || `exit code ${String(result.status)}` };
  } catch (err: unknown) {
    return { status: 'error' as const, error: (err as Error).message };
  }
}

// ── HYDRA.md Template ───────────────────────────────────────────────────────

/**
 * Generate a starter HYDRA.md template for project initialization.
 *
 * @param {object} [opts]
 * @param {string} [opts.projectName] Project name for the header
 * @returns {string}
 */
export function generateHydraMdTemplate(opts: { projectName?: string } = {}) {
  const name = opts.projectName || 'My Project';

  return `# HYDRA.md

> Multi-agent instructions for **${name}**. This file is parsed by \`hydra-sync-md\`
> to generate per-agent instruction files (CLAUDE.md, GEMINI.md, AGENTS.md).

## Project Overview

${name} — describe your project here.

## Code Conventions

- Add shared conventions that all agents should follow.

## @claude

Claude-specific instructions go here.
- Claude is the architect role — best for design, planning, and code review.

## @gemini

Gemini-specific instructions go here.
- Gemini is the analyst role — best for research, critique, and analysis.

## @codex

Codex-specific instructions go here.
- Codex is the implementer role — best for code generation and refactoring.

## Testing

Shared testing instructions for all agents.
`;
}

// ── Main CLI Entry ──────────────────────────────────────────────────────────

const HELP_TEXT = `
hydra-setup — Register Hydra MCP server with AI CLIs and initialize projects.

Usage:
  node lib/hydra-setup.ts setup [--force] [--uninstall]
  node lib/hydra-setup.ts init  [path] [--project-name=Name] [--force]
  node lib/hydra-setup.ts --help

Commands:
  setup       Register (or unregister) Hydra's MCP server with installed CLIs
  init        Generate HYDRA.md template and sync per-agent instruction files

Options:
  --force       Overwrite existing MCP registrations or HYDRA.md template
  --uninstall   Remove Hydra MCP registrations from all CLIs
  --project-name=Name   Project name for HYDRA.md template (init only)
  --help        Show this help message
`.trim();

/**
 * Parse CLI arguments into a simple object.
 * @param {string[]} argv
 * @returns {{ subcommand: string, flags: object }}
 */
function parseSetupArgs(argv: string[]): {
  subcommand: string;
  flags: SetupFlags;
  positionals: string[];
} {
  const args = argv.slice(2);
  const flags: SetupFlags = {};
  const positionals: string[] = [];
  let subcommand = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        if (key === 'project-name' && i + 1 < args.length && !args[i + 1].startsWith('--')) {
          flags[key] = args[i + 1];
          i += 1;
          continue;
        }
        flags[arg.slice(2)] = true;
      }
    } else if (subcommand) {
      positionals.push(arg);
    } else {
      subcommand = arg;
    }
  }

  return { subcommand, flags, positionals };
}

// ── Custom Agent MCP Registration ────────────────────────────────────────────

/**
 * Known config paths for popular AI CLIs (relative to os.homedir(), or null if unsupported).
 */
export const KNOWN_CLI_MCP_PATHS = {
  // GitHub Copilot — config location varies by version; manual preferred
  gh: null,
  // Aider — YAML config, not JSON; manual preferred
  aider: null,
  // Continue — JSON config
  continue: path.join('.continue', 'config.json'),
  // GitHub Copilot CLI — user-level MCP config
  copilot: path.join('.copilot', 'mcp-config.json'),
};

/**
 * Register the Hydra MCP server with a custom agent's config file.
 *
 * @param {object} opts
 * @param {string|null} opts.configPath - Absolute path to the agent's config file
 * @param {'json'|string} [opts.format] - Config format ('json' is the only auto-handled format)
 * @param {boolean} [opts.force] - Overwrite existing entry
 * @returns {{ status: 'added'|'exists'|'updated'|'manual'|'error', instructions?: string }}
 */
export function registerCustomAgentMcp(opts: RegisterMcpOptions = {}) {
  const { configPath, format, force = false } = opts;
  const mcpPath = resolveMcpServerPath();
  const nodePath = resolveNodePath();

  const manualInstructions = `Add this to your agent's MCP configuration:\n\n  Name: hydra\n  Command: ${nodePath}\n  Args: ${mcpPath}\n\nOr if your agent uses a JSON config with an "mcpServers" field:\n  {\n    "mcpServers": {\n      "hydra": {\n        "type": "stdio",\n        "command": "${nodePath}",\n        "args": ["${mcpPath}"]\n      }\n    }\n  }`;

  if (!configPath || format !== 'json') {
    return { status: 'manual' as const, instructions: manualInstructions };
  }

  try {
    const config = readJsonFile(configPath);
    if (!config['mcpServers']) config['mcpServers'] = {};
    const mcpServers = config['mcpServers'] as Record<string, unknown>;

    if (mcpServers['hydra'] && !force) {
      return { status: 'exists' as const };
    }

    const status = mcpServers['hydra'] ? ('updated' as const) : ('added' as const);
    mcpServers['hydra'] = {
      type: 'stdio',
      command: nodePath,
      args: [mcpPath],
    };

    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

    return { status };
  } catch {
    return { status: 'manual' as const, instructions: manualInstructions };
  }
}

/**
 * Register the Hydra MCP server with GitHub Copilot CLI.
 * Config file: ~/.copilot/mcp-config.json
 * Copilot's MCP format uses a `description` field that registerCustomAgentMcp() doesn't handle.
 */
export function mergeCopilotConfig(opts: { force?: boolean } = {}): {
  status: 'registered' | 'already_registered';
  path: string;
} {
  const configPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
  let config: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt config or non-JSON content — start fresh with empty object
    }
  }

  config['mcpServers'] ??= {};
  const mcpServers = config['mcpServers'] as Record<string, unknown>;

  if (!opts.force && mcpServers['hydra']) {
    return { status: 'already_registered', path: configPath };
  }

  mcpServers['hydra'] = {
    command: resolveNodePath(),
    args: [resolveMcpServerPath()],
    description: 'Hydra multi-agent orchestration',
  };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { status: 'registered', path: configPath };
}

/**
 * Remove the Hydra MCP server entry from GitHub Copilot CLI config.
 */
export function unmergeCopilotConfig(): { status: 'unregistered' | 'not_found'; path: string } {
  const configPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');

  if (!fs.existsSync(configPath)) {
    return { status: 'not_found', path: configPath };
  }

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return { status: 'not_found', path: configPath };
  }

  const mcpServers = config['mcpServers'] as Record<string, unknown> | undefined;
  if (!mcpServers?.['hydra']) {
    return { status: 'not_found', path: configPath };
  }

  delete mcpServers['hydra'];
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return { status: 'unregistered', path: configPath };
}

/**
 * Main CLI entry point.
 * @returns {{ ok: boolean, message: string }}
 */
export async function main(argv?: string[]): Promise<{ ok: boolean; message: string }> {
  const effectiveArgv = argv ?? process.argv;
  const { subcommand, flags, positionals } = parseSetupArgs(effectiveArgv);

  // --help
  if (flags.help || subcommand === 'help') {
    console.log(HELP_TEXT);
    return { ok: true, message: 'help' };
  }

  // setup
  if (subcommand === 'setup') {
    return runSetup(flags);
  }

  // init
  if (subcommand === 'init') {
    return runInit(flags, positionals);
  }

  // No subcommand or unknown
  console.log(HELP_TEXT);
  return {
    ok: false,
    message: subcommand ? `Unknown command: ${subcommand}` : 'No command specified',
  };
}

/**
 * Run the setup flow: detect CLIs, register/unregister MCP.
 * @param {object} flags
 * @returns {{ ok: boolean, message: string }}
 */
function runSetup(flags: SetupFlags): { ok: boolean; message: string } {
  const uninstall = Boolean(flags.uninstall);
  const force = Boolean(flags.force);

  const clis = detectInstalledCLIs();
  const results: string[] = [];

  if (uninstall) {
    // Unregister from all
    if (clis['claude']) {
      const r = unmergeClaudeConfig();
      results.push(`Claude: ${r.status}`);
    } else {
      results.push('Claude: not installed');
    }

    if (clis['gemini']) {
      const r = unmergeGeminiConfig();
      results.push(`Gemini: ${r.status}`);
    } else {
      results.push('Gemini: not installed');
    }

    if (clis['codex']) {
      const r = unregisterCodexMcp();
      results.push(`Codex: ${r.status}`);
    } else {
      results.push('Codex: not installed');
    }

    if (clis['copilot']) {
      const r = unmergeCopilotConfig();
      results.push(`Copilot: ${r.status}`);
    } else {
      results.push('Copilot: not installed');
    }

    const msg = `Unregistered Hydra MCP:\n  ${results.join('\n  ')}`;
    console.log(msg);
    return { ok: true, message: msg };
  }

  // Register with all installed CLIs
  if (clis['claude']) {
    const r = mergeClaudeConfig({ force });
    results.push(`Claude: ${r.status}`);
  } else {
    results.push('Claude: not installed');
  }

  if (clis['gemini']) {
    const r = mergeGeminiConfig({ force });
    results.push(`Gemini: ${r.status}`);
  } else {
    results.push('Gemini: not installed');
  }

  if (clis['codex']) {
    const r = registerCodexMcp();
    results.push(`Codex: ${r.status}`);
  } else {
    results.push('Codex: not installed');
  }

  if (clis['copilot']) {
    const r = mergeCopilotConfig({ force });
    results.push(`Copilot: ${r.status}`);
  } else {
    results.push('Copilot: not installed');
  }

  const msg = `Registered Hydra MCP:\n  ${results.join('\n  ')}`;
  console.log(msg);
  return { ok: true, message: msg };
}

/**
 * Run the init flow: generate HYDRA.md and sync per-agent files.
 * @param {object} flags
 * @returns {{ ok: boolean, message: string }}
 */
async function runInit(
  flags: SetupFlags,
  positionals: string[] = [],
): Promise<{ ok: boolean; message: string }> {
  if (positionals.length > 1) {
    const message = `Expected at most one target path for init, received ${positionals.length}.`;
    console.error(message);
    return { ok: false, message };
  }

  const projectRoot = path.resolve(positionals[0] || process.cwd());
  const hydraMdPath = path.join(projectRoot, 'HYDRA.md');
  const projectName = flags['project-name'] || path.basename(projectRoot);
  const force = Boolean(flags.force);

  if (fs.existsSync(projectRoot)) {
    const stats = fs.statSync(projectRoot);
    if (!stats.isDirectory()) {
      const message = `Target path is not a directory: ${projectRoot}`;
      console.error(message);
      return { ok: false, message };
    }
  } else {
    fs.mkdirSync(projectRoot, { recursive: true });
  }

  if (fs.existsSync(hydraMdPath) && fs.statSync(hydraMdPath).isDirectory()) {
    const message = `Target HYDRA.md path is a directory: ${hydraMdPath}`;
    console.error(message);
    return { ok: false, message };
  }

  const hadHydraMd = fs.existsSync(hydraMdPath);

  // Generate HYDRA.md if it doesn't exist
  if (hadHydraMd && !force) {
    console.log('HYDRA.md already exists — skipping template generation.');
  } else {
    const template = generateHydraMdTemplate({ projectName });
    fs.writeFileSync(hydraMdPath, template, 'utf8');
    console.log(`${hadHydraMd ? 'Updated' : 'Created'} HYDRA.md for "${projectName}".`);
  }

  // Sync per-agent files
  try {
    const { syncHydraMd } = await import('./hydra-sync-md.ts');
    const result = syncHydraMd(projectRoot);
    if (result.synced.length > 0) {
      console.log(`Synced: ${result.synced.join(', ')}`);
    } else if (result.skipped) {
      console.log('Sync skipped (no HYDRA.md found).');
    } else {
      console.log('All agent files are up to date.');
    }
  } catch (err: unknown) {
    const errMsg = (err as Error).message;
    console.error(`Failed to sync agent files: ${errMsg}`);
    return { ok: false, message: `Init completed but sync failed: ${errMsg}` };
  }

  return { ok: true, message: `Initialized HYDRA.md in ${projectRoot}` };
}

// ── Direct CLI entry ────────────────────────────────────────────────────────

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('hydra-setup.ts');

if (isDirectRun) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
