/**
 * Hydra Project Resolution
 *
 * Handles project detection, validation, and recent-project history.
 * Extracted from hydra-config.ts to keep config loading concerns separate
 * from project-path concerns.
 *
 * Intentionally has no import from hydra-config.ts to avoid circular deps.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Absolute path to the Hydra installation root (mirrors the constant in hydra-config.ts). */
const HYDRA_ROOT = path.resolve(__dirname, '..');

// `process.pkg` is injected by the `pkg` bundler for packaged executables.
const HYDRA_IS_PACKAGED = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);

function getPackagedRuntimeRoot(): string {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local'),
        'Hydra',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Hydra');
    default:
      return path.join(
        process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'),
        'Hydra',
      );
  }
}

const HYDRA_RUNTIME_ROOT = HYDRA_IS_PACKAGED ? getPackagedRuntimeRoot() : HYDRA_ROOT;

const EMBEDDED_RECENT_PROJECTS_PATH = path.join(HYDRA_ROOT, 'recent-projects.json');
const DEFAULT_RECENT_PROJECTS_PATH = path.join(HYDRA_RUNTIME_ROOT, 'recent-projects.json');
const MAX_RECENT = 10;

/** Test-only override for the recent-projects file path. */
let _testRecentProjectsPath: string | null = null;

function activeRecentProjectsPath(): string {
  return _testRecentProjectsPath ?? DEFAULT_RECENT_PROJECTS_PATH;
}

/**
 * Test-only: redirect recent-project reads/writes to a temp file path.
 * Pass null to restore the real path.
 */
export function _setTestRecentProjectsPath(p: string | null): void {
  _testRecentProjectsPath = p;
}

function ensureRuntimeRoot(): void {
  if (_testRecentProjectsPath !== null) return;
  if (!fs.existsSync(HYDRA_RUNTIME_ROOT)) {
    fs.mkdirSync(HYDRA_RUNTIME_ROOT, { recursive: true });
  }
}

function seedRuntimeFile(runtimePath: string, embeddedPath: string, fallback = ''): void {
  if (fs.existsSync(runtimePath)) return;
  ensureRuntimeRoot();
  try {
    if (fs.existsSync(embeddedPath)) {
      fs.copyFileSync(embeddedPath, runtimePath);
      return;
    }
  } catch {
    // Fall through to fallback content
  }
  fs.writeFileSync(runtimePath, fallback, 'utf8');
}

// ── Recent Projects ──────────────────────────────────────────────────────────

export function getRecentProjects(): string[] {
  const filePath = activeRecentProjectsPath();
  if (_testRecentProjectsPath === null) {
    ensureRuntimeRoot();
    if (HYDRA_IS_PACKAGED) {
      seedRuntimeFile(filePath, EMBEDDED_RECENT_PROJECTS_PATH, '[]\n');
    }
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function addRecentProject(projectPath: string): void {
  const filePath = activeRecentProjectsPath();
  if (_testRecentProjectsPath === null) {
    ensureRuntimeRoot();
  } else {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  const normalized = path.resolve(projectPath);
  const recent = getRecentProjects().filter((p) => path.resolve(p) !== normalized);
  recent.unshift(normalized);
  const trimmed = recent.slice(0, MAX_RECENT);
  fs.writeFileSync(filePath, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8');
}

// ── Project Detection ────────────────────────────────────────────────────────

export function detectProjectName(projectRoot: string): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    if (typeof pkg['name'] === 'string' && pkg['name'].length > 0) return pkg['name'];
  } catch {
    /* ignore */
  }
  return path.basename(projectRoot);
}

export function isValidProject(dir: string): boolean {
  const markers = [
    'package.json',
    '.git',
    'HYDRA.md',
    'CLAUDE.md',
    'Cargo.toml',
    'pyproject.toml',
    'go.mod',
  ];
  return markers.some((m) => fs.existsSync(path.join(dir, m)));
}

export interface ProjectConfig {
  projectRoot: string;
  projectName: string;
  coordDir: string;
  statePath: string;
  logPath: string;
  statusPath: string;
  eventsPath: string;
  archivePath: string;
  runsDir: string;
  hydraRoot: string;
}

export interface ResolveProjectOptions {
  project?: string;
  skipValidation?: boolean;
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
export function resolveProject(options: ResolveProjectOptions = {}): ProjectConfig {
  let projectRoot = options.project ?? '';

  if (projectRoot.length === 0) {
    for (const arg of process.argv.slice(2)) {
      const match = arg.match(/^(?:--)?project=(.+)$/);
      if (match !== null) {
        projectRoot = match[1]; // capture group (.+) is always defined when match succeeds
        break;
      }
    }
  }

  const hydraProject = process.env['HYDRA_PROJECT'];
  if (projectRoot.length === 0 && hydraProject !== undefined) {
    projectRoot = hydraProject;
  }

  if (projectRoot.length === 0) {
    projectRoot = process.cwd();
  }

  projectRoot = path.resolve(projectRoot);

  if (options.skipValidation !== true && !isValidProject(projectRoot)) {
    throw new Error(
      `Not a valid project directory: ${projectRoot}\n` +
        'Expected one of: package.json, .git, CLAUDE.md, Cargo.toml, pyproject.toml, go.mod',
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
export async function selectProjectInteractive(): Promise<ProjectConfig> {
  const cwd = process.cwd();
  const cwdValid = isValidProject(cwd);
  const recent = getRecentProjects().filter((p) => p !== cwd && fs.existsSync(p));

  if (cwdValid) {
    const name = detectProjectName(cwd);
    const answer = await askLine(`Detected project: ${name} (${cwd}). Work here? (Y/n/browse) `);
    const trimmed = answer.trim().toLowerCase();

    if (trimmed.length === 0 || trimmed === 'y' || trimmed === 'yes') {
      addRecentProject(cwd);
      return resolveProject({ project: cwd });
    }

    if (trimmed !== 'n' && trimmed !== 'no' && trimmed !== 'browse') {
      addRecentProject(trimmed);
      return resolveProject({ project: trimmed });
    }
  }

  if (recent.length > 0) {
    console.log('\nRecent projects:');
    for (const [i, p] of recent.entries()) {
      const name = detectProjectName(p);
      console.log(`  ${String(i + 1)}) ${name} (${p})`);
    }
    console.log(`  ${String(recent.length + 1)}) Enter a new path`);

    const choice = await askLine('Select project: ');
    const idx = Number.parseInt(choice, 10) - 1;

    if (idx >= 0 && idx < recent.length) {
      addRecentProject(recent[idx]);
      return resolveProject({ project: recent[idx] });
    }
  }

  const manualPath = await askLine('Enter project path: ');
  if (manualPath.trim().length === 0) {
    throw new Error('No project path provided.');
  }
  addRecentProject(manualPath.trim());
  return resolveProject({ project: manualPath.trim() });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
