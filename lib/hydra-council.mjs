#!/usr/bin/env node
/**
 * Hydra Council Mode
 *
 * Agent-aware multi-round deliberation:
 * Claude (propose) -> Gemini (critique) -> Claude (refine) -> Codex (implement)
 * Then optionally publishes decisions/tasks/handoffs into Hydra daemon.
 *
 * Usage:
 *   node hydra-council.mjs prompt="Investigate auth race"
 *   node hydra-council.mjs prompt="Investigate auth race" mode=preview
 */

import './hydra-env.mjs';
import fs from 'fs';
import path from 'path';
import { getProjectContext } from './hydra-context.mjs';
import { getAgent, AGENT_NAMES, setActiveModel, getMode, setMode } from './hydra-agents.mjs';
import { resolveProject, HYDRA_ROOT } from './hydra-config.mjs';
import { checkUsage } from './hydra-usage.mjs';
import {
  nowIso,
  runId,
  parseArgs,
  getPrompt,
  boolFlag,
  short,
  parseJsonLoose,
  request,
  ensureDir,
  sanitizeOwner,
  normalizeTask,
  dedupeTasks,
  modelCall,
  classifyPrompt,
  generateSpec,
} from './hydra-utils.mjs';
import {
  sectionHeader,
  label,
  colorAgent,
  createSpinner,
  divider,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
  HIGHLIGHT,
  formatElapsed,
} from './hydra-ui.mjs';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;
const CHECKPOINT_DIR = path.join(config.coordDir, '..', 'runs');

/**
 * Simple deterministic hash of a string, returns first 12 hex chars.
 */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  // Convert to unsigned 32-bit then hex, pad, and use first 12 chars
  const hex = (h >>> 0).toString(16).padStart(8, '0');
  // Mix in length for more entropy
  const h2 = ((h >>> 0) ^ (str.length * 2654435761)) >>> 0;
  return (hex + h2.toString(16).padStart(8, '0')).slice(0, 12);
}

function checkpointPath(promptHash) {
  return path.join(RUNS_DIR, `COUNCIL_CHECKPOINT_${promptHash}.json`);
}

function loadCheckpoint(promptHash, prompt) {
  const cpPath = checkpointPath(promptHash);
  if (!fs.existsSync(cpPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(cpPath, 'utf8'));
    if (data.prompt !== prompt) return null; // prompt mismatch
    return data;
  } catch {
    return null;
  }
}

function saveCheckpoint(promptHash, prompt, round, stepIdx, transcript, specContent) {
  ensureDir(RUNS_DIR);
  const data = {
    promptHash,
    prompt,
    round,
    stepIdx,
    transcript,
    specContent: specContent || null,
    startedAt: transcript[0]?.startedAt || nowIso(),
    updatedAt: nowIso(),
  };
  fs.writeFileSync(checkpointPath(promptHash), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function deleteCheckpoint(promptHash) {
  const cpPath = checkpointPath(promptHash);
  try { fs.unlinkSync(cpPath); } catch { /* ignore */ }
}

const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

/**
 * Council flow: Claude→Gemini→Claude→Codex
 * Each step has a specific phase and agent-aware prompt.
 */
const COUNCIL_FLOW = [
  { agent: 'claude', phase: 'propose', promptLabel: 'Analyze this objective and propose a detailed plan with task breakdown.' },
  { agent: 'gemini', phase: 'critique', promptLabel: 'Review this plan critically. Identify risks, edge cases, missed files, and regressions. Cite specific code.' },
  { agent: 'claude', phase: 'refine', promptLabel: 'Incorporate the critique. Produce the final plan with concrete task specs for implementation.' },
  { agent: 'codex', phase: 'implement', promptLabel: 'Given this finalized plan, produce exact file paths, function signatures, and implementation steps for each task.' },
];

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };

function usageGuard(agent) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = MODE_DOWNSHIFT[currentMode];
      if (nextMode) {
        process.stderr.write(`  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}\n`);
        setMode(nextMode);
      } else {
        process.stderr.write(`  ${WARNING('\u26A0')} Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode\n`);
      }
    } else if (usage.level === 'warning') {
      process.stderr.write(`  ${DIM('\u26A0')} Token usage at ${usage.percent.toFixed(1)}%\n`);
    }
  } catch { /* non-critical */ }
}

function callAgent(agent, prompt, timeoutMs) {
  usageGuard(agent);
  return modelCall(agent, prompt, timeoutMs, { cwd: config.projectRoot });
}

function extractTasksFromOutput(parsed, fallbackOwner = 'unassigned') {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const buckets = [
    parsed.task_allocations,
    parsed.recommended_tasks,
    parsed.tasks,
    parsed.delegation?.task_splits,
  ];
  const out = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      const normalized = normalizeTask(item, fallbackOwner);
      if (normalized) {
        out.push(normalized);
      }
    }
  }
  return out;
}

function extractQuestions(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const questions = [];
  const buckets = [parsed.questions, parsed.final_questions, parsed.open_questions];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const q of bucket) {
      if (typeof q === 'string' && q.trim()) {
        questions.push({ to: 'human', question: q.trim() });
      } else if (q && typeof q === 'object') {
        const question = String(q.question || q.text || '').trim();
        if (!question) {
          continue;
        }
        questions.push({
          to: sanitizeOwner(q.to || 'human'),
          question,
        });
      }
    }
  }
  return questions;
}

function extractRisks(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const risks = [];
  const buckets = [parsed.risks, parsed.sanity_checks, parsed.edge_cases];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const item of bucket) {
      if (typeof item === 'string' && item.trim()) {
        risks.push(item.trim());
      }
    }
  }
  return risks;
}

function extractCouncilSignal(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const boolCandidates = [parsed.should_open_council, parsed.needs_council, parsed.council_needed];
  let vote = null;
  for (const candidate of boolCandidates) {
    if (typeof candidate === 'boolean') {
      vote = candidate;
      break;
    }
  }
  if (vote === null) {
    return null;
  }
  const reason = String(parsed.council_reason || parsed.reason || '').trim();
  return { vote, reason };
}

function buildContextSummary(transcript) {
  return transcript
    .slice(-6)
    .map((entry) => {
      const content = entry.parsed ? JSON.stringify(entry.parsed) : entry.rawText;
      return `${entry.agent.toUpperCase()} (${entry.phase || `R${entry.round}`}): ${short(content, 500)}`;
    })
    .join('\n');
}

function buildStepPrompt(step, userPrompt, transcript, round, totalRounds, specContent = null) {
  const { agent, phase, promptLabel } = step;
  const agentConfig = getAgent(agent);
  const context = getProjectContext(agent, {}, config);

  const jsonSchemas = {
    propose: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    critique: [
      '{',
      '  "critique": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "edge_cases": ["string"],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    refine: [
      '{',
      '  "view": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      '  "recommended_tasks": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "sanity_checks": ["string"],',
      '  "risks": ["string"]',
      '}',
    ].join('\n'),
    implement: [
      '{',
      '  "consensus": "string",',
      '  "should_open_council": true|false,',
      '  "council_reason": "string",',
      '  "task_allocations": [{"owner":"gemini|codex|claude|human","title":"string","rationale":"string","definition_of_done":"string"}],',
      '  "review_chain": [{"from":"gemini|codex|claude","to":"gemini|codex|claude","purpose":"string"}],',
      '  "questions": [{"to":"gemini|codex|claude|human","question":"string"}],',
      '  "risks": ["string"],',
      '  "next_round_focus": "string"',
      '}',
    ].join('\n'),
  };

  return [
    `You are ${agentConfig.label} in Hydra Council round ${round}/${totalRounds}, phase: ${phase}.`,
    '',
    agentConfig.rolePrompt,
    '',
    context,
    '',
    'Return JSON only with keys:',
    jsonSchemas[phase],
    '',
    `Objective: ${userPrompt}`,
    '',
    specContent ? `Anchoring Specification — do not deviate from these requirements:\n${specContent}\n` : '',
    `Phase instruction: ${promptLabel}`,
    '',
    'Recent council context:',
    buildContextSummary(transcript) || '(none)',
    '',
    phase === 'critique'
      ? 'Focus: challenge assumptions and prevent regressions. Cite specific file paths and line numbers.'
      : phase === 'implement'
        ? 'Focus: executable allocation and review ordering. Do not write code.'
        : phase === 'refine'
          ? 'Focus: incorporate critique, finalize plan, produce concrete task specs for Codex (file paths, signatures, DoD).'
          : 'Focus: coordination quality, risk surfacing, and clear task split.',
    'Set should_open_council=true only if deeper multi-round deliberation is necessary.',
  ].join('\n');
}

function defaultTasks(userPrompt) {
  return [
    {
      owner: 'claude',
      title: `Coordinate approach for: ${short(userPrompt, 80)}`,
      rationale: 'Establish scope and risk controls.',
      done: 'Clear sequencing and open questions documented.',
    },
    {
      owner: 'gemini',
      title: `Stress-test plan assumptions for: ${short(userPrompt, 80)}`,
      rationale: 'Catch regressions and edge cases.',
      done: 'Critical edge-case list and critiques documented.',
    },
    {
      owner: 'codex',
      title: `Prepare implementation packet for: ${short(userPrompt, 80)}`,
      rationale: 'Produce actionable engineering steps.',
      done: 'Concrete tasks and verification plan ready.',
    },
  ];
}

function buildAgentBrief(agent, objective, consensus, tasks, questions, transcript) {
  const agentConfig = getAgent(agent);
  const myTasks = tasks.filter((t) => t.owner === agent || t.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q.to === agent || q.to === 'human');

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned; review consensus and propose next actions.'
      : myTasks
          .map((t) => `- ${t.title}${t.done ? ` (DoD: ${t.done})` : ''}${t.rationale ? ` [${t.rationale}]` : ''}`)
          .join('\n');

  const questionText =
    myQuestions.length === 0 ? '- none' : myQuestions.map((q) => `- to ${q.to}: ${q.question}`).join('\n');

  return [
    `Hydra Council assignment for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    `Objective: ${objective}`,
    `Consensus: ${consensus || 'No consensus text generated; use transcript summary.'}`,
    'Assigned tasks:',
    taskText,
    'Open questions:',
    questionText,
    'Latest council excerpts:',
    buildContextSummary(transcript),
    'Next step: Start with top task and handoff milestone or blocker via Hydra.',
  ].filter(Boolean).join('\n');
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const prompt = getPrompt(options, positionals);

  if (!prompt) {
    console.error('Missing prompt. Example: node hydra-council.mjs prompt="Investigate startup regressions"');
    process.exit(1);
  }

  const mode = String(options.mode || 'live').toLowerCase();
  const preview = mode === 'preview' || boolFlag(options.preview, false);
  const publish = boolFlag(options.publish, !preview);
  const rounds = Math.max(1, Math.min(4, Number.parseInt(String(options.rounds || '2'), 10) || 2));
  const timeoutMs = Number.parseInt(String(options.timeoutMs || DEFAULT_TIMEOUT_MS), 10);
  const url = String(options.url || DEFAULT_URL);
  const emit = String(options.emit || 'summary').toLowerCase();
  const save = boolFlag(options.save, emit === 'json' ? false : true);
  const agentsFilter = options.agents ? options.agents.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : null;

  const report = {
    id: runId('HYDRA_COUNCIL'),
    startedAt: nowIso(),
    finishedAt: null,
    prompt,
    mode: preview ? 'preview' : 'live',
    publish,
    rounds,
    councilFlow: (agentsFilter ? COUNCIL_FLOW.filter((s) => agentsFilter.includes(s.agent)) : COUNCIL_FLOW).map((s) => `${s.agent}:${s.phase}`),
    url,
    project: config.projectName,
    daemonSummary: null,
    transcript: [],
    consensus: '',
    tasks: [],
    questions: [],
    risks: [],
    councilVotes: [],
    recommendedMode: 'handoff',
    recommendationRationale: '',
    published: null,
  };

  try {
    const summaryResponse = await request('GET', url, '/summary');
    report.daemonSummary = summaryResponse.summary;
  } catch {
    report.daemonSummary = null;
  }

  // Generate spec for complex prompts to anchor council work
  let specContent = null;
  const classification = classifyPrompt(prompt);
  if (classification.tier === 'complex' && !preview) {
    try {
      const spec = generateSpec(prompt, report.id, { cwd: config.projectRoot });
      if (spec) {
        specContent = spec.specContent;
        report.specId = spec.specId;
      }
    } catch { /* non-critical */ }
  }

  // Filter council flow to only include agents in the filter (if provided)
  const activeFlow = agentsFilter
    ? COUNCIL_FLOW.filter((step) => agentsFilter.includes(step.agent))
    : COUNCIL_FLOW;

  // Checkpoint resume: check for existing checkpoint and restore state
  const promptHash = simpleHash(prompt);
  let startRound = 1;
  let startStepIdx = 0;

  if (!preview) {
    const checkpoint = loadCheckpoint(promptHash, prompt);
    if (checkpoint && Array.isArray(checkpoint.transcript) && checkpoint.transcript.length > 0) {
      report.transcript = checkpoint.transcript;
      if (checkpoint.specContent && !specContent) {
        specContent = checkpoint.specContent;
      }
      // Determine resume point from last completed entry
      const last = checkpoint.transcript.at(-1);
      startRound = last.round;
      startStepIdx = activeFlow.findIndex(
        (s) => s.agent === last.agent && s.phase === last.phase
      );
      if (startStepIdx >= 0) {
        startStepIdx += 1; // Start after the last completed step
        if (startStepIdx >= activeFlow.length) {
          startStepIdx = 0;
          startRound += 1;
        }
      } else {
        startStepIdx = 0;
      }
      const cached = checkpoint.transcript.length;
      process.stderr.write(`  Resuming council from round ${startRound}, step ${startStepIdx + 1} (${cached} phases cached)\n`);
    }
  }

  for (let round = 1; round <= rounds; round += 1) {
    for (let stepIdx = 0; stepIdx < activeFlow.length; stepIdx++) {
      // Skip phases already completed from checkpoint
      if (round < startRound || (round === startRound && stepIdx < startStepIdx)) {
        continue;
      }
      const step = activeFlow[stepIdx];
      const stepNum = stepIdx + 1;
      const totalSteps = activeFlow.length;
      const promptText = buildStepPrompt(step, prompt, report.transcript, round, rounds, specContent);

      if (preview) {
        const parsed = {
          view: `${step.agent} ${step.phase} preview response`,
          consensus: `${step.agent} ${step.phase} preview consensus`,
          recommended_tasks: defaultTasks(prompt).map((t) => ({
            owner: t.owner,
            title: t.title,
            rationale: t.rationale,
            definition_of_done: t.done,
          })),
          questions: [{ to: 'human', question: `Preview question from ${step.agent} (${step.phase})` }],
        };

        report.transcript.push({
          round,
          agent: step.agent,
          phase: step.phase,
          ok: true,
          rawText: JSON.stringify(parsed),
          parsed,
          error: '',
        });
        continue;
      }

      // Emit progress marker: phase starting
      const progressStart = JSON.stringify({
        type: 'council_phase',
        action: 'start',
        round,
        step: stepNum,
        totalSteps,
        agent: step.agent,
        phase: step.phase,
      });
      process.stderr.write(progressStart + '\n');

      const spinner = createSpinner(`${colorAgent(step.agent)} ${DIM(step.phase)} (round ${round}/${rounds})`);
      spinner.start();
      const phaseStartMs = Date.now();
      const result = callAgent(step.agent, promptText, timeoutMs);
      const parsed = parseJsonLoose(result.stdout);
      const durationMs = Date.now() - phaseStartMs;
      if (result.ok) {
        spinner.succeed(`${colorAgent(step.agent)} ${DIM(step.phase)} complete`);
      } else {
        spinner.fail(`${colorAgent(step.agent)} ${DIM(step.phase)} failed`);
      }

      // Emit progress marker: phase complete
      const progressComplete = JSON.stringify({
        type: 'council_phase',
        action: 'complete',
        round,
        step: stepNum,
        totalSteps,
        agent: step.agent,
        phase: step.phase,
        ok: result.ok,
        durationMs,
      });
      process.stderr.write(progressComplete + '\n');

      report.transcript.push({
        round,
        agent: step.agent,
        phase: step.phase,
        ok: result.ok,
        rawText: result.stdout,
        parsed,
        error: result.error || result.stderr || '',
      });

      // Save checkpoint after each completed phase
      if (!preview) {
        saveCheckpoint(promptHash, prompt, round, stepIdx, report.transcript, specContent);
      }
    }
  }

  // Council completed successfully — clean up checkpoint
  if (!preview) {
    deleteCheckpoint(promptHash);
  }

  const parsedEntries = report.transcript.filter((t) => t.parsed && typeof t.parsed === 'object');
  const codexEntries = parsedEntries.filter((t) => t.agent === 'codex');
  const lastCodex = codexEntries.at(-1);
  const lastClaudeRefine = parsedEntries.filter((t) => t.agent === 'claude' && t.phase === 'refine').at(-1);
  const lastClaude = parsedEntries.filter((t) => t.agent === 'claude').at(-1);

  report.consensus = String(
    lastCodex?.parsed?.consensus || lastClaudeRefine?.parsed?.view || lastClaude?.parsed?.view || ''
  ).trim();

  const taskCandidates = [];
  for (const entry of parsedEntries) {
    taskCandidates.push(...extractTasksFromOutput(entry.parsed, entry.agent));
  }
  report.tasks = taskCandidates.length > 0 ? dedupeTasks(taskCandidates) : defaultTasks(prompt);

  const questions = [];
  for (const entry of parsedEntries) {
    questions.push(...extractQuestions(entry.parsed));
  }
  report.questions = questions;

  const risks = [];
  for (const entry of parsedEntries) {
    risks.push(...extractRisks(entry.parsed));
  }
  report.risks = risks;

  const councilVotes = [];
  for (const entry of parsedEntries) {
    const signal = extractCouncilSignal(entry.parsed);
    if (!signal) {
      continue;
    }
    councilVotes.push({
      agent: entry.agent,
      phase: entry.phase,
      vote: signal.vote,
      reason: signal.reason,
    });
  }
  report.councilVotes = councilVotes;

  const votesForCouncil = councilVotes.filter((item) => item.vote).length;
  const votesAgainstCouncil = councilVotes.filter((item) => !item.vote).length;
  const crossAgentQuestions = report.questions.filter((q) => ['gemini', 'codex', 'claude'].includes(q.to)).length;
  const riskHeavy = report.risks.length >= 4;
  const voteMajorityForCouncil =
    councilVotes.length > 0 && votesForCouncil >= Math.ceil(councilVotes.length / 2);

  report.recommendedMode = voteMajorityForCouncil || crossAgentQuestions > 1 || riskHeavy ? 'council' : 'handoff';
  report.recommendationRationale = [
    `votes_for_council=${votesForCouncil}`,
    `votes_against_council=${votesAgainstCouncil}`,
    `cross_agent_questions=${crossAgentQuestions}`,
    `risk_items=${report.risks.length}`,
  ].join('; ');

  if (publish) {
    try {
      const health = await request('GET', url, '/health');
      if (!health.ok) {
        throw new Error('Hydra daemon is not healthy.');
      }

      const createdTasks = [];
      for (const task of report.tasks) {
        const created = await request('POST', url, '/task/add', {
          title: task.title,
          owner: task.owner,
          status: 'todo',
          notes: task.rationale ? `Council rationale: ${task.rationale}` : '',
        });
        createdTasks.push(created.task);
      }

      const decisionTitle = `Hydra Council: ${short(prompt, 90)}`;
      const decision = await request('POST', url, '/decision', {
        title: decisionTitle,
        owner: 'human',
        rationale: report.consensus || 'Council completed without explicit consensus.',
        impact: `Rounds=${rounds}; Tasks=${createdTasks.length}; Flow=Claude\u2192Gemini\u2192Claude\u2192Codex`,
      });

      const handoffs = [];
      const publishAgents = agentsFilter || AGENT_NAMES;
      for (const agent of publishAgents) {
        const agentTaskIds = createdTasks.filter((t) => t.owner === agent || t.owner === 'unassigned').map((t) => t.id);
        const summary = buildAgentBrief(agent, prompt, report.consensus, report.tasks, report.questions, report.transcript);
        const handoff = await request('POST', url, '/handoff', {
          from: 'human',
          to: agent,
          summary,
          nextStep: 'Acknowledge this council handoff and start highest-priority task.',
          tasks: agentTaskIds,
        });
        handoffs.push(handoff.handoff);
      }

      report.published = {
        ok: true,
        decision: decision.decision,
        tasks: createdTasks,
        handoffs,
      };
    } catch (error) {
      report.published = {
        ok: false,
        error: error.message,
      };
    }
  } else {
    report.published = {
      ok: true,
      skipped: true,
      reason: 'publish=false',
    };
  }

  report.finishedAt = nowIso();

  if (emit === 'json') {
    console.log(
      JSON.stringify(
        {
          ok: true,
          report,
        },
        null,
        2
      )
    );
    return;
  }

  if (save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${report.id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra council report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  // ── A. Compact Metadata ──
  console.log(sectionHeader('Hydra Council Summary'));
  console.log(label('ID', DIM(report.id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', ACCENT(report.mode)));
  console.log(label('Rounds', pc.white(String(rounds))));
  if (report.startedAt && report.finishedAt) {
    const durationMs = new Date(report.finishedAt) - new Date(report.startedAt);
    if (durationMs > 0) console.log(label('Duration', pc.white(formatElapsed(durationMs))));
  }

  // ── B. Phase Health ──
  if (report.transcript.length > 0) {
    console.log('');
    console.log(sectionHeader('Phase Health'));
    for (const entry of report.transcript) {
      if (entry.ok) {
        console.log(`  ${SUCCESS('\u2713')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${entry.round})`)}`);
      } else {
        const failLabel = entry.error?.includes('ETIMEDOUT') ? 'TIMEOUT' : 'FAILED';
        console.log(`  ${ERROR('\u2717')} ${colorAgent(entry.agent)} ${DIM(entry.phase)} ${DIM(`(round ${entry.round})`)} ${ERROR(failLabel)}`);
        if (entry.error) {
          console.log(`    ${DIM('\u2192')} ${DIM(short(entry.error.split('\n')[0], 72))}`);
        }
      }
    }
  }

  // ── C. Consensus ──
  console.log('');
  console.log(sectionHeader('Consensus'));
  if (report.consensus) {
    // Word-wrap to ~76 chars per line
    const words = report.consensus.split(/\s+/);
    let line = '';
    for (const word of words) {
      if (line.length + word.length + 1 > 76) {
        console.log(`  ${pc.white(line)}`);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) console.log(`  ${pc.white(line)}`);
  } else {
    const failedCount = report.transcript.filter((t) => !t.ok).length;
    if (failedCount > 0) {
      console.log(`  ${WARNING(`No consensus reached (${failedCount} phase(s) failed)`)}`);
    } else {
      console.log(`  ${DIM('(none)')}`);
    }
  }

  // ── D. Tasks List ──
  if (report.tasks.length > 0) {
    console.log('');
    console.log(sectionHeader(`Tasks (${report.tasks.length})`));
    report.tasks.forEach((task, i) => {
      const owner = task.owner || 'unassigned';
      const title = short(task.title || task.description || '', 55);
      console.log(`  ${DIM(`${i + 1}.`)} ${colorAgent(owner)}  ${pc.white(title)}`);
    });
  }

  // ── E. Risks ──
  if (report.risks && report.risks.length > 0) {
    console.log('');
    console.log(sectionHeader('Risks'));
    for (const risk of report.risks) {
      const text = typeof risk === 'string' ? risk : risk.risk || risk.description || JSON.stringify(risk);
      console.log(`  ${WARNING('\u26A0')} ${pc.white(short(text, 72))}`);
    }
  }

  // ── F. Questions ──
  if (report.questions.length > 0) {
    console.log('');
    console.log(sectionHeader('Questions'));
    for (const q of report.questions) {
      const to = q.to || 'human';
      console.log(`  ${ACCENT('?')} ${DIM('\u2192')} ${colorAgent(to)}${DIM(':')} ${pc.white(short(q.question || '', 65))}`);
    }
  }

  // ── G. Footer ──
  console.log('');
  console.log(divider());
  const recColor = report.recommendedMode === 'council' ? WARNING : SUCCESS;
  console.log(label('Recommended', recColor(report.recommendedMode)));
  let publishedLabel = DIM('no');
  if (report.published?.ok && report.published?.skipped) {
    publishedLabel = DIM('skipped');
  } else if (report.published?.ok) {
    publishedLabel = SUCCESS('yes');
  }
  console.log(label('Published', publishedLabel));
  if (report.published?.ok && !report.published?.skipped) {
    console.log('');
    console.log(DIM('  Pull commands:'));
    console.log(DIM('    npm run hydra:next -- agent=claude'));
    console.log(DIM('    npm run hydra:next -- agent=gemini'));
    console.log(DIM('    npm run hydra:next -- agent=codex'));
  }
  if (report.published?.ok === false) {
    console.log(label('Publish error', ERROR(report.published.error)));
  }
}

main().catch((error) => {
  console.error(`Hydra council failed: ${error.message}`);
  process.exit(1);
});
