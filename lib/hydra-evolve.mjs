#!/usr/bin/env node
/**
 * Hydra Evolve — Autonomous self-improvement runner.
 *
 * Runs deliberative research-implement-analyze rounds where Hydra autonomously
 * researches external systems, deliberates on findings, writes tests, implements
 * improvements, analyzes results, and accumulates knowledge.
 *
 * Each round has 7 phases:
 *   1. RESEARCH    — Agents investigate external systems (web-first)
 *   2. DELIBERATE  — Council discusses findings
 *   3. PLAN        — Create improvement spec + test plan
 *   4. TEST        — Write comprehensive tests (TDD)
 *   5. IMPLEMENT   — Make changes on isolated branch
 *   6. ANALYZE     — Multi-agent review of results
 *   7. DECIDE      — Consensus: keep/reject + document
 *
 * Usage:
 *   node lib/hydra-evolve.mjs                              # defaults
 *   node lib/hydra-evolve.mjs project=E:/Dev/SideQuest     # explicit project
 *   node lib/hydra-evolve.mjs max-rounds=1 max-hours=1     # overrides
 *   node lib/hydra-evolve.mjs focus=testing-reliability     # specific area
 */

import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  EvolveBudgetTracker,
  buildEvolveSafetyPrompt,
  scanBranchViolations,
  verifyBranch,
  isCleanWorkingTree,
} from './hydra-evolve-guardrails.mjs';
import {
  loadKnowledgeBase,
  saveKnowledgeBase,
  addEntry,
  getPriorLearnings,
  formatStatsForPrompt,
} from './hydra-evolve-knowledge.mjs';
import { resolveProject, loadHydraConfig, HYDRA_ROOT } from './hydra-config.mjs';
import { runProcess, ensureDir, parseArgs, parseJsonLoose } from './hydra-utils.mjs';
import { recordCallStart, recordCallComplete, recordCallError } from './hydra-metrics.mjs';
import pc from 'picocolors';

// ── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_HOURS = 4;
const DEFAULT_MAX_ROUNDS = 3;

const DEFAULT_FOCUS_AREAS = [
  'orchestration-patterns',
  'ai-coding-tools',
  'testing-reliability',
  'developer-experience',
  'model-routing',
  'daemon-architecture',
];

const DEFAULT_PHASE_TIMEOUTS = {
  researchTimeoutMs: 5 * 60 * 1000,
  deliberateTimeoutMs: 7 * 60 * 1000,
  planTimeoutMs: 5 * 60 * 1000,
  testTimeoutMs: 10 * 60 * 1000,
  implementTimeoutMs: 15 * 60 * 1000,
  analyzeTimeoutMs: 7 * 60 * 1000,
};

// ── Logging ─────────────────────────────────────────────────────────────────

const log = {
  info:  (msg) => process.stderr.write(`  ${pc.blue('i')} ${msg}\n`),
  ok:    (msg) => process.stderr.write(`  ${pc.green('+')} ${msg}\n`),
  warn:  (msg) => process.stderr.write(`  ${pc.yellow('!')} ${msg}\n`),
  error: (msg) => process.stderr.write(`  ${pc.red('x')} ${msg}\n`),
  phase: (msg) => process.stderr.write(`\n${pc.bold(pc.magenta('>>>'))} ${pc.bold(msg)}\n`),
  round: (msg) => process.stderr.write(`\n${pc.bold(pc.cyan('=== '))}${pc.bold(msg)}${pc.bold(pc.cyan(' ==='))}\n`),
  dim:   (msg) => process.stderr.write(`  ${pc.dim(msg)}\n`),
};

// ── Git Helpers ─────────────────────────────────────────────────────────────

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    shell: process.platform === 'win32',
  });
}

function getCurrentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return (r.stdout || '').trim();
}

function checkoutBranch(cwd, branch) {
  return git(['checkout', branch], cwd);
}

function createBranch(cwd, branchName, fromBranch) {
  const r = git(['checkout', '-b', branchName, fromBranch], cwd);
  return r.status === 0;
}

function getBranchStats(cwd, branchName, baseBranch) {
  const logResult = git(['log', `${baseBranch}..${branchName}`, '--oneline'], cwd);
  const commits = (logResult.stdout || '').trim().split('\n').filter(Boolean).length;

  const diffResult = git(['diff', '--stat', `${baseBranch}...${branchName}`], cwd);
  const statLines = (diffResult.stdout || '').trim().split('\n').filter(Boolean);
  const filesChanged = Math.max(0, statLines.length - 1);

  return { commits, filesChanged };
}

function getBranchDiff(cwd, branchName, baseBranch) {
  const r = git(['diff', `${baseBranch}...${branchName}`], cwd);
  return (r.stdout || '').trim();
}

function stageAndCommit(cwd, message) {
  git(['add', '-A'], cwd);
  const r = git(['commit', '-m', message, '--allow-empty'], cwd);
  return r.status === 0;
}

// ── Checkpoint & Hot-Restart ─────────────────────────────────────────────────

const CHECKPOINT_FILE = '.session-checkpoint.json';

function getCheckpointPath(evolveDir) {
  return path.join(evolveDir, CHECKPOINT_FILE);
}

/**
 * Load a session checkpoint from disk. Returns null if none exists.
 */
function loadCheckpoint(evolveDir) {
  const cpPath = getCheckpointPath(evolveDir);
  try {
    if (!fs.existsSync(cpPath)) return null;
    const raw = fs.readFileSync(cpPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Save a session checkpoint to disk for hot-restart.
 */
function saveCheckpoint(evolveDir, data) {
  const cpPath = getCheckpointPath(evolveDir);
  fs.writeFileSync(cpPath, JSON.stringify(data, null, 2), 'utf8');
  log.ok(`Checkpoint saved: ${cpPath}`);
}

/**
 * Delete the checkpoint file (consumed after resume).
 */
function deleteCheckpoint(evolveDir) {
  const cpPath = getCheckpointPath(evolveDir);
  try { fs.unlinkSync(cpPath); } catch { /* ok if missing */ }
}

/**
 * Check if an evolve branch modified Hydra's own lib/ code (not the target project).
 * Only returns true when the diff touches files in Hydra's own directory.
 */
function didModifyHydraCode(projectRoot, branchName, baseBranch) {
  // Only relevant when evolve is running against Hydra itself
  const normalizedHydra = path.resolve(HYDRA_ROOT).toLowerCase();
  const normalizedProject = path.resolve(projectRoot).toLowerCase();
  if (normalizedHydra !== normalizedProject) return false;

  const r = git(['diff', '--name-only', `${baseBranch}...${branchName}`], projectRoot);
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.split('\n').filter(Boolean).some(f => f.startsWith('lib/'));
}

/**
 * Spawn a new detached PowerShell process to resume the evolve session.
 */
function spawnNewProcess(projectRoot) {
  const ps1Path = path.join(HYDRA_ROOT, 'bin', 'hydra-evolve.ps1');
  const child = spawn('pwsh', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', ps1Path,
    '-Project', projectRoot,
    '-ResumeSession',
  ], {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: false,
  });
  child.unref();
  log.ok(`Spawned new evolve process (PID ${child.pid})`);
}

// ── Agent Execution ─────────────────────────────────────────────────────────

const AGENT_LABELS = { claude: '♦ Claude', gemini: '✦ Gemini', codex: '▶ Codex' };
const PROGRESS_INTERVAL_MS = 15_000; // tick every 15s

/**
 * Execute an agent CLI as a headless subprocess.
 * Returns { ok, output, durationMs, timedOut }.
 */
function executeAgent(agent, prompt, { cwd, timeoutMs, modelOverride, phaseLabel } = {}) {
  return new Promise((resolve) => {
    let cmd, args;

    if (agent === 'codex') {
      // Use stdin ('-') for prompt to avoid Windows command-line length limits
      args = ['exec', '-', '--full-auto', '-C', cwd];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'codex';
    } else if (agent === 'gemini') {
      args = ['-o', 'json'];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'gemini';
    } else {
      // claude
      args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'auto-edit'];
      if (modelOverride) args.push('--model', modelOverride);
      cmd = 'claude';
    }

    const label = AGENT_LABELS[agent] || agent;
    const context = phaseLabel ? ` [${phaseLabel}]` : '';
    log.dim(`${label}: started${context}`);

    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 128 * 1024;

    const usesStdin = agent === 'gemini' || agent === 'codex';
    const spawnOpts = {
      cwd,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: usesStdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    };

    const child = spawn(cmd, args, spawnOpts);

    // Pipe the prompt to stdin for agents that support it
    if (usesStdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (d) => {
      totalBytes += Buffer.byteLength(d);
      chunks.push(d);
      while (totalBytes > maxBytes && chunks.length > 1) {
        const dropped = chunks.shift();
        totalBytes -= Buffer.byteLength(dropped);
      }
    });

    child.stderr.on('data', () => {});

    const startTime = Date.now();
    let timedOut = false;

    // Progress ticker — prints elapsed time periodically
    const progressTimer = setInterval(() => {
      const elapsed = formatDuration(Date.now() - startTime);
      const bytes = totalBytes > 0 ? ` | ${(totalBytes / 1024).toFixed(0)}KB received` : '';
      log.dim(`${label}: working... ${elapsed}${bytes}${context}`);
    }, PROGRESS_INTERVAL_MS);

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs || DEFAULT_PHASE_TIMEOUTS.researchTimeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      resolve({
        ok: false,
        output: chunks.join(''),
        error: err.message,
        durationMs: Date.now() - startTime,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(progressTimer);
      resolve({
        ok: code === 0,
        output: chunks.join(''),
        error: code !== 0 ? `Exit code ${code}` : null,
        durationMs: Date.now() - startTime,
        timedOut,
      });
    });
  });
}

/**
 * Extract text content from an agent's JSON output.
 */
function extractOutput(rawOutput) {
  if (!rawOutput) return '';
  try {
    const parsed = JSON.parse(rawOutput);
    if (parsed.result) return parsed.result;     // Claude --output-format json
    if (parsed.response) return parsed.response;  // Gemini -o json
    if (parsed.content) return parsed.content;
    if (typeof parsed === 'string') return parsed;
  } catch { /* use raw */ }
  return rawOutput;
}

// ── Phase Implementations ───────────────────────────────────────────────────

/**
 * Phase 1: RESEARCH — Agents investigate external systems (web-first).
 */
async function phaseResearch(area, kb, { cwd, timeouts, evolveDir }) {
  log.phase(`RESEARCH — ${area}`);

  const kbContext = formatStatsForPrompt(kb);
  const priorLearnings = getPriorLearnings(kb, area);
  const priorContext = priorLearnings.length > 0
    ? `\n\nPrior learnings for "${area}":\n${priorLearnings.slice(0, 5).map(e => `- [${e.outcome || 'researched'}] ${e.finding.slice(0, 200)}`).join('\n')}`
    : '';

  const claudePrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system.

Search the web for current implementations, changelogs, documentation, GitHub repos, and blog posts related to this area. Focus on:
- Current state of relevant tools and frameworks
- Novel patterns and approaches
- Recent changes or breakthroughs
- Benchmarks and comparisons

Specific search queries to try:
${getSearchQueries(area).map(q => `- "${q}"`).join('\n')}

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  const geminiPrompt = `# Evolve Research: ${area}

You are researching "${area}" for the Hydra multi-agent orchestration system. Use Google Search grounding to find live results.

Search for implementations, GitHub repos, documentation, and recent discussions about:
${getSearchQueries(area).map(q => `- ${q}`).join('\n')}

Focus on practical patterns that could be applied to a Node.js multi-agent CLI system.

${kbContext}${priorContext}

Respond with a JSON object:
{
  "area": "${area}",
  "sources": [{"url": "...", "title": "...", "relevance": "high|medium|low"}],
  "findings": ["finding 1", "finding 2", ...],
  "applicableIdeas": ["idea 1", "idea 2", ...],
  "confidence": 0.0-1.0
}`;

  // Dispatch both agents in parallel
  log.dim('Dispatching research to Claude + Gemini in parallel...');
  const [claudeResult, geminiResult] = await Promise.all([
    executeAgent('claude', claudePrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
    executeAgent('gemini', geminiPrompt, {
      cwd,
      timeoutMs: timeouts.researchTimeoutMs,
      phaseLabel: `research: ${area}`,
    }),
  ]);

  log.dim(`Claude: ${claudeResult.ok ? 'OK' : 'FAIL'} (${formatDuration(claudeResult.durationMs)})`);
  log.dim(`Gemini: ${geminiResult.ok ? 'OK' : 'FAIL'} (${formatDuration(geminiResult.durationMs)})`);

  const claudeData = parseJsonLoose(extractOutput(claudeResult.output));
  const geminiData = parseJsonLoose(extractOutput(geminiResult.output));

  const combined = {
    area,
    claudeFindings: claudeData || { findings: [], applicableIdeas: [], sources: [] },
    geminiFindings: geminiData || { findings: [], applicableIdeas: [], sources: [] },
  };

  // Save research artifact
  const researchDir = path.join(evolveDir, 'research');
  ensureDir(researchDir);

  return combined;
}

/**
 * Phase 2: DELIBERATE — Council discusses findings.
 */
async function phaseDeliberate(research, kb, { cwd, timeouts }) {
  log.phase('DELIBERATE');

  const kbContext = formatStatsForPrompt(kb);
  const findingsBlock = JSON.stringify(research, null, 2);

  // Step 1: Claude synthesizes
  const synthesizePrompt = `# Evolve Deliberation: Synthesize Research

You are synthesizing research findings about "${research.area}" for the Hydra multi-agent orchestration system.

## Research Findings
${findingsBlock}

## Knowledge Base Context
${kbContext}

Analyze all findings and produce a synthesis:
1. What are the most important patterns/ideas found?
2. Which are actually applicable to Hydra (a Node.js multi-agent CLI orchestrator)?
3. What's the highest-impact single improvement we could make?

Respond with JSON:
{
  "synthesis": "...",
  "topPatterns": ["pattern1", "pattern2", ...],
  "applicableToHydra": ["idea1", "idea2", ...],
  "suggestedImprovement": "...",
  "rationale": "..."
}`;

  log.dim('Step 1/3: Claude synthesizing research findings...');
  const synthResult = await executeAgent('claude', synthesizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: synthesize',
  });
  const synthData = parseJsonLoose(extractOutput(synthResult.output));
  log.dim(`Synthesis: ${synthResult.ok ? 'OK' : 'FAIL'} (${formatDuration(synthResult.durationMs)})`);

  // Step 2: Gemini critiques
  const critiquePrompt = `# Evolve Deliberation: Critique

Review this synthesis of research findings about "${research.area}" for the Hydra project:

${JSON.stringify(synthData || { synthesis: 'No synthesis available' }, null, 2)}

Critically evaluate:
1. Are the conclusions well-supported by the research?
2. Is the suggested improvement actually feasible for a Node.js CLI tool?
3. What risks or downsides are being overlooked?
4. Is there a better alternative improvement?

Respond with JSON:
{
  "critique": "...",
  "concerns": ["concern1", "concern2", ...],
  "risks": ["risk1", "risk2", ...],
  "alternativeIdea": "..." or null,
  "feasibilityScore": 1-10
}`;

  log.dim('Step 2/3: Gemini critiquing synthesis...');
  const critiqueResult = await executeAgent('gemini', critiquePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: critique',
  });
  const critiqueData = parseJsonLoose(extractOutput(critiqueResult.output));
  log.dim(`Critique: ${critiqueResult.ok ? 'OK' : 'FAIL'} (${formatDuration(critiqueResult.durationMs)})`);

  // Step 3: Claude prioritizes and selects
  const prioritizePrompt = `# Evolve Deliberation: Final Selection

Based on the synthesis and critique, select the single best improvement to attempt.

## Synthesis
${JSON.stringify(synthData || {}, null, 2)}

## Critique
${JSON.stringify(critiqueData || {}, null, 2)}

Consider the critique's concerns and risks. Select the improvement that:
- Has the highest positive impact
- Is most feasible to implement
- Has acceptable risk level

Respond with JSON:
{
  "selectedImprovement": "...",
  "rationale": "...",
  "expectedImpact": "high|medium|low",
  "risks": ["risk1", ...],
  "constraints": ["constraint1", ...]
}`;

  log.dim('Step 3/3: Claude selecting best improvement...');
  const priorityResult = await executeAgent('claude', prioritizePrompt, {
    cwd,
    timeoutMs: timeouts.deliberateTimeoutMs,
    phaseLabel: 'deliberate: prioritize',
  });
  const priorityData = parseJsonLoose(extractOutput(priorityResult.output));
  log.dim(`Priority: ${priorityResult.ok ? 'OK' : 'FAIL'} (${formatDuration(priorityResult.durationMs)})`);

  return {
    synthesis: synthData,
    critique: critiqueData,
    priority: priorityData,
    selectedImprovement: priorityData?.selectedImprovement || synthData?.suggestedImprovement || 'No improvement selected',
  };
}

/**
 * Phase 3: PLAN — Create improvement spec + test plan.
 */
async function phasePlan(deliberation, area, kb, { cwd, timeouts, evolveDir, roundNum }) {
  log.phase('PLAN');

  const priorLearnings = getPriorLearnings(kb, area);
  const learningsBlock = priorLearnings.length > 0
    ? `\n## Prior Learnings for "${area}" (avoid repeating these mistakes)\n${priorLearnings.slice(0, 5).map(e => `- [${e.outcome}] ${e.learnings || e.finding}`).join('\n')}`
    : '';

  const planPrompt = `# Evolve Plan: Improvement Specification

Create a detailed implementation plan for the following improvement to the Hydra project:

## Selected Improvement
${deliberation.selectedImprovement}

## Rationale
${deliberation.priority?.rationale || deliberation.synthesis?.rationale || 'N/A'}

## Risks & Constraints
${JSON.stringify(deliberation.priority?.risks || [], null, 2)}
${JSON.stringify(deliberation.priority?.constraints || [], null, 2)}
${learningsBlock}

## Hydra Project Context
- Node.js multi-agent orchestration system (Claude/Gemini/Codex)
- Main modules: hydra-operator.mjs, hydra-utils.mjs, hydra-agents.mjs, hydra-ui.mjs, hydra-metrics.mjs, hydra-statusbar.mjs
- Uses picocolors for terminal colors, no external deps besides that
- Tests use Node.js built-in test runner (node --test)

## Required Output
Respond with JSON:
{
  "objectives": ["obj1", "obj2", ...],
  "constraints": ["constraint1", ...],
  "acceptanceCriteria": ["criterion1", ...],
  "filesToModify": [{"path": "lib/file.mjs", "changes": "description"}],
  "testPlan": {
    "scenarios": ["scenario1", ...],
    "edgeCases": ["edge1", ...],
    "variables": ["var1", ...],
    "expectedBehaviors": ["behavior1", ...]
  },
  "rollbackCriteria": ["criterion1", ...]
}`;

  const planResult = await executeAgent('claude', planPrompt, {
    cwd,
    timeoutMs: timeouts.planTimeoutMs,
    phaseLabel: 'plan: spec',
  });
  const planData = parseJsonLoose(extractOutput(planResult.output));
  log.dim(`Plan: ${planResult.ok ? 'OK' : 'FAIL'} (${formatDuration(planResult.durationMs)})`);

  // Save spec artifact
  const specsDir = path.join(evolveDir, 'specs');
  ensureDir(specsDir);
  const specPath = path.join(specsDir, `ROUND_${roundNum}_SPEC.md`);

  const specContent = `# Evolve Round ${roundNum} Spec — ${area}
## Improvement
${deliberation.selectedImprovement}

## Objectives
${(planData?.objectives || []).map(o => `- ${o}`).join('\n')}

## Constraints
${(planData?.constraints || []).map(c => `- ${c}`).join('\n')}

## Acceptance Criteria
${(planData?.acceptanceCriteria || []).map(a => `- ${a}`).join('\n')}

## Files to Modify
${(planData?.filesToModify || []).map(f => `- \`${f.path}\`: ${f.changes}`).join('\n')}

## Test Plan
### Scenarios
${(planData?.testPlan?.scenarios || []).map(s => `- ${s}`).join('\n')}

### Edge Cases
${(planData?.testPlan?.edgeCases || []).map(e => `- ${e}`).join('\n')}

## Rollback Criteria
${(planData?.rollbackCriteria || []).map(r => `- ${r}`).join('\n')}
`;

  fs.writeFileSync(specPath, specContent, 'utf8');
  log.ok(`Spec saved: ${specPath}`);

  return { plan: planData, specPath };
}

/**
 * Phase 4: TEST — Write comprehensive tests (TDD).
 */
async function phaseTest(plan, branchName, safetyPrompt, { cwd, timeouts }) {
  log.phase('TEST');

  const testPrompt = `# Evolve: Write Tests (TDD)

Write comprehensive tests for the following improvement plan. Tests MUST be written BEFORE the implementation.

## Plan
${JSON.stringify(plan.plan || {}, null, 2)}

## Requirements
- Use Node.js built-in test runner: \`import { test, describe } from 'node:test'\`
- Use \`import assert from 'node:assert/strict'\`
- Cover: happy path, edge cases, error states, boundary conditions
- Tests should be in a new file under \`test/\` directory
- Make tests specific and descriptive
- Tests should verify behavior, not implementation details

## Important
- Write tests that CAN fail (they test functionality that doesn't exist yet)
- Include at least one test per scenario and edge case from the plan
- Commit the test file(s) when done

${safetyPrompt}`;

  const testResult = await executeAgent('codex', testPrompt, {
    cwd,
    timeoutMs: timeouts.testTimeoutMs,
    phaseLabel: 'test: write TDD tests',
  });

  log.dim(`Tests: ${testResult.ok ? 'OK' : 'FAIL'} (${formatDuration(testResult.durationMs)})`);
  return { ok: testResult.ok, output: testResult.output, durationMs: testResult.durationMs };
}

/**
 * Phase 5: IMPLEMENT — Make changes on isolated branch.
 */
async function phaseImplement(plan, branchName, safetyPrompt, { cwd, timeouts }) {
  log.phase('IMPLEMENT');

  const implPrompt = `# Evolve: Implement Improvement

Implement the improvement described in the spec below. Tests already exist on this branch — make them pass.

## Plan
${JSON.stringify(plan.plan || {}, null, 2)}

## Requirements
- Read existing code before making changes
- Make focused, minimal changes
- Run \`node --test\` to verify tests pass
- Commit your changes with a descriptive message
- Do NOT modify test files — only implementation files

${safetyPrompt}`;

  const implResult = await executeAgent('codex', implPrompt, {
    cwd,
    timeoutMs: timeouts.implementTimeoutMs,
    phaseLabel: 'implement: make tests pass',
  });

  log.dim(`Implement: ${implResult.ok ? 'OK' : 'FAIL'} (${formatDuration(implResult.durationMs)})`);
  return { ok: implResult.ok, output: implResult.output, durationMs: implResult.durationMs };
}

/**
 * Phase 6: ANALYZE — Multi-agent review of results.
 */
async function phaseAnalyze(diff, branchName, plan, { cwd, timeouts }) {
  log.phase('ANALYZE');

  const diffBlock = diff.length > 8000 ? diff.slice(0, 8000) + '\n...(truncated)' : diff;

  const reviewPrompt = (agent, focus) => `# Evolve Analysis: ${focus}

Review the implementation diff below for a Hydra improvement.

## Improvement Goal
${plan.plan?.objectives?.[0] || 'See plan for details'}

## Diff
\`\`\`
${diffBlock}
\`\`\`

## Your Focus: ${focus}
Score the implementation on:
- quality (1-10): Code quality, style consistency, correctness
- confidence (1-10): How confident are you in this assessment

Respond with JSON:
{
  "quality": 1-10,
  "confidence": 1-10,
  "concerns": ["concern1", ...],
  "suggestions": ["suggestion1", ...],
  "verdict": "approve" | "reject" | "revise"
}`;

  log.dim('Dispatching analysis to Claude + Gemini in parallel...');
  const [claudeResult, geminiResult] = await Promise.all([
    executeAgent('claude', reviewPrompt('claude', 'Architectural quality, code style, spec alignment'), {
      cwd,
      timeoutMs: timeouts.analyzeTimeoutMs,
      phaseLabel: 'analyze: architecture review',
    }),
    executeAgent('gemini', reviewPrompt('gemini', 'Regression risk, pattern consistency, codebase fit'), {
      cwd,
      timeoutMs: timeouts.analyzeTimeoutMs,
      phaseLabel: 'analyze: regression review',
    }),
  ]);

  const claudeAnalysis = parseJsonLoose(extractOutput(claudeResult.output));
  const geminiAnalysis = parseJsonLoose(extractOutput(geminiResult.output));

  log.dim(`Claude analysis: ${claudeResult.ok ? 'OK' : 'FAIL'}`);
  log.dim(`Gemini analysis: ${geminiResult.ok ? 'OK' : 'FAIL'}`);

  // Also run tests
  log.dim('Running test suite...');
  const testRun = runProcess('node', ['--test'], 60_000, { cwd });
  const testsPassed = testRun.ok;
  log.dim(`Tests: ${testsPassed ? 'PASS' : 'FAIL'}`);

  // Aggregate scores
  const scores = [claudeAnalysis, geminiAnalysis].filter(Boolean);
  const avgQuality = scores.length > 0
    ? scores.reduce((s, a) => s + (a.quality || 0), 0) / scores.length
    : 0;
  const avgConfidence = scores.length > 0
    ? scores.reduce((s, a) => s + (a.confidence || 0), 0) / scores.length
    : 0;
  const allConcerns = scores.flatMap(s => s.concerns || []);

  return {
    agentScores: { claude: claudeAnalysis, gemini: geminiAnalysis },
    aggregateScore: Math.round(avgQuality * 10) / 10,
    aggregateConfidence: Math.round(avgConfidence * 10) / 10,
    concerns: allConcerns,
    testsPassed,
    testOutput: (testRun.stdout || '').slice(-2000),
  };
}

/**
 * Phase 7: DECIDE — Consensus verdict.
 */
function phaseDecide(analysis, config) {
  log.phase('DECIDE');

  const { aggregateScore, testsPassed, concerns } = analysis;
  const minScore = config.approval?.minScore || 7;
  const requireAllTests = config.approval?.requireAllTestsPass !== false;

  let verdict;
  let reason;

  const hasCriticalConcerns = concerns.some(c =>
    /critical|breaking|security|data.?loss/i.test(c)
  );

  if (hasCriticalConcerns) {
    verdict = 'reject';
    reason = `Critical concerns identified: ${concerns.filter(c => /critical|breaking|security|data.?loss/i.test(c)).join('; ')}`;
  } else if (requireAllTests && !testsPassed) {
    verdict = 'reject';
    reason = 'Tests did not pass';
  } else if (aggregateScore >= minScore) {
    verdict = 'approve';
    reason = `Score ${aggregateScore}/10 meets minimum ${minScore}/10, tests ${testsPassed ? 'passed' : 'N/A'}`;
  } else if (aggregateScore >= minScore - 2) {
    verdict = 'revise';
    reason = `Score ${aggregateScore}/10 is close but below minimum ${minScore}/10`;
  } else {
    verdict = 'reject';
    reason = `Score ${aggregateScore}/10 is below minimum ${minScore}/10`;
  }

  log.info(`Verdict: ${verdict.toUpperCase()} — ${reason}`);
  return { verdict, reason, score: aggregateScore };
}

// ── Search Query Generation ─────────────────────────────────────────────────

function getSearchQueries(area) {
  const queries = {
    'orchestration-patterns': [
      'CrewAI task delegation approach 2026',
      'AutoGen multi-agent conversation patterns',
      'LangGraph agent orchestration',
      'MetaGPT multi-agent programming',
      'multi-agent orchestration framework comparison',
    ],
    'ai-coding-tools': [
      'Cursor AI coding assistant architecture',
      'Aider AI pair programming patterns',
      'Cline VS Code AI assistant',
      'AI coding tool CLI design patterns',
      'Windsurf AI coding features',
    ],
    'testing-reliability': [
      'testing AI agent systems reliability',
      'property-based testing AI outputs',
      'flaky test mitigation strategies',
      'AI system testing best practices 2026',
      'deterministic testing for LLM applications',
    ],
    'developer-experience': [
      'CLI developer experience best practices',
      'terminal UI patterns Node.js',
      'REPL design patterns developer tools',
      'progressive disclosure CLI design',
      'AI tool developer onboarding UX',
    ],
    'model-routing': [
      'mixture of agents model routing',
      'LLM routing strategies cost optimization',
      'multi-model selection algorithms',
      'AI model cascade patterns',
      'prompt routing classifier design',
    ],
    'daemon-architecture': [
      'task queue daemon architecture Node.js',
      'Temporal workflow engine patterns',
      'BullMQ job processing patterns',
      'event-driven daemon design patterns',
      'long-running process management Node.js',
    ],
  };
  return queries[area] || [
    `${area} best practices 2026`,
    `${area} implementation patterns`,
    `${area} tools and frameworks`,
  ];
}

// ── Report Generation ───────────────────────────────────────────────────────

function compactTokenBar(tokens, budget, width = 16) {
  const ratio = Math.min(tokens / (budget || 1), 1);
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  const pct = (ratio * 100).toFixed(0);
  return pc.dim(`[${bar}] ${pct.padStart(3)}%`);
}

function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hrs}h ${remMins}m`;
}

function generateSessionReport(roundResults, budgetSummary, runMeta, kbDelta) {
  const { startedAt, finishedAt, dateStr, maxRounds } = runMeta;
  const durationStr = formatDuration(finishedAt - startedAt);
  const tokensStr = `~${budgetSummary.consumed.toLocaleString()}`;

  const lines = [
    `# Evolve Session — ${dateStr}`,
    `Rounds: ${roundResults.length}/${maxRounds} | Duration: ${durationStr} | Tokens: ${tokensStr}`,
    '',
  ];

  for (const r of roundResults) {
    const resultTag = r.verdict ? r.verdict.toUpperCase() : 'INCOMPLETE';
    lines.push(`## Round ${r.round}: ${r.area}`);
    lines.push(`- Research: ${r.researchSummary || 'N/A'}`);
    lines.push(`- Selected: ${r.selectedImprovement || 'N/A'}`);
    if (r.testsWritten !== undefined) {
      lines.push(`- Tests: ${r.testsWritten}`);
    }
    lines.push(`- Result: ${resultTag}${r.score ? ` (score: ${r.score}/10)` : ''}`);
    if (r.branchName) {
      lines.push(`- Branch: ${r.branchName}`);
    }
    if (r.learnings) {
      lines.push(`- Learnings: ${r.learnings}`);
    }
    lines.push('');
  }

  lines.push('## Knowledge Base Growth');
  lines.push(`- New entries: ${kbDelta.added}`);
  lines.push(`- Cumulative: ${kbDelta.total} entries`);
  lines.push('');

  lines.push('## Budget Summary');
  lines.push(`- Start tokens: ${budgetSummary.startTokens.toLocaleString()}`);
  lines.push(`- End tokens: ${budgetSummary.endTokens.toLocaleString()}`);
  lines.push(`- Consumed: ${budgetSummary.consumed.toLocaleString()}`);
  lines.push(`- Budget limit: ${budgetSummary.hardLimit.toLocaleString()}`);
  lines.push(`- Avg per round: ${budgetSummary.avgPerRound.toLocaleString()}`);
  if (budgetSummary.roundDeltas.length > 0) {
    lines.push('');
    lines.push('| Round | Area | Tokens | Duration |');
    lines.push('|-------|------|--------|----------|');
    for (const d of budgetSummary.roundDeltas) {
      lines.push(`| ${d.round} | ${d.area} | ${d.tokens.toLocaleString()} | ${formatDuration(d.durationMs)} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

function generateSessionJSON(roundResults, budgetSummary, runMeta, kbDelta) {
  return {
    ...runMeta,
    budget: budgetSummary,
    knowledgeBaseDelta: kbDelta,
    rounds: roundResults.map(r => ({
      round: r.round,
      area: r.area,
      selectedImprovement: r.selectedImprovement,
      verdict: r.verdict,
      score: r.score,
      branchName: r.branchName,
      learnings: r.learnings,
      durationMs: r.durationMs,
    })),
  };
}

// ── Main Runner ─────────────────────────────────────────────────────────────

async function main() {
  const { options } = parseArgs(process.argv);
  const isResume = options.resume === '1' || options.resume === 'true';

  // ── Resolve project ───────────────────────────────────────────────────
  let projectConfig;
  try {
    projectConfig = resolveProject({ project: options.project });
  } catch (err) {
    log.error(`Project resolution failed: ${err.message}`);
    process.exit(1);
  }

  const { projectRoot, coordDir } = projectConfig;
  log.info(`Project: ${projectRoot}`);

  // ── Load evolve config ────────────────────────────────────────────────
  const hydraConfig = loadHydraConfig();
  const evolveConfig = hydraConfig.evolve || {};
  const baseBranch = evolveConfig.baseBranch || 'dev';

  // ── Validate preconditions ────────────────────────────────────────────
  const currentBranch = getCurrentBranch(projectRoot);
  if (currentBranch !== baseBranch) {
    log.error(`Must be on '${baseBranch}' branch (currently on '${currentBranch}')`);
    process.exit(1);
  }

  if (!isCleanWorkingTree(projectRoot)) {
    log.error('Working tree is not clean. Commit or stash changes first.');
    process.exit(1);
  }

  log.ok(`Preconditions met: on ${baseBranch}, clean working tree`);

  // ── Initialize evolve directory ───────────────────────────────────────
  const evolveDir = path.join(coordDir, 'evolve');
  ensureDir(evolveDir);
  ensureDir(path.join(evolveDir, 'research'));
  ensureDir(path.join(evolveDir, 'specs'));
  ensureDir(path.join(evolveDir, 'decisions'));

  // ── Check for session checkpoint (resume) ─────────────────────────────
  const checkpoint = loadCheckpoint(evolveDir);
  let startedAt, dateStr, maxRounds, maxHoursMs, focusAreas, timeouts;
  let roundResults, kbStartCount, budget, startRound;

  const kb = loadKnowledgeBase(evolveDir);

  if (checkpoint && isResume) {
    // ── Resume from checkpoint ──────────────────────────────────────────
    log.info(pc.yellow('Resuming evolve session from checkpoint...'));
    log.dim(`Reason: ${checkpoint.reason || 'hot-restart'}`);

    startedAt = checkpoint.startedAt;
    dateStr = checkpoint.dateStr;
    maxRounds = checkpoint.maxRounds;
    maxHoursMs = checkpoint.maxHoursMs;
    focusAreas = checkpoint.focusAreas;
    timeouts = checkpoint.timeouts;
    roundResults = checkpoint.completedRounds || [];
    kbStartCount = checkpoint.kbStartCount;
    startRound = (checkpoint.lastRoundNum || 0) + 1;

    // Restore budget tracker
    if (checkpoint.budgetState) {
      budget = EvolveBudgetTracker.deserialize(checkpoint.budgetState);
      log.dim(`Budget restored: ${budget.consumed.toLocaleString()} tokens consumed across ${budget.roundDeltas.length} rounds`);
    } else {
      budget = new EvolveBudgetTracker(checkpoint.budgetOverrides || {});
      budget.recordStart();
    }

    // Consume (delete) the checkpoint
    deleteCheckpoint(evolveDir);
    log.ok(`Checkpoint consumed, resuming from round ${startRound}`);
  } else {
    // ── Fresh session ───────────────────────────────────────────────────
    if (checkpoint && !isResume) {
      log.warn('Stale checkpoint found but --resume not set. Starting fresh session.');
      deleteCheckpoint(evolveDir);
    }

    startedAt = Date.now();
    dateStr = new Date().toISOString().split('T')[0];
    startRound = 1;
    roundResults = [];
    kbStartCount = kb.entries.length;

    // Parse options
    maxRounds = options['max-rounds']
      ? parseInt(options['max-rounds'], 10)
      : evolveConfig.maxRounds || DEFAULT_MAX_ROUNDS;
    maxHoursMs = (options['max-hours']
      ? parseFloat(options['max-hours'])
      : evolveConfig.maxHours || DEFAULT_MAX_HOURS) * 60 * 60 * 1000;
    focusAreas = options.focus
      ? [options.focus]
      : evolveConfig.focusAreas || DEFAULT_FOCUS_AREAS;
    timeouts = { ...DEFAULT_PHASE_TIMEOUTS, ...(evolveConfig.phases || {}) };

    const budgetOverrides = {};
    if (options['hard-limit']) budgetOverrides.hardLimit = parseInt(options['hard-limit'], 10);
    if (options['soft-limit']) budgetOverrides.softLimit = parseInt(options['soft-limit'], 10);

    budget = new EvolveBudgetTracker(budgetOverrides);
    budget.recordStart();
  }

  log.info(`Budget: ${budget.hardLimit.toLocaleString()} token hard limit`);
  log.info(`Rounds: max ${maxRounds} | Time: max ${formatDuration(maxHoursMs)}`);

  // ── Round loop ────────────────────────────────────────────────────────
  let stopReason = null;
  let reducedScope = false;

  for (let round = startRound; round <= maxRounds; round++) {
    const roundStart = Date.now();

    // Time limit check
    if (Date.now() - startedAt > maxHoursMs) {
      stopReason = 'time limit';
      log.warn(`Time limit reached (${formatDuration(maxHoursMs)}). Stopping.`);
      break;
    }

    // Budget gate check
    const budgetCheck = budget.check();

    if (budgetCheck.action === 'hard_stop') {
      stopReason = 'hard budget limit';
      log.error(`HARD STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'soft_stop') {
      stopReason = 'soft budget limit';
      log.warn(`SOFT STOP: ${budgetCheck.reason}`);
      break;
    }

    if (budgetCheck.action === 'reduce_scope') {
      reducedScope = true;
      log.warn(budgetCheck.reason);
    }

    if (budgetCheck.action === 'warn') {
      log.warn(budgetCheck.reason);
    }

    if (!budgetCheck.canFitNextRound && round > 1) {
      stopReason = 'predicted budget exceeded';
      log.warn(`Predicted next round (~${budgetCheck.avgPerRound.toLocaleString()} tokens) would exceed remaining budget. Stopping.`);
      break;
    }

    // Select focus area (rotate, skip recently covered)
    const recentAreas = roundResults.map(r => r.area);
    const areaIndex = (round - 1) % focusAreas.length;
    let area = focusAreas[areaIndex];
    // If we only have one focus area specified, use it; otherwise try to avoid repeats
    if (focusAreas.length > 1 && recentAreas.includes(area)) {
      area = focusAreas.find(a => !recentAreas.includes(a)) || area;
    }

    log.round(`ROUND ${round}/${maxRounds}: ${area}`);

    const roundResult = {
      round,
      area,
      selectedImprovement: null,
      verdict: null,
      score: null,
      branchName: null,
      learnings: null,
      durationMs: 0,
      researchSummary: null,
    };

    try {
      // ── Phase 1: RESEARCH ──────────────────────────────────────────────
      const research = await phaseResearch(area, kb, { cwd: projectRoot, timeouts, evolveDir });

      // Save research artifact
      const researchPath = path.join(evolveDir, 'research', `ROUND_${round}_RESEARCH.json`);
      fs.writeFileSync(researchPath, JSON.stringify(research, null, 2), 'utf8');
      log.ok(`Research saved: ${path.basename(researchPath)}`);

      // Summarize research for report
      const allFindings = [
        ...(research.claudeFindings?.findings || []),
        ...(research.geminiFindings?.findings || []),
      ];
      roundResult.researchSummary = allFindings.slice(0, 3).join('; ').slice(0, 200) || 'No findings';

      // Add research findings to KB
      for (const finding of allFindings.slice(0, 5)) {
        addEntry(kb, {
          round,
          date: dateStr,
          area,
          finding,
          applicability: 'medium',
          attempted: false,
          tags: [area],
        });
      }

      // ── Phase 2: DELIBERATE ────────────────────────────────────────────
      const deliberation = await phaseDeliberate(research, kb, { cwd: projectRoot, timeouts });
      roundResult.selectedImprovement = deliberation.selectedImprovement;
      log.ok(`Selected: ${deliberation.selectedImprovement.slice(0, 100)}`);

      // If reduced scope, skip implementation phases
      if (reducedScope) {
        log.warn('Reduced scope mode — skipping TEST, IMPLEMENT, ANALYZE phases');
        roundResult.verdict = 'skipped';
        roundResult.learnings = 'Budget-reduced: research and deliberation only';

        addEntry(kb, {
          round,
          date: dateStr,
          area,
          finding: deliberation.selectedImprovement,
          applicability: deliberation.priority?.expectedImpact || 'medium',
          attempted: false,
          outcome: null,
          learnings: 'Deferred due to budget constraints',
          tags: [area, 'deferred'],
        });

        roundResults.push(roundResult);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }

      // ── Phase 3: PLAN ──────────────────────────────────────────────────
      const plan = await phasePlan(deliberation, area, kb, {
        cwd: projectRoot,
        timeouts,
        evolveDir,
        roundNum: round,
      });

      // ── Create branch ──────────────────────────────────────────────────
      const branchName = `evolve/${dateStr}/${round}`;
      roundResult.branchName = branchName;

      if (!createBranch(projectRoot, branchName, baseBranch)) {
        log.error(`Failed to create branch: ${branchName}`);
        roundResult.verdict = 'error';
        roundResult.learnings = 'Branch creation failed';
        roundResults.push(roundResult);
        checkoutBranch(projectRoot, baseBranch);
        budget.recordRoundEnd(round, area, Date.now() - roundStart);
        continue;
      }
      log.ok(`Branch: ${branchName}`);

      const safetyPrompt = buildEvolveSafetyPrompt(branchName);

      // ── Phase 4: TEST ──────────────────────────────────────────────────
      const testResult = await phaseTest(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
      });

      // ── Phase 5: IMPLEMENT ─────────────────────────────────────────────
      const implResult = await phaseImplement(plan, branchName, safetyPrompt, {
        cwd: projectRoot,
        timeouts,
      });

      // Verify we're still on the right branch
      const branchCheck = verifyBranch(projectRoot, branchName);
      if (!branchCheck.ok) {
        log.error(`Branch escape! Expected '${branchName}', on '${branchCheck.currentBranch}'`);
        git(['checkout', branchName], projectRoot);
      }

      // ── Phase 6: ANALYZE ───────────────────────────────────────────────
      const diff = getBranchDiff(projectRoot, branchName, baseBranch);
      const analysis = await phaseAnalyze(diff, branchName, plan, {
        cwd: projectRoot,
        timeouts,
      });

      roundResult.score = analysis.aggregateScore;

      // ── Phase 7: DECIDE ────────────────────────────────────────────────
      // Check for violations
      const violations = scanBranchViolations(projectRoot, branchName, baseBranch);
      if (violations.length > 0) {
        log.warn(`${violations.length} violation(s) detected`);
        for (const v of violations) {
          log.dim(`  [${v.severity}] ${v.detail}`);
        }
        // Critical violations force reject
        if (violations.some(v => v.severity === 'critical')) {
          analysis.concerns.push('Critical guardrail violations detected');
        }
      }

      const decision = phaseDecide(analysis, evolveConfig);
      roundResult.verdict = decision.verdict;
      roundResult.learnings = decision.reason;

      // Save decision artifact
      const decisionPath = path.join(evolveDir, 'decisions', `ROUND_${round}_DECISION.json`);
      fs.writeFileSync(decisionPath, JSON.stringify({
        round,
        area,
        improvement: deliberation.selectedImprovement,
        verdict: decision.verdict,
        reason: decision.reason,
        score: analysis.aggregateScore,
        confidence: analysis.aggregateConfidence,
        testsPassed: analysis.testsPassed,
        violations: violations.length,
        concerns: analysis.concerns,
        branchName,
      }, null, 2), 'utf8');

      // Update knowledge base with decision
      addEntry(kb, {
        round,
        date: dateStr,
        area,
        finding: deliberation.selectedImprovement,
        applicability: deliberation.priority?.expectedImpact || 'medium',
        attempted: true,
        outcome: decision.verdict,
        score: analysis.aggregateScore,
        learnings: decision.reason,
        tags: [area, decision.verdict],
      });

      const stats = getBranchStats(projectRoot, branchName, baseBranch);
      log.ok(`Round ${round} complete: ${decision.verdict.toUpperCase()} | ${stats.commits} commits | ${stats.filesChanged} files`);

      // ── Hot-restart: self-modification detected ───────────────────────
      if (decision.verdict === 'approve' && didModifyHydraCode(projectRoot, branchName, baseBranch)) {
        log.info(pc.yellow('Self-modification detected — initiating hot-restart'));

        // 1. Merge approved branch to base
        checkoutBranch(projectRoot, baseBranch);
        const mergeResult = git(['merge', branchName, '--no-edit'], projectRoot);
        if (mergeResult.status !== 0) {
          log.error(`Merge failed: ${(mergeResult.stderr || '').trim()}`);
          // Continue without hot-restart — branch stays for manual merge
        } else {
          log.ok(`Merged ${branchName} → ${baseBranch}`);

          // Record this round before saving checkpoint
          roundResult.durationMs = Date.now() - roundStart;
          roundResults.push(roundResult);
          budget.recordRoundEnd(round, area, roundResult.durationMs);

          // 2. Save knowledge base (so new process has latest data)
          saveKnowledgeBase(evolveDir, kb);

          // 3. Save session checkpoint
          saveCheckpoint(evolveDir, {
            sessionId: `${dateStr}_${Math.random().toString(36).slice(2, 5)}`,
            startedAt,
            dateStr,
            projectRoot,
            baseBranch,
            maxRounds,
            maxHoursMs,
            focusAreas,
            timeouts,
            budgetOverrides: {},
            budgetState: budget.serialize(),
            completedRounds: roundResults,
            lastRoundNum: round,
            kbStartCount,
            reason: 'hot-restart after approved self-modification',
          });

          // 4. Spawn new process and exit
          spawnNewProcess(projectRoot);
          log.info('Exiting for hot-restart...');
          process.exit(0);
        }
      }

    } catch (err) {
      log.error(`Round ${round} error: ${err.message}`);
      roundResult.verdict = 'error';
      roundResult.learnings = err.message;
    }

    // Return to base branch
    const currentAfterRound = getCurrentBranch(projectRoot);
    if (currentAfterRound !== baseBranch) {
      checkoutBranch(projectRoot, baseBranch);
    }

    roundResult.durationMs = Date.now() - roundStart;
    roundResults.push(roundResult);
    budget.recordRoundEnd(round, area, roundResult.durationMs);
  }

  // ── Always return to base branch ──────────────────────────────────────
  const finalBranch = getCurrentBranch(projectRoot);
  if (finalBranch !== baseBranch) {
    checkoutBranch(projectRoot, baseBranch);
  }

  // ── Save knowledge base ───────────────────────────────────────────────
  saveKnowledgeBase(evolveDir, kb);
  log.ok('Knowledge base saved');

  // ── Generate reports ──────────────────────────────────────────────────
  const finishedAt = Date.now();
  const budgetSummary = budget.getSummary();
  const kbDelta = { added: kb.entries.length - kbStartCount, total: kb.entries.length };
  const runMeta = {
    startedAt,
    finishedAt,
    dateStr,
    maxRounds,
    processedRounds: roundResults.length,
    stopReason,
  };

  const mdReport = generateSessionReport(roundResults, budgetSummary, runMeta, kbDelta);
  const jsonReport = generateSessionJSON(roundResults, budgetSummary, runMeta, kbDelta);

  const mdPath = path.join(evolveDir, `EVOLVE_${dateStr}.md`);
  const jsonPath = path.join(evolveDir, `EVOLVE_${dateStr}.json`);

  fs.writeFileSync(mdPath, mdReport, 'utf8');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2), 'utf8');

  log.ok(`Report saved: ${mdPath}`);
  log.ok(`JSON saved:   ${jsonPath}`);

  // ── Summary ───────────────────────────────────────────────────────────
  const approved = roundResults.filter(r => r.verdict === 'approve').length;
  const rejected = roundResults.filter(r => r.verdict === 'reject').length;
  const revised = roundResults.filter(r => r.verdict === 'revise').length;
  const errors = roundResults.filter(r => r.verdict === 'error').length;
  const skipped = roundResults.filter(r => r.verdict === 'skipped').length;
  const totalTokens = budgetSummary.consumed;

  const W = 64; // box width
  const hr = pc.dim('─'.repeat(W));
  const dhr = pc.cyan('═'.repeat(W));

  console.log('');
  console.log(dhr);
  console.log(pc.bold(pc.cyan('  EVOLVE SESSION COMPLETE')));
  console.log(dhr);
  console.log('');

  // ── Per-round detail ──────────────────────────────────────────────
  for (const r of roundResults) {
    const verdictColor = r.verdict === 'approve' ? pc.green
      : r.verdict === 'reject' ? pc.red
      : r.verdict === 'revise' ? pc.yellow
      : r.verdict === 'error' ? pc.red
      : pc.dim;
    const tag = verdictColor(pc.bold((r.verdict || 'incomplete').toUpperCase()));
    const scoreStr = r.score != null ? pc.dim(` score:${r.score}/10`) : '';
    const dur = r.durationMs ? pc.dim(` ${formatDuration(r.durationMs)}`) : '';

    console.log(`  ${pc.bold(pc.cyan(`Round ${r.round}`))} ${pc.dim('·')} ${r.area}`);
    console.log(`    ${tag}${scoreStr}${dur}`);
    if (r.selectedImprovement && r.selectedImprovement !== 'No improvement selected') {
      console.log(`    ${pc.dim('Goal:')} ${r.selectedImprovement.slice(0, 80)}`);
    }
    if (r.branchName) {
      console.log(`    ${pc.dim('Branch:')} ${r.branchName}`);
    }
    if (r.learnings) {
      console.log(`    ${pc.dim('Note:')} ${r.learnings.slice(0, 80)}`);
    }
    console.log('');
  }

  console.log(hr);

  // ── Aggregate stats ───────────────────────────────────────────────
  const verdictLine = [
    approved > 0 ? pc.green(`${approved} approved`) : null,
    revised > 0 ? pc.yellow(`${revised} revised`) : null,
    rejected > 0 ? pc.red(`${rejected} rejected`) : null,
    errors > 0 ? pc.red(`${errors} error`) : null,
    skipped > 0 ? pc.dim(`${skipped} skipped`) : null,
  ].filter(Boolean).join(pc.dim(' / '));

  console.log(`  ${pc.bold('Rounds')}      ${roundResults.length}/${maxRounds}  ${verdictLine}`);
  console.log(`  ${pc.bold('Duration')}    ${formatDuration(finishedAt - startedAt)}`);
  console.log(`  ${pc.bold('Tokens')}      ~${totalTokens.toLocaleString()} consumed`);
  console.log(`  ${pc.bold('Knowledge')}   +${kbDelta.added} entries (${kbDelta.total} total)`);

  if (budgetSummary.roundDeltas.length > 0) {
    console.log('');
    console.log(`  ${pc.dim('Per-round tokens:')}`);
    for (const d of budgetSummary.roundDeltas) {
      const bar = compactTokenBar(d.tokens, budgetSummary.hardLimit);
      console.log(`    R${d.round} ${d.area.padEnd(24).slice(0, 24)} ${bar} ${d.tokens.toLocaleString().padStart(8)}`);
    }
  }

  if (stopReason) {
    console.log('');
    console.log(`  ${pc.yellow('Stopped:')} ${stopReason}`);
  }

  // ── Branches to review ────────────────────────────────────────────
  const branchesToReview = roundResults.filter(r => r.branchName && r.verdict === 'approve');
  if (branchesToReview.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.green('Branches ready to merge:'))}`);
    for (const r of branchesToReview) {
      console.log(`    ${pc.green('>')} git merge ${r.branchName}`);
    }
  }

  const branchesForReview = roundResults.filter(r => r.branchName && r.verdict === 'revise');
  if (branchesForReview.length > 0) {
    console.log('');
    console.log(`  ${pc.bold(pc.yellow('Branches needing revision:'))}`);
    for (const r of branchesForReview) {
      console.log(`    ${pc.yellow('~')} git diff ${baseBranch}...${r.branchName}`);
    }
  }

  console.log('');
  console.log(hr);
  console.log(`  ${pc.dim('Report:')} ${mdPath}`);
  console.log(`  ${pc.dim('Data:')}   ${jsonPath}`);
  console.log(dhr);
  console.log('');
}

// ── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  log.error(`Fatal: ${err.message}`);
  // Always try to get back to base branch
  try {
    const cfg = loadHydraConfig();
    const baseBranch = cfg.evolve?.baseBranch || 'dev';
    const projectRoot = process.cwd();
    const branch = getCurrentBranch(projectRoot);
    if (branch !== baseBranch && branch.startsWith('evolve/')) {
      checkoutBranch(projectRoot, baseBranch);
    }
  } catch { /* last resort */ }
  process.exit(1);
});
