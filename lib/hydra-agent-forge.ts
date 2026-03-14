/**
 * Hydra Agent Forge — Multi-model agent creation pipeline.
 *
 * Automates creation of virtual sub-agents through a 5-phase pipeline:
 *   ANALYZE (Gemini) → DESIGN (Claude) → CRITIQUE (Gemini) → REFINE (Claude) → TEST (optional)
 *
 * Each phase uses executeAgent() to invoke the appropriate CLI headlessly.
 * Forged agents are persisted to hydra.config.json (agents.custom) and
 * metadata is stored in docs/coordination/forge/FORGE_REGISTRY.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Interface as ReadlineInterface } from 'node:readline';
import pc from 'picocolors';
import { git } from './hydra-shared/git-ops.ts';
import {
  registerAgent,
  unregisterAgent,
  getAgent,
  listAgents,
  AGENT_TYPE,
  TASK_TYPES,
} from './hydra-agents.ts';
import {
  loadHydraConfig,
  saveHydraConfig,
  invalidateConfigCache,
  HYDRA_ROOT,
  resolveProject,
} from './hydra-config.ts';
import { executeAgent } from './hydra-shared/agent-executor.ts';
import { parseJsonLoose } from './hydra-utils.ts';
import { promptChoice } from './hydra-prompt-choice.ts';
import { sectionHeader, DIM, ACCENT, SUCCESS, WARNING, ERROR } from './hydra-ui.ts';
import type { TaskType, AgentType } from './types.ts';

// ── Interfaces ────────────────────────────────────────────────────────────────

/** A forged virtual agent spec produced by the pipeline. */
export interface ForgeSpec {
  name: string;
  displayName: string;
  baseAgent: string;
  strengths: string[];
  weaknesses: string[];
  tags: string[];
  taskAffinity: Partial<Record<TaskType, number>>;
  rolePrompt: string;
  enabled: boolean;
  type?: string;
}

/** Analysis result from the ANALYZE phase (Gemini). */
interface AnalysisResult {
  recommendedFocus: string;
  suggestedName: string;
  suggestedBase: string;
  reasoning: string;
  targetTaskTypes: string[];
  suggestedStrengths: string[];
  codebaseInsights?: string;
}

/** Critique result from the CRITIQUE phase (Gemini). */
interface CritiqueResult {
  overallAssessment: string;
  issues: Array<{ severity: string; field: string; message: string }>;
  suggestions: string[];
  affinityAdjustments: Partial<Record<string, number>>;
  rolePromptFeedback: string;
  nameAlternatives?: string[];
  baseAgentComment?: string;
}

/** Codebase profile built by analyzeCodebase(). */
export interface CodebaseProfile {
  projectName: string;
  projectRoot: string;
  fileTypes: Record<string, number>;
  hasTests: boolean;
  packageJson: Record<string, unknown> | null;
  claudeMd: boolean;
  recentCommits: string[];
  existingAgents: Array<{ name: string; type: string; topAffinities: string[] }>;
  coverageGaps: Array<{ type: string; bestScore: number }>;
}

/** Per-phase result stored in the pipeline result. */
interface ForgePhaseResult {
  result: unknown;
  durationMs: number;
  ok: boolean;
}

/** Pipeline phases map. */
interface ForgePhases {
  analyze?: ForgePhaseResult;
  design?: ForgePhaseResult;
  critique?: ForgePhaseResult;
  refine?: ForgePhaseResult;
}

/** Session metadata for a forge run. */
interface ForgeSession {
  description: string;
  startedAt: string;
  phasesRun: string[];
  completedAt?: string;
  testResult?: { ok: boolean; durationMs: number } | null;
}

/** Options for runForgePipeline(). */
export interface ForgePipelineOpts {
  phaseTimeoutMs?: number;
  onPhase?: (name: string, status: string, phaseData?: ForgePhaseResult) => void;
}

/** Options for forgeAgent() non-interactive API. */
export interface ForgeAgentOpts extends ForgePipelineOpts {
  name?: string;
  baseAgent?: string;
  skipTest?: boolean;
}

/** Options for testForgedAgent(). */
interface TestForgedAgentOpts {
  profile?: CodebaseProfile;
  timeoutMs?: number;
}

/** Entry stored in FORGE_REGISTRY.json. */
interface ForgeRegistryEntry {
  forgedAt: string;
  description: string;
  phasesRun: string[];
  testResult: { ok: boolean; durationMs: number } | null;
  version: number;
}

/** executeAgent extended opts — includes hub fields used inside agent-executor. */
type ExecuteAgentOpts = Record<string, unknown>;

/** Minimal agent entry shape returned by getAgent() / listAgents(). */
interface AgentEntry {
  name: string;
  type: string;
  taskAffinity: Record<string, number>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FORGE_DIR_REL = 'docs/coordination/forge';
const REGISTRY_FILE = 'FORGE_REGISTRY.json';
const SESSIONS_DIR = 'sessions';

const VALID_NAME_RE = /^[a-z][a-z0-9-]*$/;

const PHASE_NAMES = ['analyze', 'design', 'critique', 'refine'];

// ── Storage Helpers ───────────────────────────────────────────────────────────

let _testForgeDir: string | null = null;

/** Test-only: redirect forge reads/writes to a temp directory. Pass null to restore. */
export function _setTestForgeDir(p: string | null): void {
  _testForgeDir = p;
}

function forgeDir() {
  return _testForgeDir ?? path.join(HYDRA_ROOT, FORGE_DIR_REL);
}

function ensureForgeDir() {
  const dir = forgeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, SESSIONS_DIR), { recursive: true });
}

export function loadForgeRegistry(): Record<string, ForgeRegistryEntry> {
  try {
    const raw = fs.readFileSync(path.join(forgeDir(), REGISTRY_FILE), 'utf8');
    return JSON.parse(raw) as Record<string, ForgeRegistryEntry>;
  } catch {
    return {};
  }
}

export function saveForgeRegistry(registry: Record<string, ForgeRegistryEntry>): void {
  ensureForgeDir();
  fs.writeFileSync(
    path.join(forgeDir(), REGISTRY_FILE),
    `${JSON.stringify(registry, null, 2)}\n`,
    'utf8',
  );
}

function saveForgeSession(name: string, session: ForgeSession): string {
  ensureForgeDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `FORGE_${name}_${ts}.json`;
  fs.writeFileSync(
    path.join(forgeDir(), SESSIONS_DIR, filename),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );
  return filename;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateAgentName(spec: Partial<ForgeSpec>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (spec.name === undefined || !VALID_NAME_RE.test(spec.name)) {
    errors.push(`Invalid name "${spec.name ?? ''}": must match /^[a-z][a-z0-9-]*$/`);
  }

  if (spec.name != null && spec.name !== '') {
    const existing = getAgent(spec.name) as AgentEntry | null | undefined;
    if (existing?.type === AGENT_TYPE.PHYSICAL) {
      errors.push(`Name "${spec.name}" collides with a built-in physical agent`);
    }
  }

  return { errors, warnings };
}

function validateBaseAgent(spec: Partial<ForgeSpec>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (spec.baseAgent != null && spec.baseAgent !== '') {
    const base = getAgent(spec.baseAgent) as AgentEntry | null | undefined;
    if (!base) {
      errors.push(`Base agent "${spec.baseAgent}" does not exist`);
    } else if (base.type !== AGENT_TYPE.PHYSICAL) {
      errors.push(`Base agent "${spec.baseAgent}" must be a physical agent`);
    }
  } else {
    errors.push('baseAgent is required');
  }

  return { errors, warnings };
}

function validateTaskAffinity(spec: Partial<ForgeSpec>): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!spec.taskAffinity || typeof spec.taskAffinity !== 'object') {
    errors.push('taskAffinity object is required');
  } else {
    for (const type of TASK_TYPES) {
      const score = spec.taskAffinity[type as TaskType];
      if (score === undefined) {
        warnings.push(`Missing affinity for "${type}", will default to 0`);
      } else if (typeof score !== 'number' || score < 0 || score > 1) {
        warnings.push(
          `Affinity for "${type}" out of range (${String(score)}), will be clamped to 0-1`,
        );
      }
    }

    if (spec.baseAgent != null && spec.baseAgent !== '') {
      const base = getAgent(spec.baseAgent) as AgentEntry | null | undefined;
      if (base) {
        for (const [type, score] of Object.entries(spec.taskAffinity)) {
          const s = score;
          const baseAffinity = (base.taskAffinity as Partial<Record<string, number>>)[type] ?? 0;
          if (s > 0.8 && baseAffinity < 0.4) {
            warnings.push(
              `High affinity for "${type}" (${String(s)}) but base agent "${spec.baseAgent}" ` +
                `scores low (${String(baseAffinity)}) — may underperform`,
            );
          }
        }
      }
    }
  }

  return { errors, warnings };
}

/**
 * Validate an agent spec before registration.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
export function validateAgentSpec(spec: Partial<ForgeSpec>): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const nameResult = validateAgentName(spec);
  errors.push(...nameResult.errors);
  warnings.push(...nameResult.warnings);

  const baseResult = validateBaseAgent(spec);
  errors.push(...baseResult.errors);
  warnings.push(...baseResult.warnings);

  const affinityResult = validateTaskAffinity(spec);
  errors.push(...affinityResult.errors);
  warnings.push(...affinityResult.warnings);

  // rolePrompt length
  if (spec.rolePrompt != null && spec.rolePrompt !== '') {
    if (spec.rolePrompt.length < 100) {
      warnings.push(
        `rolePrompt is very short (${String(spec.rolePrompt.length)} chars) — consider adding more detail`,
      );
    }
    if (spec.rolePrompt.length > 5000) {
      warnings.push(
        `rolePrompt is very long (${String(spec.rolePrompt.length)} chars) — may waste context budget`,
      );
    }
  } else {
    errors.push('rolePrompt is required');
  }

  // Display name
  if (spec.displayName == null || spec.displayName === '') {
    warnings.push('displayName missing, will use name');
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Codebase Analysis ─────────────────────────────────────────────────────────

function scanFileTypes(dirs: string[]): Record<string, number> {
  const fileTypes: Record<string, number> = {};
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (ext !== '') fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
      }
    } catch {
      /* ignore */
    }
  }
  return fileTypes;
}

function findCoverageGaps(allAgents: unknown[]): Array<{ type: string; bestScore: number }> {
  const gaps: Array<{ type: string; bestScore: number }> = [];
  for (const type of TASK_TYPES) {
    let bestScore = 0;
    for (const agent of allAgents) {
      const score =
        (agent as { taskAffinity: Partial<Record<string, number>> }).taskAffinity[type] ?? 0;
      if (score > bestScore) bestScore = score;
    }
    if (bestScore < 0.7) {
      gaps.push({ type, bestScore });
    }
  }
  return gaps;
}

/**
 * Scan the current project for forge context.
 * Returns a codebase profile for the ANALYZE phase.
 */
export function analyzeCodebase(): CodebaseProfile {
  const project = resolveProject({ skipValidation: true });
  const root = project.projectRoot;
  const profile: CodebaseProfile = {
    projectName: project.projectName,
    projectRoot: root,
    fileTypes: {},
    hasTests: false,
    packageJson: null,
    claudeMd: false,
    recentCommits: [],
    existingAgents: [],
    coverageGaps: [],
  };

  // Package.json
  try {
    profile.packageJson = JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch {
    /* ignore */
  }

  // CLAUDE.md / HYDRA.md
  profile.claudeMd =
    fs.existsSync(path.join(root, 'CLAUDE.md')) || fs.existsSync(path.join(root, 'HYDRA.md'));

  // File type distribution (quick scan, top-level + src/)
  const scanDirs = [root];
  const srcDir = path.join(root, 'src');
  const libDir = path.join(root, 'lib');
  if (fs.existsSync(srcDir)) scanDirs.push(srcDir);
  if (fs.existsSync(libDir)) scanDirs.push(libDir);
  profile.fileTypes = scanFileTypes(scanDirs);

  // Test directory
  const testDir = path.join(root, 'test');
  const testsDir = path.join(root, 'tests');
  profile.hasTests =
    fs.existsSync(testDir) ||
    fs.existsSync(testsDir) ||
    fs.existsSync(path.join(root, '__tests__'));

  // Recent git commits
  const logResult = git(['log', '--oneline', '-10'], root);
  if (logResult.status === 0 && logResult.stdout !== '') {
    profile.recentCommits = logResult.stdout.trim().split('\n').filter(Boolean);
  }

  // Existing agents and coverage
  const allAgents = listAgents({ enabled: true });
  for (const agent of allAgents) {
    profile.existingAgents.push({
      name: (agent as { name: string }).name,
      type: (agent as { type: string }).type,
      topAffinities: Object.entries(
        (agent as { taskAffinity: Record<string, number> }).taskAffinity,
      )
        .sort(([, a], [, b]) => b - a)
        .slice(0, 3)
        .map(([t, s]) => `${t}:${(s * 100).toFixed(0)}%`),
    });
  }

  profile.coverageGaps = findCoverageGaps(allAgents);

  return profile;
}

// ── Phase Prompts ─────────────────────────────────────────────────────────────

function buildAnalyzePrompt(description: string, profile: CodebaseProfile): string {
  const pkgName = (profile.packageJson?.['name'] as string | undefined) ?? 'unnamed';
  const pkgDeps = profile.packageJson
    ? Object.keys((profile.packageJson['dependencies'] as Record<string, string> | undefined) ?? {})
        .slice(0, 10)
        .join(', ')
    : null;
  const descriptionLine =
    description === '' ? '(No specific description provided — auto-discover gaps)' : description;
  const fileTypesSummary = Object.entries(profile.fileTypes)
    .map(([ext, n]) => `${ext}(${String(n)})`)
    .join(', ');
  const fileTypesLine = fileTypesSummary === '' ? 'unknown' : fileTypesSummary;
  const recentCommitsSummary = profile.recentCommits.slice(0, 5).join(' | ');
  const recentCommitsLine = recentCommitsSummary === '' ? 'none' : recentCommitsSummary;
  const descriptionTask =
    description === ''
      ? 'Auto-discover the most impactful gap and recommend a specialization.'
      : `The user wants: "${description}" — map this to specific task types and recommend a base agent.`;
  return `You are analyzing a codebase to help create a specialized virtual AI agent.

## User's Description
${descriptionLine}

## Codebase Profile
- Project: ${profile.projectName}
- File types: ${fileTypesLine}
- Has tests: ${profile.hasTests ? 'yes' : 'no'}
- Has CLAUDE.md: ${profile.claudeMd ? 'yes' : 'no'}
- Package.json: ${pkgDeps === null ? 'none' : `${pkgName} — deps: ${pkgDeps}`}
- Recent commits: ${recentCommitsLine}

## Existing Agents
${profile.existingAgents.map((a) => `- ${a.name} (${a.type}): ${a.topAffinities.join(', ')}`).join('\n')}

## Coverage Gaps (task types with best agent < 70%)
${profile.coverageGaps.length > 0 ? profile.coverageGaps.map((g) => `- ${g.type}: best=${(g.bestScore * 100).toFixed(0)}%`).join('\n') : 'None — all task types well covered'}

## Task
Analyze this codebase and recommend a specialization focus for a new virtual agent.
${descriptionTask}

Respond with JSON only:
\`\`\`json
{
  "recommendedFocus": "brief description of recommended agent specialization",
  "suggestedName": "lowercase-hyphenated name",
  "suggestedBase": "claude|gemini|codex",
  "reasoning": "why this specialization and base agent",
  "targetTaskTypes": ["top 2-3 task types this agent should excel at"],
  "suggestedStrengths": ["3-5 keyword strengths"],
  "codebaseInsights": "what about the codebase informed this recommendation"
}
\`\`\``;
}

function buildDesignPrompt(
  description: string,
  analysis: AnalysisResult,
  _profile: CodebaseProfile,
): string {
  let intentLine = 'Auto-discovered specialization';
  if (analysis.recommendedFocus !== '') intentLine = analysis.recommendedFocus;
  if (description !== '') intentLine = description;
  return `You are designing a specialized virtual AI agent for the Hydra multi-agent system.

## User's Intent
${intentLine}

## Analysis Results
${JSON.stringify(analysis, null, 2)}

## Agent Design Requirements
Design a complete agent specification following this exact schema:

- **name**: lowercase-hyphenated (e.g. "perf-optimizer")
- **displayName**: Human-readable (e.g. "Performance Optimizer")
- **baseAgent**: Which physical agent to run on ("claude", "gemini", or "codex")
- **strengths**: 3-6 keyword strengths
- **weaknesses**: 2-4 keyword weaknesses
- **tags**: Searchable tags for discovery
- **taskAffinity**: Scores 0.0-1.0 for all 10 task types: planning, architecture, review, refactor, implementation, analysis, testing, research, documentation, security
- **rolePrompt**: Detailed multi-paragraph methodology guide (200-600 words). Include numbered steps, specific techniques, and output structure. This is the most important field — it defines the agent's behavior.

## Style Exemplars (existing sub-agents)
Here are examples of good rolePrompts and affinity patterns:
- security-reviewer (gemini): Security focus, OWASP methodology, severity ratings, remediation guidance. Scores: security=0.98, review=0.92, analysis=0.85.
- test-writer (codex): Test strategy, edge cases, coverage. Scores: testing=0.98, implementation=0.65.
- researcher (gemini): Systematic exploration, hypothesis-driven, evidence-based. Scores: research=0.98, analysis=0.90.

## Rules
1. The agent's top affinity should be 0.95-0.98 (not 1.0)
2. Base agent weaknesses should be reflected — don't give high affinity where the base agent scores low
3. rolePrompt must be specific to the specialization, not generic
4. Include concrete techniques and output structure in rolePrompt

Respond with JSON only:
\`\`\`json
{
  "name": "string",
  "displayName": "string",
  "baseAgent": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "tags": ["string"],
  "taskAffinity": {
    "planning": 0.0,
    "architecture": 0.0,
    "review": 0.0,
    "refactor": 0.0,
    "implementation": 0.0,
    "analysis": 0.0,
    "testing": 0.0,
    "research": 0.0,
    "documentation": 0.0,
    "security": 0.0
  },
  "rolePrompt": "string",
  "enabled": true
}
\`\`\``;
}

function buildCritiquePrompt(spec: ForgeSpec, analysis: AnalysisResult): string {
  return `You are reviewing a proposed virtual agent specification for the Hydra multi-agent system.

## Proposed Agent Spec
${JSON.stringify(spec, null, 2)}

## Original Analysis
${JSON.stringify(analysis, null, 2)}

## Review Criteria
1. **Affinity realism**: Do the taskAffinity scores make sense for the base agent's capabilities?
2. **rolePrompt quality**: Is it specific, actionable, and well-structured? Does it include concrete techniques?
3. **Overlap**: Does this agent duplicate existing agents without enough differentiation?
4. **Base agent suitability**: Is the chosen base agent (${spec.baseAgent}) the best fit?
5. **Naming**: Is the name clear, descriptive, and follows conventions?
6. **Strengths/weaknesses**: Are they accurate and balanced?

## Existing Agents for Overlap Check
Physical: claude (architect), gemini (analyst), codex (implementer)
Virtual: security-reviewer (gemini), test-writer (codex), doc-generator (claude), researcher (gemini), evolve-researcher (gemini)

Respond with JSON only:
\`\`\`json
{
  "overallAssessment": "good|needs-work|poor",
  "issues": [{"severity": "error|warning|info", "field": "string", "message": "string"}],
  "suggestions": ["concrete improvement suggestions"],
  "affinityAdjustments": {"taskType": 0.0},
  "rolePromptFeedback": "specific feedback on the rolePrompt",
  "nameAlternatives": ["alternative names if current is weak"],
  "baseAgentComment": "is the base agent choice good?"
}
\`\`\``;
}

function buildRefinePrompt(spec: ForgeSpec, critique: CritiqueResult): string {
  return `You are refining a virtual agent specification based on peer review.

## Current Spec
${JSON.stringify(spec, null, 2)}

## Critique Feedback
${JSON.stringify(critique, null, 2)}

## Instructions
1. Incorporate all valid suggestions from the critique
2. Fix any issues marked as "error" severity
3. Consider "warning" suggestions — apply if they improve quality
4. Polish the rolePrompt — ensure it's specific, well-structured, and actionable
5. Adjust affinities based on the suggested adjustments (if they make sense)
6. Keep the agent's core identity intact — don't completely change its focus

Respond with the COMPLETE refined spec as JSON only:
\`\`\`json
{
  "name": "string",
  "displayName": "string",
  "baseAgent": "string",
  "strengths": ["string"],
  "weaknesses": ["string"],
  "tags": ["string"],
  "taskAffinity": {
    "planning": 0.0,
    "architecture": 0.0,
    "review": 0.0,
    "refactor": 0.0,
    "implementation": 0.0,
    "analysis": 0.0,
    "testing": 0.0,
    "research": 0.0,
    "documentation": 0.0,
    "security": 0.0
  },
  "rolePrompt": "string",
  "enabled": true
}
\`\`\``;
}

// ── Normalize / Clamp ─────────────────────────────────────────────────────────

function normalizeSpec(raw: Partial<ForgeSpec>): ForgeSpec {
  const spec = { ...raw } as ForgeSpec;

  // Ensure name is lowercase-hyphenated
  if (spec.name !== '') {
    spec.name = spec.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // Clamp affinities to 0-1, ensure all task types present
  for (const type of TASK_TYPES) {
    const val = spec.taskAffinity[type as TaskType];
    spec.taskAffinity[type as TaskType] = val === undefined ? 0 : Math.max(0, Math.min(1, val));
  }
  // Remove extraneous keys
  for (const key of Object.keys(spec.taskAffinity)) {
    if (!TASK_TYPES.includes(key)) {
      const ta = spec.taskAffinity as Record<string, number | undefined>;
      Reflect.deleteProperty(ta, key);
    }
  }

  // Ensure arrays
  if (!Array.isArray(spec.strengths)) spec.strengths = [];
  if (!Array.isArray(spec.weaknesses)) spec.weaknesses = [];
  if (!Array.isArray(spec.tags)) spec.tags = [];

  // Ensure enabled
  spec.enabled = (spec.enabled as boolean | undefined) !== false;
  spec.type = AGENT_TYPE.VIRTUAL;

  return spec;
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

type PhaseCb = (name: string, status: string, data?: ForgePhaseResult) => void;

async function runAnalyzePhase(
  description: string,
  profile: CodebaseProfile,
  timeoutMs: number,
  onPhase: PhaseCb,
): Promise<{ analysis: AnalysisResult; phaseResult: ForgePhaseResult }> {
  onPhase('analyze', 'running');
  const analyzeResult = await executeAgent('gemini', buildAnalyzePrompt(description, profile), {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'gemini-forge',
  } as ExecuteAgentOpts);
  const analysis =
    (parseJsonLoose(analyzeResult.output) as AnalysisResult | null) ??
    ({
      recommendedFocus: description === '' ? 'general purpose' : description,
      suggestedName: 'custom-agent',
      suggestedBase: 'claude',
      reasoning: 'Fallback — analysis phase failed to produce structured output',
      targetTaskTypes: ['implementation'],
      suggestedStrengths: ['general'],
    } satisfies AnalysisResult);
  const phaseResult: ForgePhaseResult = {
    result: analysis,
    durationMs: analyzeResult.durationMs,
    ok: analyzeResult.ok,
  };
  onPhase('analyze', 'done', phaseResult);
  return { analysis, phaseResult };
}

async function runDesignPhase(
  description: string,
  analysis: AnalysisResult,
  profile: CodebaseProfile,
  timeoutMs: number,
  onPhase: PhaseCb,
): Promise<{ designSpec: ForgeSpec; phaseResult: ForgePhaseResult }> {
  onPhase('design', 'running');
  const designResult = await executeAgent(
    'claude',
    buildDesignPrompt(description, analysis, profile),
    {
      timeoutMs,
      useStdin: true,
      maxOutputBytes: 64 * 1024,
      hubCwd: process.cwd(),
      hubProject: path.basename(process.cwd()),
      hubAgent: 'claude-forge',
    } as ExecuteAgentOpts,
  );

  let designOutput = designResult.output;
  try {
    const parsed = JSON.parse(designOutput) as Record<string, unknown>;
    const rawResult = parsed['result'];
    if (typeof rawResult === 'string') designOutput = rawResult;
  } catch {
    /* use raw */
  }

  let rawDesignSpec = parseJsonLoose(designOutput) as Partial<ForgeSpec> | null;
  if (rawDesignSpec?.name == null || rawDesignSpec.name === '') {
    rawDesignSpec = {
      name: analysis.suggestedName === '' ? 'custom-agent' : analysis.suggestedName,
      displayName: (analysis.suggestedName === '' ? 'Custom Agent' : analysis.suggestedName)
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      baseAgent: analysis.suggestedBase === '' ? 'claude' : analysis.suggestedBase,
      strengths: analysis.suggestedStrengths,
      weaknesses: ['scope-limited'],
      tags: analysis.targetTaskTypes,
      taskAffinity: Object.fromEntries(
        TASK_TYPES.map((t) => [t, analysis.targetTaskTypes.includes(t) ? 0.85 : 0.3]),
      ) as Partial<Record<TaskType, number>>,
      rolePrompt: `You are a specialized agent for: ${description === '' ? analysis.recommendedFocus : description}. Follow best practices and provide structured, actionable output.`,
      enabled: true,
    };
  }
  const designSpec: ForgeSpec = normalizeSpec(rawDesignSpec);
  const phaseResult: ForgePhaseResult = {
    result: designSpec,
    durationMs: designResult.durationMs,
    ok: designResult.ok,
  };
  onPhase('design', 'done', phaseResult);
  return { designSpec, phaseResult };
}

async function runCritiquePhase(
  designSpec: ForgeSpec,
  analysis: AnalysisResult,
  timeoutMs: number,
  onPhase: PhaseCb,
): Promise<{ critique: CritiqueResult; phaseResult: ForgePhaseResult }> {
  onPhase('critique', 'running');
  const critiqueResult = await executeAgent('gemini', buildCritiquePrompt(designSpec, analysis), {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'gemini-forge',
  } as ExecuteAgentOpts);
  const critique = (parseJsonLoose(critiqueResult.output) as CritiqueResult | null) ?? {
    overallAssessment: 'good',
    issues: [],
    suggestions: [],
    affinityAdjustments: {},
    rolePromptFeedback: 'No structured critique available — using design as-is.',
  };
  const phaseResult: ForgePhaseResult = {
    result: critique,
    durationMs: critiqueResult.durationMs,
    ok: critiqueResult.ok,
  };
  onPhase('critique', 'done', phaseResult);
  return { critique, phaseResult };
}

async function runRefinePhase(
  designSpec: ForgeSpec,
  critique: CritiqueResult,
  timeoutMs: number,
  onPhase: PhaseCb,
): Promise<{ finalSpec: ForgeSpec; phaseResult: ForgePhaseResult }> {
  onPhase('refine', 'running');
  const refineResult = await executeAgent('claude', buildRefinePrompt(designSpec, critique), {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
    hubCwd: process.cwd(),
    hubProject: path.basename(process.cwd()),
    hubAgent: 'claude-forge',
  } as ExecuteAgentOpts);

  let refineOutput = refineResult.output;
  try {
    const parsed = JSON.parse(refineOutput) as Record<string, unknown>;
    const rawResult = parsed['result'];
    if (typeof rawResult === 'string') refineOutput = rawResult;
  } catch {
    /* use raw */
  }

  let rawFinalSpec = parseJsonLoose(refineOutput) as Partial<ForgeSpec> | null;
  if (rawFinalSpec?.name == null || rawFinalSpec.name === '') {
    rawFinalSpec = { ...designSpec } as Partial<ForgeSpec>;
    for (const [type, score] of Object.entries(critique.affinityAdjustments)) {
      if (TASK_TYPES.includes(type) && typeof score === 'number') {
        rawFinalSpec.taskAffinity ??= {};
        rawFinalSpec.taskAffinity[type as TaskType] = Math.max(0, Math.min(1, score));
      }
    }
  }
  const finalSpec: ForgeSpec = normalizeSpec(rawFinalSpec);
  const phaseResult: ForgePhaseResult = {
    result: finalSpec,
    durationMs: refineResult.durationMs,
    ok: refineResult.ok,
  };
  onPhase('refine', 'done', phaseResult);
  return { finalSpec, phaseResult };
}

/**
 * Run the 4-phase forge pipeline (ANALYZE → DESIGN → CRITIQUE → REFINE).
 *
 * @param {string} description - User's intent description
 * @param {object} [codebaseCtx] - Pre-built codebase profile (or auto-scan)
 * @param {object} [opts]
 * @param {number} [opts.phaseTimeoutMs] - Timeout per phase
 * @param {Function} [opts.onPhase] - Callback: (phaseName, status, phaseData?) => void
 * @returns {Promise<{spec: object, phases: object, session: object}>}
 */
export async function runForgePipeline(
  description: string,
  codebaseCtx: CodebaseProfile | null = null,
  opts: ForgePipelineOpts = {},
): Promise<{ spec: ForgeSpec; phases: ForgePhases; session: ForgeSession }> {
  const cfg = loadHydraConfig();
  const forgeCfg =
    ((cfg as Record<string, unknown>)['forge'] as Record<string, unknown> | undefined) ?? {};
  const timeoutMs =
    opts.phaseTimeoutMs ?? (forgeCfg['phaseTimeoutMs'] as number | undefined) ?? 300_000;
  const onPhase = opts.onPhase ?? (() => {});
  const profile = codebaseCtx ?? analyzeCodebase();
  const phases: ForgePhases = {};
  const session: ForgeSession = {
    description,
    startedAt: new Date().toISOString(),
    phasesRun: [],
  };

  // Phase 1: ANALYZE (Gemini)
  const { analysis, phaseResult: analyzePhaseResult } = await runAnalyzePhase(
    description,
    profile,
    timeoutMs,
    onPhase,
  );
  phases.analyze = analyzePhaseResult;
  session.phasesRun.push('analyze');

  // Phase 2: DESIGN (Claude)
  const { designSpec, phaseResult: designPhaseResult } = await runDesignPhase(
    description,
    analysis,
    profile,
    timeoutMs,
    onPhase,
  );
  phases.design = designPhaseResult;
  session.phasesRun.push('design');

  // Phase 3: CRITIQUE (Gemini)
  const { critique, phaseResult: critiquePhaseResult } = await runCritiquePhase(
    designSpec,
    analysis,
    timeoutMs,
    onPhase,
  );
  phases.critique = critiquePhaseResult;
  session.phasesRun.push('critique');

  // Phase 4: REFINE (Claude)
  const { finalSpec, phaseResult: refinePhaseResult } = await runRefinePhase(
    designSpec,
    critique,
    timeoutMs,
    onPhase,
  );
  phases.refine = refinePhaseResult;
  session.phasesRun.push('refine');

  session.completedAt = new Date().toISOString();
  return { spec: finalSpec, phases, session };
}

// ── Test Phase ────────────────────────────────────────────────────────────────

/**
 * Generate a sample prompt matching the agent's top affinity type.
 */
export function generateSamplePrompt(
  spec: Partial<ForgeSpec>,
  profile?: { projectName?: string },
): string {
  const topType =
    Object.entries(spec.taskAffinity ?? {}).sort(([, a], [, b]) => b - a)[0]?.[0] ??
    'implementation';

  const projectName = profile?.projectName ?? 'the project';
  const prompts: Record<string, string> = {
    planning: `Create a plan for improving the ${projectName} test infrastructure. Break it into phases with clear milestones.`,
    architecture: `Review the architecture of ${projectName} and identify potential scalability bottlenecks.`,
    review: `Review the most recently changed files in ${projectName} for code quality, potential bugs, and best practices.`,
    refactor: `Identify the top 3 refactoring opportunities in ${projectName} and propose specific changes.`,
    implementation: `Implement a utility function for ${projectName} that validates configuration objects.`,
    analysis: `Analyze the dependency graph of ${projectName} and identify circular dependencies or unnecessary coupling.`,
    testing: `Write tests for the most critical untested functions in ${projectName}.`,
    research: `Research the codebase of ${projectName} and document how errors propagate through the system.`,
    documentation: `Generate API documentation for the main exported functions of ${projectName}.`,
    security: `Perform a security audit of ${projectName} focusing on input validation and injection vulnerabilities.`,
  };

  return prompts[topType] ?? prompts['implementation'];
}

export async function testForgedAgent(
  spec: ForgeSpec,
  samplePrompt: string | null = null,
  opts: TestForgedAgentOpts = {},
): Promise<{ ok: boolean; output: string; durationMs: number; prompt: string; error?: string }> {
  const profile = opts.profile ?? analyzeCodebase();
  const prompt = samplePrompt ?? generateSamplePrompt(spec, profile);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const fullPrompt = `${spec.rolePrompt}\n\n---\n\nTask:\n${prompt}`;

  const result = await executeAgent(spec.baseAgent, fullPrompt, {
    timeoutMs,
    useStdin: true,
    maxOutputBytes: 64 * 1024,
  } as ExecuteAgentOpts);

  return {
    ok: result.ok,
    output: result.output,
    durationMs: result.durationMs,
    prompt,
    error: result.error ?? undefined,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist a forged agent to config and registry.
 */
export function persistForgedAgent(
  spec: ForgeSpec,
  session: Partial<ForgeSession> = {},
): ForgeSpec {
  invalidateConfigCache();
  const cfg = loadHydraConfig();

  cfg.agents.custom ??= {};

  cfg.agents.custom[spec.name] = {
    baseAgent: spec.baseAgent,
    displayName: spec.displayName,
    label: `${spec.displayName} (${spec.baseAgent})`,
    strengths: spec.strengths,
    weaknesses: spec.weaknesses,
    tags: spec.tags,
    taskAffinity: spec.taskAffinity,
    rolePrompt: spec.rolePrompt,
    enabled: spec.enabled,
  };

  saveHydraConfig(cfg);

  try {
    const existing = getAgent(spec.name) as AgentEntry | null | undefined;
    if (existing) unregisterAgent(spec.name);
  } catch {
    /* ignore */
  }

  registerAgent(spec.name, { ...spec, type: AGENT_TYPE.VIRTUAL as AgentType });

  const registry = loadForgeRegistry();
  registry[spec.name] = {
    forgedAt: new Date().toISOString(),
    description: session.description ?? '',
    phasesRun: session.phasesRun ?? PHASE_NAMES,
    testResult: session.testResult ?? null,
    version: ((registry[spec.name] as ForgeRegistryEntry | undefined)?.version ?? 0) + 1,
  };
  saveForgeRegistry(registry);

  if (session.phasesRun) {
    saveForgeSession(spec.name, session as ForgeSession);
  }

  return spec;
}

export function removeForgedAgent(name: string): true {
  const lower = name.toLowerCase();

  try {
    unregisterAgent(lower);
  } catch {
    /* may not be registered */
  }

  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (cfg.agents.custom?.[lower] != null) {
    Reflect.deleteProperty(cfg.agents.custom, lower);
    saveHydraConfig(cfg);
  }

  const registry = loadForgeRegistry();
  if ((registry as Partial<Record<string, ForgeRegistryEntry>>)[lower]) {
    Reflect.deleteProperty(registry as Record<string, unknown>, lower);
    saveForgeRegistry(registry);
  }

  return true;
}

export function listForgedAgents(): Array<{
  name: string;
  displayName: string;
  baseAgent: string;
  enabled: boolean;
  forgedAt: string;
  version: number;
  description: string;
  topAffinities: string[];
}> {
  const registry = loadForgeRegistry();
  const cfg = loadHydraConfig();
  const custom = (cfg.agents.custom ?? {}) as Record<string, Partial<ForgeSpec> | undefined>;
  const results = [];

  for (const [name, meta] of Object.entries(registry)) {
    const spec = custom[name] ?? (getAgent(name) as Partial<ForgeSpec> | null);
    results.push({
      name,
      displayName: spec?.displayName ?? name,
      baseAgent: spec?.baseAgent ?? 'unknown',
      enabled: spec?.enabled !== false,
      forgedAt: meta.forgedAt,
      version: meta.version,
      description: meta.description,
      topAffinities: spec?.taskAffinity
        ? Object.entries(spec.taskAffinity)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 3)
            .map(([t, s]) => `${t}:${(s * 100).toFixed(0)}%`)
        : [],
    });
  }

  return results;
}

// ── Non-Interactive API ───────────────────────────────────────────────────────

/**
 * Non-interactive agent creation (for MCP use).
 * Runs the full pipeline with defaults and persists the result.
 */
export async function forgeAgent(
  description: string,
  opts: ForgeAgentOpts = {},
): Promise<{
  ok: boolean;
  errors?: string[];
  warnings?: string[];
  spec: ForgeSpec;
  validation?: { valid: boolean; errors: string[]; warnings: string[] };
  testResult?: {
    ok: boolean;
    output: string;
    durationMs: number;
    prompt: string;
    error?: string;
  } | null;
  phases?: Record<string, { ok: boolean; durationMs: number }>;
}> {
  const profile = analyzeCodebase();
  const { spec, phases, session } = await runForgePipeline(description, profile, opts);

  if (opts.name != null && opts.name !== '') {
    spec.name = opts.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }
  if (opts.baseAgent != null && opts.baseAgent !== '') {
    spec.baseAgent = opts.baseAgent;
  }

  const validation = validateAgentSpec(spec);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, warnings: validation.warnings, spec };
  }

  let testResult = null;
  if (opts.skipTest !== true) {
    try {
      testResult = await testForgedAgent(spec, null, { profile });
      session.testResult = { ok: testResult.ok, durationMs: testResult.durationMs };
    } catch {
      /* test failure non-fatal */
    }
  }

  persistForgedAgent(spec, session);

  return {
    ok: true,
    spec,
    validation,
    testResult,
    phases: Object.fromEntries(
      Object.entries(phases).map(([k, v]) => [
        k,
        { ok: (v as ForgePhaseResult).ok, durationMs: (v as ForgePhaseResult).durationMs },
      ]),
    ),
  };
}

// ── Interactive Wizard ────────────────────────────────────────────────────────

async function gatherIntent(rl: ReadlineInterface, description: string): Promise<string> {
  if (description !== '') return description;

  const { value } = (await promptChoice(rl, {
    title: 'Agent Forge',
    context: { Mode: 'Create a new virtual sub-agent' },
    choices: [
      { label: 'Describe your needs', value: 'describe', hint: 'tell us what you want' },
      { label: 'Auto-discover gaps', value: 'discover', hint: 'scan codebase for opportunities' },
      {
        label: 'Quick create',
        value: 'quick',
        hint: 'minimal prompts, fast result',
        freeform: true,
      },
    ],
  })) as { value: string | null };

  if (value === 'describe') {
    const { value: desc } = (await promptChoice(rl, {
      title: 'Describe Agent',
      context: { Prompt: 'What should this agent specialize in?' },
      choices: [{ label: 'Type your description', value: '', freeform: true }],
    })) as { value: string | null };
    return desc ?? '';
  }
  if (value === 'discover') return '';
  if (typeof value === 'string' && value.length > 3) return value;
  return '';
}

function makePhaseLogger(): PhaseCb {
  return (name: string, status: string, phaseData?: ForgePhaseResult) => {
    const idx = PHASE_NAMES.indexOf(name) + 1;
    if (status === 'running') {
      const agent = name === 'analyze' || name === 'critique' ? 'Gemini' : 'Claude';
      console.log(
        `  ${ACCENT('\u25B6')} Phase ${String(idx)}/4: ${pc.bold(name.toUpperCase())} ${DIM(`(${agent}...)`)}`,
      );
    } else if (status === 'done') {
      const ms = phaseData?.durationMs;
      console.log(
        `  ${SUCCESS('\u2713')} Phase ${String(idx)}/4: ${name.toUpperCase()} ${DIM(ms != null && ms !== 0 ? `(${(ms / 1000).toFixed(1)}s)` : '')}`,
      );
    }
  };
}

async function promptApproveAction(
  rl: ReadlineInterface,
  spec: ForgeSpec,
  validation: { valid: boolean; errors: string[] },
): Promise<string | null> {
  console.log('');
  const { value: action } = (await promptChoice(rl, {
    title: 'Approve Agent',
    context: {
      Agent: `${spec.name} (${spec.displayName})`,
      Validation: validation.valid ? 'passed' : `${String(validation.errors.length)} errors`,
    },
    choices: [
      { label: 'Register agent', value: 'approve', hint: 'save to config' },
      { label: 'Test first', value: 'test', hint: 'run a sample prompt' },
      { label: 'Re-forge', value: 'reforge', hint: 'run pipeline again' },
      { label: 'Cancel', value: 'cancel' },
    ],
  })) as { value: string | null };
  return action ?? null;
}

function showSpecPreview(spec: ForgeSpec, phases: ForgePhases): void {
  console.log('');
  console.log(sectionHeader('Forged Agent'));
  console.log(`  ${pc.bold('Name:')}      ${ACCENT(spec.name)}`);
  console.log(`  ${pc.bold('Display:')}   ${spec.displayName}`);
  console.log(`  ${pc.bold('Base:')}      ${spec.baseAgent}`);
  console.log(`  ${pc.bold('Strengths:')} ${spec.strengths.join(', ')}`);
  console.log(`  ${pc.bold('Tags:')}      ${spec.tags.join(', ')}`);

  const topAffinities = Object.entries(spec.taskAffinity)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  console.log(`  ${pc.bold('Top Affinities:')}`);
  for (const [type, score] of topAffinities) {
    const s = score;
    const bar = '\u2588'.repeat(Math.round(s * 20));
    console.log(`    ${type.padEnd(16)} ${DIM(bar)} ${(s * 100).toFixed(0)}%`);
  }

  const promptLines = spec.rolePrompt.split('\n').slice(0, 4);
  console.log(`  ${pc.bold('Role Prompt')} ${DIM(`(${String(spec.rolePrompt.length)} chars):`)}`);
  for (const l of promptLines) console.log(`    ${DIM(l)}`);
  if (spec.rolePrompt.split('\n').length > 4) console.log(`    ${DIM('...')}`);

  if (phases.critique?.result != null) {
    const c = phases.critique.result as CritiqueResult;
    const issueCount = c.issues.length;
    console.log('');
    console.log(
      `  ${pc.bold('Critique:')} ${c.overallAssessment} ${DIM(`(${String(issueCount)} issue${issueCount === 1 ? '' : 's'})`)}`,
    );
    if (c.issues.length > 0) {
      for (const issue of c.issues.slice(0, 3)) {
        const icon = issue.severity === 'error' ? ERROR('\u2718') : WARNING('\u26A0');
        console.log(`    ${icon} ${issue.message}`);
      }
    }
  }
}

function showValidationResults(validation: {
  valid: boolean;
  errors: string[];
  warnings: string[];
}): void {
  if (!validation.valid) {
    console.log('');
    console.log(`  ${ERROR('Validation errors:')}`);
    for (const err of validation.errors) console.log(`    ${ERROR('\u2718')} ${err}`);
  }
  if (validation.warnings.length > 0) {
    for (const w of validation.warnings) console.log(`    ${WARNING('\u26A0')} ${w}`);
  }
}

async function handleTestPhase(
  spec: ForgeSpec,
  session: ForgeSession,
  profile: CodebaseProfile,
  rl: ReadlineInterface,
): Promise<boolean> {
  console.log('');
  console.log(`  ${ACCENT('\u25B6')} Phase 5: ${pc.bold('TEST')} ${DIM(`(${spec.baseAgent}...)`)}`);
  try {
    const testResult = await testForgedAgent(spec, null, { profile });
    session.testResult = { ok: testResult.ok, durationMs: testResult.durationMs };
    console.log(
      `  ${testResult.ok ? SUCCESS('\u2713') : ERROR('\u2718')} Test ${testResult.ok ? 'passed' : 'failed'} ${DIM(`(${(testResult.durationMs / 1000).toFixed(1)}s)`)}`,
    );
    if (testResult.output !== '') {
      const preview = testResult.output.split('\n').slice(0, 5);
      for (const l of preview) console.log(`    ${DIM(l.slice(0, 100))}`);
      if (testResult.output.split('\n').length > 5) console.log(`    ${DIM('...')}`);
    }
  } catch (err) {
    console.log(`  ${ERROR('\u2718')} Test error: ${(err as Error).message}`);
  }

  console.log('');
  const { value: postTest } = (await promptChoice(rl, {
    title: 'After Test',
    choices: [
      { label: 'Register agent', value: 'approve' },
      { label: 'Cancel', value: 'cancel' },
    ],
  })) as { value: string | null };
  if (postTest === 'cancel') {
    console.log(`  ${DIM('Forge cancelled.')}`);
    return false;
  }
  return true;
}

/**
 * Interactive forge wizard for the operator console.
 *
 * @param {readline.Interface} rl - Operator readline instance
 * @param {string} [description] - Pre-filled description
 */
export async function runForgeWizard(
  rl: ReadlineInterface,
  description = '',
): Promise<ForgeSpec | null> {
  console.log('');
  console.log(sectionHeader('Agent Forge'));
  console.log(DIM('  Multi-model agent creation pipeline'));
  console.log('');

  const intent = await gatherIntent(rl, description);

  console.log('');
  console.log(
    `  ${ACCENT('\u25B6')} Phase 1/4: ${pc.bold('ANALYZE')} ${DIM('(Gemini scanning codebase...)')}`,
  );
  const profile = analyzeCodebase();

  const { spec, phases, session } = await runForgePipeline(intent, profile, {
    onPhase: makePhaseLogger(),
  });

  showSpecPreview(spec, phases);
  const validation = validateAgentSpec(spec);
  showValidationResults(validation);

  const action = await promptApproveAction(rl, spec, validation);

  if (action === 'cancel') {
    console.log(`  ${DIM('Forge cancelled.')}`);
    return null;
  }

  if (action === 'reforge') {
    return runForgeWizard(rl, intent);
  }

  if (action === 'test') {
    const shouldContinue = await handleTestPhase(spec, session, profile, rl);
    if (!shouldContinue) return null;
  }

  if (!validation.valid) {
    console.log(`  ${ERROR('Cannot register:')} spec has validation errors.`);
    return null;
  }

  persistForgedAgent(spec, session);
  console.log('');
  console.log(`  ${SUCCESS('\u2713')} Agent ${ACCENT(spec.name)} registered successfully!`);
  console.log(`  ${DIM(`View with: :agents info ${spec.name}`)}`);
  console.log('');

  return spec;
}
