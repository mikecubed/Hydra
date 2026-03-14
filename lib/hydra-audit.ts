/**
 * hydra-audit.mjs - Fan-out codebase audit across agents, assemble a punch list.
 *
 * Analysis only: no file edits, no branches, no commits.
 */

import { execFileSync } from 'node:child_process';
// @ts-expect-error -- cross-spawn has no bundled type declarations
import _spawn from 'cross-spawn';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { loadHydraConfig } from './hydra-config.ts';
import { getAgent } from './hydra-agents.ts';
import { expandInvokeArgs } from './hydra-shared/agent-executor.ts';
import type { AgentDef, HeadlessOpts } from './types.ts';
import { exit } from './hydra-process.ts';

const spawn = _spawn as (cmd: string, args: string[], opts?: SpawnOptions) => ChildProcess;

// -- Security ----------------------------------------------------------------

/**
 * Validate a command name before passing to spawn() as defence-in-depth.
 * Rejects shell metacharacters and path traversal. spawn() uses shell:false,
 * but we still guard against arbitrary executable injection from user config.
 */
function assertSafeSpawnCmd(cmd: string, context: string): void {
  if (/[;&|`$<>()\n\r\0]/.test(cmd)) {
    throw new Error(`${context}: cmd contains unsafe characters and cannot be spawned.`);
  }
  if (cmd.includes('..')) {
    throw new Error(`${context}: cmd contains path traversal (..) and cannot be spawned.`);
  }
}

// -- Local types -------------------------------------------------------------

interface FileEntry {
  path: string;
  size: number;
  ext: string;
  priority?: string;
  score?: number;
}

interface Finding {
  file: string;
  line: number | null;
  severity: string;
  category: string;
  title: string;
  detail: string;
  effort: string;
  _score?: number;
}

type ScoredFinding = Finding & { _score: number };

interface AgentResponse {
  agent: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  elapsedSec: string;
}

interface ManifestStats {
  candidates: number;
  selected: number;
  changed: number;
  recent: number;
}

interface PrioritySets {
  changed: Set<string>;
  recent: Set<string>;
}

interface ReportMeta {
  runId: string;
  projectName: string;
  categories: string[];
  agents: string[];
  elapsedSec: string;
  manifestStats: ManifestStats;
}

interface AuditCategoryDef {
  agent: string;
  label: string;
  prompt: string;
}

interface AgentCommandResult {
  cmd: string;
  args: string[];
}

// -- Args and config ---------------------------------------------------------

const rawArgv = process.argv.slice(2);
const args = Object.fromEntries(
  rawArgv
    .filter((a) => a.includes('='))
    .map((a) => {
      const [k, ...v] = a.split('=');
      return [k.trim().toLowerCase(), v.join('=').trim()];
    }),
);
const flags = new Set(
  rawArgv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').toLowerCase()),
);

const cfg = loadHydraConfig();
const auditCfg: Record<string, unknown> =
  cfg.audit != null && typeof cfg.audit === 'object' ? (cfg.audit as Record<string, unknown>) : {};

const ALL_CATEGORIES = [
  'dead-code',
  'inconsistencies',
  'architecture',
  'security',
  'tests',
  'types',
];
const DEFAULT_CATEGORIES =
  Array.isArray(auditCfg['categories']) && (auditCfg['categories'] as unknown[]).length > 0
    ? (auditCfg['categories'] as string[])
    : ALL_CATEGORIES;

const PROJECT = resolve(args['project'] ?? process.cwd());
const CATEGORIES = parseCsv(args['categories'] ?? DEFAULT_CATEGORIES.join(','));
const AGENTS = parseCsv(args['agents'] ?? 'gemini,claude,codex');
const MAX_FILES = parsePositiveInt(args['max-files'], auditCfg['maxFiles'], 200);
const TIMEOUT_MS = parsePositiveInt(args['timeout'], auditCfg['timeout'], 300_000);
const reportDirCfg = auditCfg['reportDir'];
const REPORT_DIR =
  typeof reportDirCfg === 'string' && reportDirCfg.trim().length > 0 ? reportDirCfg : 'docs/audit';
const reportArg = args['report'];
const REPORT_PATH =
  typeof reportArg === 'string' && reportArg !== ''
    ? resolveReportPath(PROJECT, reportArg)
    : join(PROJECT, REPORT_DIR, `${dateStr()}.md`);
const ECONOMY = flags.has('economy') || auditCfg['economy'] === true;
const VERBOSE = flags.has('verbose');
const RUN_ID = `${dateStr()}-${timeStr()}-${Math.random().toString(36).slice(2, 8)}`;

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function parsePositiveInt(...values: unknown[]): number {
  for (const value of values) {
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1;
}

function resolveReportPath(projectPath: string, reportPath: string): string {
  if (isAbsolute(reportPath)) {
    return reportPath;
  }
  return resolve(projectPath, reportPath);
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

function timeStr() {
  return new Date().toISOString().slice(11, 19).replace(/:/g, '-');
}

// -- Category definitions ----------------------------------------------------

const AUDIT_CATEGORIES: Record<string, AuditCategoryDef> = {
  'dead-code': {
    agent: 'gemini',
    label: 'Dead Code and Unused Exports',
    prompt: `Analyze this codebase for dead code and unused exports.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Exported functions/components/types that are never imported elsewhere
- Files that are never imported by any other file
- Unreachable code paths (after returns, impossible conditions)
- Commented-out code blocks that should be removed
- Unused dependencies in package.json

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": 42,
  "severity": "critical" | "major" | "minor",
  "category": "dead-code",
  "title": "Short description",
  "detail": "Why this matters and what to do",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  inconsistencies: {
    agent: 'gemini',
    label: 'Inconsistencies and Duplication',
    prompt: `Analyze this codebase for inconsistencies and duplication.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Naming convention inconsistencies (mixed camelCase/snake_case, inconsistent file naming)
- Duplicate logic that should be extracted into shared utilities
- Inconsistent patterns (e.g., some files use one approach, others use another for the same thing)
- Inconsistent error handling patterns
- Mixed import styles (default vs named, relative vs alias)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "inconsistencies",
  "title": "Short description",
  "detail": "What's inconsistent and the recommended pattern to standardize on",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  architecture: {
    agent: 'claude',
    label: 'Architecture and Design',
    prompt: `Review this codebase architecture for design issues and improvement opportunities.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Circular dependencies or tangled module boundaries
- Components/modules doing too much (violation of single responsibility)
- Missing abstraction layers (e.g., direct DB calls from UI components)
- Poor separation of concerns
- State management issues (prop drilling, global state misuse)
- Missing or misplaced business logic
- API design issues (inconsistent endpoints, missing validation)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "architecture",
  "title": "Short description",
  "detail": "What's wrong and a concrete suggestion for improvement",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  security: {
    agent: 'claude',
    label: 'Security Issues',
    prompt: `Perform a security review of this codebase.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Hardcoded secrets, API keys, or credentials
- SQL injection or NoSQL injection vectors
- XSS vulnerabilities (unsanitized user input in rendered output)
- Missing authentication/authorization checks on endpoints
- Insecure direct object references
- Missing rate limiting on sensitive endpoints
- Overly permissive CORS or RLS policies
- Sensitive data in logs or error messages
- Missing input validation
- Insecure defaults

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "security",
  "title": "Short description",
  "detail": "The vulnerability, its impact, and how to fix it",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  tests: {
    agent: 'codex',
    label: 'Test Coverage Gaps',
    prompt: `Analyze this codebase for test coverage gaps and testing issues.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Files with business logic that have no corresponding test file
- API routes/handlers with no integration tests
- Complex utility functions without unit tests
- Missing edge case coverage in existing tests
- Test files that are empty or have skipped/pending tests
- Missing error path testing
- Components with user interaction that lack interaction tests

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "tests",
  "title": "Short description",
  "detail": "What needs testing and what test cases to add",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },

  types: {
    agent: 'codex',
    label: 'Type Safety and Error Handling',
    prompt: `Analyze this codebase for type safety issues and missing error handling.

Project: {{projectName}}
File manifest:
{{manifest}}

Look for:
- Use of 'any' type that should be properly typed
- Missing null/undefined checks
- Unsafe type assertions (as unknown as X)
- Missing error boundaries in React components
- try/catch blocks that swallow errors silently
- Promises without .catch() or missing await
- Missing return type annotations on exported functions
- Unhandled edge cases in switch statements (missing default)

Respond ONLY with a JSON array of findings. Each finding must have:
{
  "file": "relative/path/to/file.ts",
  "line": null,
  "severity": "critical" | "major" | "minor",
  "category": "types",
  "title": "Short description",
  "detail": "The type safety issue and how to fix it",
  "effort": "trivial" | "small" | "medium" | "large"
}

If you find nothing, return an empty array: []
Do NOT include any explanation outside the JSON array.`,
  },
};

// -- File manifest builder ---------------------------------------------------

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.expo',
  'dist',
  'build',
  'coverage',
  '.hydra',
  '.vercel',
  '.turbo',
  '__pycache__',
  '.cache',
  'android',
  'ios',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.sql',
  '.prisma',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
]);

function getGitPrioritySets(projectPath: string): PrioritySets {
  const changed = new Set<string>();
  const recent = new Set<string>();

  const status = gitOutput(projectPath, ['status', '--porcelain']);
  for (const rawLine of status.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) {
      filePath = filePath.split(' -> ').pop() ?? filePath;
    }
    changed.add(filePath.replace(/\\/g, '/'));
  }

  const recentFiles = gitOutput(projectPath, [
    'log',
    '--name-only',
    '--pretty=format:',
    '-n',
    '50',
  ]);
  for (const line of recentFiles.split('\n')) {
    const normalized = line.trim().replace(/\\/g, '/');
    if (normalized !== '') recent.add(normalized);
  }

  return { changed, recent };
}

function gitOutput(projectPath: string, gitArgs: string[]): string {
  try {
    return execFileSync('git', ['-C', projectPath, ...gitArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function buildManifest(
  projectPath: string,
  maxFiles: number,
): { files: FileEntry[]; stats: ManifestStats } {
  const candidates: FileEntry[] = [];
  const scanLimit = Math.max(maxFiles * 6, 1000);

  function walk(dir: string, depth = 0) {
    if (depth > 10 || candidates.length >= scanLimit) return;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (candidates.length >= scanLimit) break;
      if (entry.name.startsWith('.')) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) {
          walk(fullPath, depth + 1);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf('.');
      if (dot < 0) continue;

      const ext = entry.name.slice(dot);
      if (!CODE_EXTENSIONS.has(ext)) continue;

      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }

      candidates.push({
        path: relative(projectPath, fullPath).replace(/\\/g, '/'),
        size: st.size,
        ext,
      });
    }
  }

  walk(projectPath);

  const prioritySets = getGitPrioritySets(projectPath);
  const ranked = rankManifest(candidates, prioritySets);
  const selected = ranked.slice(0, maxFiles);

  const changedCount = selected.filter((f) => f.priority === 'changed').length;
  const recentCount = selected.filter((f) => f.priority === 'recent').length;

  return {
    files: selected,
    stats: {
      candidates: candidates.length,
      selected: selected.length,
      changed: changedCount,
      recent: recentCount,
    },
  };
}

function rankManifest(files: FileEntry[], prioritySets: PrioritySets): FileEntry[] {
  return [...files]
    .map((file) => {
      const isChanged = prioritySets.changed.has(file.path);
      const isRecent = prioritySets.recent.has(file.path);
      let priority = 'normal';
      if (isChanged) priority = 'changed';
      else if (isRecent) priority = 'recent';

      let score = 0;
      if (isChanged) score += 250;
      if (isRecent) score += 100;
      // Prefer smaller files very slightly for better context density.
      score -= Math.min(file.size / 500000, 5);

      return { ...file, priority, score };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });
}

function formatManifest(files: FileEntry[]): string {
  const groups: Partial<Record<string, FileEntry[]>> = {};
  for (const f of files) {
    const topDir = f.path.includes('/') ? (f.path.split('/')[0] ?? '(root)') : '(root)';
    const existing = groups[topDir];
    if (existing == null) {
      groups[topDir] = [f];
    } else {
      existing.push(f);
    }
  }

  let out = '';
  for (const [dir, entries] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
    if (entries == null) continue;
    out += `\n${dir}/\n`;
    for (const file of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      let hint = '';
      if (file.priority === 'changed') hint = ' [changed]';
      else if (file.priority === 'recent') hint = ' [recent]';
      out += `  ${file.path}${hint}\n`;
    }
  }
  return out;
}

// -- Agent dispatch ----------------------------------------------------------

/**
 * Build the [cmd, args] pair for a non-interactive audit invocation.
 * Handles function-style (built-in agents) and object-style ({ cmd, args })
 * invocations from wizard-created custom CLI agents.
 */
function buildAuditInvocation(
  agentDef: AgentDef,
  prompt: string,
  opts: HeadlessOpts = {},
): [string, string[]] {
  // Cast through unknown to handle both typed function invocations and wizard-created
  // object-style invocations ({ cmd, args }) that don't match the strict AgentInvoke type.
  const rawInvoke = agentDef.invoke as unknown as {
    nonInteractive?:
      | ((prompt: string, opts: HeadlessOpts) => [string, string[]])
      | { cmd: string; args: string[] }
      | null;
  } | null;
  const ni = rawInvoke?.nonInteractive;
  if (typeof ni === 'function') return ni(prompt, opts);
  if (ni != null && typeof ni === 'object' && 'cmd' in ni && Array.isArray(ni.args)) {
    return [ni.cmd, expandInvokeArgs(ni.args, { prompt, cwd: opts.cwd ?? process.cwd() })];
  }
  throw new Error(`Agent "${agentDef.name}" does not support audit dispatch`);
}

function getAgentCommand(
  agent: string,
  prompt: string,
  economy: boolean,
  projectPath: string,
): AgentCommandResult {
  const agentDef = getAgent(agent);
  if (!agentDef) throw new Error(`Unknown agent: ${agent}`);
  const [cmd, baseArgs] = buildAuditInvocation(agentDef, prompt, { cwd: projectPath });
  if (!economy) return { cmd, args: baseArgs };
  const economyModel = agentDef.economyModel();
  if (economyModel == null || economyModel === '') return { cmd, args: baseArgs };
  // Only inject model flag for function-based invocations (built-in agents with known CLI flags)
  if (typeof agentDef.invoke?.nonInteractive !== 'function') return { cmd, args: baseArgs };
  const modelFlag = agent === 'codex' || agent === 'gemini' ? '-m' : '--model';
  return { cmd, args: [...baseArgs, modelFlag, economyModel] };
}

function dispatchToAgent(
  agent: string,
  prompt: string,
  projectPath: string,
  economy: boolean,
  timeoutMs: number,
): Promise<AgentResponse> {
  return new Promise((resolvePromise) => {
    const { cmd, args: invokeArgs } = getAgentCommand(agent, prompt, economy, projectPath);
    assertSafeSpawnCmd(cmd, `Agent '${agent}'`);
    const startedAt = Date.now();

    if (VERBOSE) {
      console.log(`  [${agent}] Dispatching (${cmd} -p ...)`);
    }

    const proc = spawn(cmd, invokeArgs, {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // child_process.spawn (and thus cross-spawn) has no built-in timeout,
    // so enforce the deadline with an explicit kill timer.
    const killTimer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolvePromise({
        agent,
        stdout,
        stderr: `${stderr}\n[hydra-audit] timed out after ${String(timeoutMs)}ms`,
        code: null,
        signal: 'SIGTERM',
        elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
      });
    }, timeoutMs);

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (VERBOSE) {
        const codeStr = code == null ? 'null' : String(code);
        const signalStr = signal ?? 'none';
        const status = code === 0 ? 'ok' : `exit=${codeStr} signal=${signalStr}`;
        console.log(`  [${agent}] ${status} (${elapsedSec}s, ${String(stdout.length)} chars)`);
      }
      resolvePromise({
        agent,
        stdout,
        stderr,
        code: code ?? null,
        signal: signal ?? null,
        elapsedSec,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      resolvePromise({
        agent,
        stdout: '',
        stderr: err.message,
        code: -1,
        signal: null,
        elapsedSec: '0.0',
      });
    });
  });
}

// -- Response parsing --------------------------------------------------------

const SEVERITIES = new Set(['critical', 'major', 'minor']);
const EFFORTS = new Set(['trivial', 'small', 'medium', 'large']);
const CATEGORY_ALIASES = {
  inconsistency: 'inconsistencies',
};

function parseFindings(agentResponse: AgentResponse, fallbackCategory: string): Finding[] {
  const rawStdout = agentResponse.stdout.trim();
  if (rawStdout === '') return [];

  // Normalize through the agent's plugin parser so that wrapped output formats
  // (e.g. Claude's JSON envelope) are unwrapped before JSON array extraction.
  const agentDef = getAgent(agentResponse.agent);
  let text = rawStdout;
  if (agentDef?.parseOutput) {
    try {
      const parsed = agentDef.parseOutput(rawStdout);
      if (parsed.output.trim().length > 0) text = parsed.output;
    } catch {
      /* fall back to raw stdout on plugin error */
    }
  }

  const candidates = [text];

  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    if (match[1] !== '') candidates.push(match[1].trim());
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    candidates.push(text.slice(firstBracket, lastBracket + 1));
  }

  for (const rawCandidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(rawCandidate);
      if (!Array.isArray(parsed)) continue;

      return (parsed as unknown[])
        .map((item) => normalizeFinding(item, fallbackCategory))
        .filter((f): f is Finding => f != null);
    } catch {
      // try next candidate
    }
  }

  if (VERBOSE) {
    console.log(`  [${agentResponse.agent}] Could not parse JSON response`);
    console.log(`  [${agentResponse.agent}] Raw (first 300 chars): ${text.slice(0, 300)}`);
  }

  return [];
}

function normalizeSeverityEffortCategory(
  r: Record<string, unknown>,
  fallbackCategory: string,
): { severity: string; effort: string; category: string } {
  const severity = typeof r['severity'] === 'string' ? r['severity'].toLowerCase() : '';
  const normalizedSeverity = SEVERITIES.has(severity) ? severity : 'minor';

  const effort = typeof r['effort'] === 'string' ? r['effort'].toLowerCase() : '';
  const normalizedEffort = EFFORTS.has(effort) ? effort : 'medium';

  const categoryRaw =
    typeof r['category'] === 'string' ? r['category'].toLowerCase() : fallbackCategory;
  const alias = (CATEGORY_ALIASES as Record<string, string | undefined>)[categoryRaw];
  let normalizedCategory: string;
  if (alias != null) {
    normalizedCategory = alias;
  } else if (categoryRaw.length > 0) {
    normalizedCategory = categoryRaw;
  } else if (fallbackCategory.length > 0) {
    normalizedCategory = fallbackCategory;
  } else {
    normalizedCategory = 'uncategorized';
  }

  return { severity: normalizedSeverity, effort: normalizedEffort, category: normalizedCategory };
}

function normalizeFinding(raw: unknown, fallbackCategory: string): Finding | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const {
    severity: normalizedSeverity,
    effort: normalizedEffort,
    category: normalizedCategory,
  } = normalizeSeverityEffortCategory(r, fallbackCategory);

  const rawLine = r['line'];
  const lineNumber =
    typeof rawLine === 'number' && Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null;
  const file = typeof r['file'] === 'string' ? r['file'].replace(/\\/g, '/') : '';
  const rawTitle = r['title'];
  const title =
    typeof rawTitle === 'string' && rawTitle.trim().length > 0
      ? rawTitle.trim()
      : 'Untitled finding';
  const rawDetail = r['detail'];
  const detail =
    typeof rawDetail === 'string' && rawDetail.trim().length > 0
      ? rawDetail.trim()
      : 'No detail provided.';

  return {
    file,
    line: lineNumber,
    severity: normalizedSeverity,
    category: normalizedCategory,
    title,
    detail,
    effort: normalizedEffort,
  };
}

// -- Deduplication and scoring ----------------------------------------------

const SEVERITY_SCORE = { critical: 100, major: 50, minor: 10 };
const EFFORT_SCORE = { trivial: 4, small: 3, medium: 2, large: 1 };

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();

  for (const finding of findings) {
    const key = `${finding.category}::${finding.file}::${finding.title}`.toLowerCase();
    const existing = seen.get(key);

    if (existing == null) {
      seen.set(key, finding);
      continue;
    }

    const currentScore = (SEVERITY_SCORE as Record<string, number>)[finding.severity] ?? 0;
    const existingScore = (SEVERITY_SCORE as Record<string, number>)[existing.severity] ?? 0;
    if (currentScore > existingScore) {
      seen.set(key, finding);
    }
  }

  return Array.from(seen.values());
}

function scoreAndSort(findings: Finding[]): ScoredFinding[] {
  return findings
    .map(
      (finding): ScoredFinding => ({
        ...finding,
        _score:
          ((SEVERITY_SCORE as Record<string, number>)[finding.severity] ?? 10) *
          ((EFFORT_SCORE as Record<string, number>)[finding.effort] ?? 2),
      }),
    )
    .sort((a, b) => b._score - a._score);
}

// -- Report generation -------------------------------------------------------

function renderByCategorySection(byCategory: Partial<Record<string, ScoredFinding[]>>): string {
  let md = `---\n\n## By Category\n\n`;
  for (const [category, categoryFindings] of Object.entries(byCategory).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (categoryFindings == null) continue;
    const maybeDef = AUDIT_CATEGORIES[category] as AuditCategoryDef | undefined;
    const categoryLabel = maybeDef?.label ?? category;
    const categoryAgent = maybeDef?.agent ?? 'unknown';
    md += `### ${categoryLabel} (${categoryAgent})\n\n`;
    for (const finding of categoryFindings) {
      md += `- **${finding.title}** \`${finding.severity}\` \`${finding.effort}\`\n`;
      if (finding.file.length > 0) {
        const lineRef = finding.line == null ? '' : `:${String(finding.line)}`;
        md += `  File: \`${finding.file}\`${lineRef}\n`;
      }
      md += `  ${finding.detail}\n\n`;
    }
  }
  return md;
}

function renderQuickWinsSection(findings: ScoredFinding[]): string {
  const quickWins = findings.filter(
    (f) => (f.effort === 'trivial' || f.effort === 'small') && f.severity !== 'minor',
  );
  if (quickWins.length === 0) return '';
  let md = `---\n\n## Quick Wins\n\n`;
  md += `> High-impact, low-effort items to tackle first.\n\n`;
  for (const finding of quickWins) {
    const fileRef = finding.file.length > 0 ? finding.file : 'project-wide';
    md += `- **${finding.title}** - \`${fileRef}\` (${finding.severity}, ${finding.effort})\n`;
  }
  return `${md}\n`;
}

function generateReport(
  findings: ScoredFinding[],
  manifest: FileEntry[],
  reportMeta: ReportMeta,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16);

  const criticalCount = findings.filter((f) => f.severity === 'critical').length;
  const majorCount = findings.filter((f) => f.severity === 'major').length;
  const minorCount = findings.filter((f) => f.severity === 'minor').length;

  const byCategory: Partial<Record<string, ScoredFinding[]>> = {};
  for (const finding of findings) {
    const category = finding.category.length > 0 ? finding.category : 'uncategorized';
    const existing = byCategory[category];
    if (existing == null) {
      byCategory[category] = [finding];
    } else {
      existing.push(finding);
    }
  }

  let md = `# Audit Report: ${reportMeta.projectName}

**Run ID:** ${reportMeta.runId}
**Date:** ${date} ${time}
**Agents:** ${reportMeta.agents.join(', ')}
**Categories:** ${reportMeta.categories.join(', ')}
**Files scanned:** ${String(manifest.length)}
**Manifest bias:** changed ${String(reportMeta.manifestStats.changed)}, recent ${String(reportMeta.manifestStats.recent)}
**Findings:** ${String(findings.length)} (${String(criticalCount)} critical, ${String(majorCount)} major, ${String(minorCount)} minor)
**Time:** ${reportMeta.elapsedSec}s

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | ${String(criticalCount)} |
| Major    | ${String(majorCount)} |
| Minor    | ${String(minorCount)} |
| **Total** | **${String(findings.length)}** |

---

## Prioritized Punch List

> Sorted by impact x ease-of-fix. Tackle top-down.

`;

  for (const [i, finding] of findings.entries()) {
    let severityIcon = '[MINOR]';
    if (finding.severity === 'critical') severityIcon = '[CRIT]';
    else if (finding.severity === 'major') severityIcon = '[MAJOR]';
    const effortTag = finding.effort.length > 0 ? ` \`${finding.effort}\`` : '';
    const lineRef = finding.line == null ? '' : `:${String(finding.line)}`;
    const fileRef = finding.file.length > 0 ? ` - \`${finding.file}\`${lineRef}` : '';
    md += `${String(i + 1)}. ${severityIcon} **${finding.title}**${effortTag}${fileRef}\n`;
    md += `   ${finding.detail}\n\n`;
  }

  md += renderByCategorySection(byCategory);
  md += renderQuickWinsSection(findings);
  md += `---\n\n*Generated by Hydra Audit (${reportMeta.runId}) on ${date} at ${time}. Analysis only; no code was modified.*\n`;

  return md;
}

// -- Main -------------------------------------------------------------------

function printAuditHeader(
  activeAgents: string[],
  runnableCategories: string[],
  unknownAgents: string[],
  unknownCategories: string[],
): void {
  const agentsDisplay = activeAgents.join(', ');
  const categoriesDisplay = runnableCategories.join(', ');
  console.log('');
  console.log('=== Hydra Audit ===');
  console.log(`  Run ID:     ${RUN_ID}`);
  console.log(`  Project:    ${PROJECT}`);
  console.log(`  Agents:     ${agentsDisplay === '' ? '(none)' : agentsDisplay}`);
  console.log(`  Categories: ${categoriesDisplay === '' ? '(none)' : categoriesDisplay}`);
  console.log(`  Max files:  ${String(MAX_FILES)}`);
  if (ECONOMY) console.log('  Models:     economy tier');
  console.log('');
  if (unknownAgents.length > 0)
    console.log(`! Ignoring unknown agents: ${unknownAgents.join(', ')}`);
  if (unknownCategories.length > 0)
    console.log(`! Ignoring unknown categories: ${unknownCategories.join(', ')}`);
}

async function dispatchAllCategories(
  runnableCategories: string[],
  manifestText: string,
  projectName: string,
): Promise<Finding[]> {
  const categoriesByAgent: Partial<Record<string, string[]>> = {};
  for (const category of runnableCategories) {
    const def = AUDIT_CATEGORIES[category];
    const { agent } = def;
    const existing = categoriesByAgent[agent];
    if (existing == null) {
      categoriesByAgent[agent] = [category];
    } else {
      existing.push(category);
    }
  }

  const agentPromises = Object.entries(categoriesByAgent).map(
    async ([agent, categories]): Promise<Finding[]> => {
      const findings: Finding[] = [];
      for (const category of categories ?? []) {
        const def = AUDIT_CATEGORIES[category];
        const prompt = def.prompt
          .replace('{{manifest}}', manifestText)
          .replace('{{projectName}}', projectName);
        console.log(`  [${agent}] ${def.label}...`);
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential: categories for the same agent run one-at-a-time to avoid overwhelming a single agent process
        const result = await dispatchToAgent(agent, prompt, PROJECT, ECONOMY, TIMEOUT_MS);
        if (result.code !== 0 && VERBOSE && result.stderr.length > 0) {
          console.log(`  [${agent}] stderr: ${result.stderr.slice(0, 300)}`);
        }
        const parsed = parseFindings(result, category);
        console.log(`  [${agent}] ${def.label}: ${String(parsed.length)} findings`);
        findings.push(...parsed);
      }
      return findings;
    },
  );

  const nested = await Promise.all(agentPromises);
  return nested.flat();
}

function saveReport(report: string): void {
  const reportDir = dirname(REPORT_PATH);
  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }
  writeFileSync(REPORT_PATH, report, 'utf8');
  console.log(`   Report saved: ${REPORT_PATH}`);
}

function printSummary(scored: ScoredFinding[], elapsedSec: string): void {
  const critical = scored.filter((f) => f.severity === 'critical').length;
  const major = scored.filter((f) => f.severity === 'major').length;
  const quickWins = scored.filter(
    (f) => (f.effort === 'trivial' || f.effort === 'small') && f.severity !== 'minor',
  ).length;
  console.log('');
  console.log('=== Summary ===');
  console.log(`  Run ID:      ${RUN_ID}`);
  console.log(`  Critical:    ${String(critical)}`);
  console.log(`  Major:       ${String(major)}`);
  console.log(`  Quick wins:  ${String(quickWins)}`);
  console.log(`  Time:        ${elapsedSec}s`);
  console.log('');
}

async function main(): Promise<void> {
  const knownAgents = new Set(['gemini', 'claude', 'codex']);
  const activeAgents = AGENTS.filter((agent) => knownAgents.has(agent));
  const unknownAgents = AGENTS.filter((agent) => !knownAgents.has(agent));

  const requestedCategories = CATEGORIES.includes('all') ? ALL_CATEGORIES : CATEGORIES;
  const unknownCategories = requestedCategories.filter(
    (category) => !(category in AUDIT_CATEGORIES),
  );
  const validCategories = requestedCategories.filter((category) => category in AUDIT_CATEGORIES);
  const runnableCategories = validCategories.filter((category) =>
    activeAgents.includes(AUDIT_CATEGORIES[category].agent),
  );

  printAuditHeader(activeAgents, runnableCategories, unknownAgents, unknownCategories);

  console.log('1) Building file manifest...');
  const { files: manifest, stats: manifestStats } = buildManifest(PROJECT, MAX_FILES);
  console.log(
    `   Indexed ${String(manifest.length)} files (from ${String(manifestStats.candidates)} candidates)`,
  );
  if (manifestStats.changed > 0 || manifestStats.recent > 0) {
    console.log(
      `   Prioritized changed=${String(manifestStats.changed)}, recent=${String(manifestStats.recent)}`,
    );
  }
  if (manifest.length === 0) {
    console.log('   No code files found. Check project path.');
    exit(1);
  }
  if (runnableCategories.length === 0) {
    console.log('   No runnable categories after filters; generating empty report.');
  }

  const manifestText = formatManifest(manifest);
  const projectName = basename(PROJECT);
  const startedAt = Date.now();

  let allFindings: Finding[] = [];
  if (runnableCategories.length > 0) {
    console.log('');
    console.log('2) Dispatching audit categories:');
    for (const category of runnableCategories) {
      const def = AUDIT_CATEGORIES[category];
      console.log(`   - ${def.label} -> ${def.agent}`);
    }
    console.log('');
    allFindings = await dispatchAllCategories(runnableCategories, manifestText, projectName);
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(0);
  console.log('');
  console.log(`3) Processing ${String(allFindings.length)} raw findings...`);
  const deduped = deduplicateFindings(allFindings);
  const scored = scoreAndSort(deduped);
  console.log(`   ${String(scored.length)} unique findings after deduplication`);

  console.log('');
  console.log('4) Generating report...');
  const report = generateReport(scored, manifest, {
    runId: RUN_ID,
    projectName,
    categories: runnableCategories,
    agents: activeAgents,
    elapsedSec,
    manifestStats,
  });
  saveReport(report);
  printSummary(scored, elapsedSec);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${message}`);
  exit(1);
});
