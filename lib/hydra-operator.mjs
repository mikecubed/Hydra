#!/usr/bin/env node
/**
 * Hydra Operator Console (hydra:go)
 *
 * One-terminal command center for dispatching prompts to Claude/Gemini/Codex.
 * Dispatch is recorded as Hydra handoffs so each agent can pull with hydra:next.
 * Supports modes: auto (mini-round triage), handoff (direct), council (full deliberation).
 *
 * Usage:
 *   node hydra-operator.mjs prompt="Investigate auth deadlock"
 *   node hydra-operator.mjs              # interactive mode
 *   node hydra-operator.mjs mode=dispatch prompt="..."  # dispatch pipeline
 */

import readline from 'readline';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { getProjectContext } from './hydra-context.mjs';
import { getAgent, AGENT_NAMES, getActiveModel, getModelSummary, setActiveModel, getMode, setMode, resetAgentModel } from './hydra-agents.mjs';
import { checkUsage, renderUsageDashboard, renderUsageBar, formatTokens, getContingencyOptions, executeContingency } from './hydra-usage.mjs';
import { resolveProject, HYDRA_ROOT } from './hydra-config.mjs';
import {
  parseArgs,
  getPrompt,
  parseList,
  boolFlag,
  short,
  request,
  normalizeTask,
  classifyPrompt,
} from './hydra-utils.mjs';
import {
  hydraSplash,
  hydraLogoCompact,
  renderDashboard,
  renderStatsDashboard,
  progressBar,
  agentBadge,
  label,
  sectionHeader,
  divider,
  colorAgent,
  createSpinner,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
} from './hydra-ui.mjs';
import {
  initStatusBar,
  destroyStatusBar,
  drawStatusBar,
  startEventStream,
  stopEventStream,
  onActivityEvent,
} from './hydra-statusbar.mjs';
import pc from 'picocolors';

const config = resolveProject();
const DEFAULT_URL = process.env.AI_ORCH_URL || 'http://127.0.0.1:4173';

// ── Daemon Auto-Start ────────────────────────────────────────────────────────

async function ensureDaemon(baseUrl, { quiet = false } = {}) {
  // Check if daemon is already running
  try {
    await request('GET', baseUrl, '/health');
    return true;
  } catch {
    // Not running — try to start it
  }

  if (!quiet) {
    process.stderr.write(`  ${DIM('\u2026')} Starting daemon...\n`);
  }

  const daemonScript = path.join(HYDRA_ROOT, 'lib', 'orchestrator-daemon.mjs');
  const child = spawn('node', [daemonScript, 'start'], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Wait for health (up to 8 seconds)
  for (let i = 0; i < 32; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await request('GET', baseUrl, '/health');
      if (!quiet) {
        process.stderr.write(`  ${SUCCESS('\u2713')} Daemon started\n`);
      }
      return true;
    } catch {
      // keep waiting
    }
  }

  return false;
}

// ── Welcome Screen ───────────────────────────────────────────────────────────

function printWelcome(baseUrl) {
  console.log(hydraSplash());
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Root', DIM(config.projectRoot)));
  console.log(label('Daemon', DIM(baseUrl)));

  // Mode & Models
  try {
    const models = getModelSummary();
    const currentMode = models._mode || getMode();
    console.log(label('Mode', ACCENT(currentMode)));
    const parts = [];
    for (const [agent, info] of Object.entries(models)) {
      if (agent === '_mode') continue;
      const colorFn = { claude: pc.magenta, gemini: pc.cyan, codex: pc.green }[agent] || pc.white;
      const shortModel = (info.active || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      const tag = info.isOverride ? pc.yellow(' *') : '';
      parts.push(`${colorFn(agent)}${DIM(':')}${pc.white(shortModel)}${tag}`);
    }
    console.log(label('Models', parts.join(DIM('  '))));
  } catch { /* skip */ }

  // Usage
  try {
    const usage = checkUsage();
    if (usage.level !== 'unknown' && usage.budget) {
      const modelShort = (usage.model || '').replace(/^claude-/, '').replace(/^gemini-/, '');
      console.log(label('CLI Burn', `${pc.white(formatTokens(usage.used || 0))} / ${pc.white(formatTokens(usage.budget))} tokens ${DIM(`(${modelShort})`)}`));
    } else if (usage.todayTokens > 0) {
      console.log(label('CLI Burn', `~${pc.white(formatTokens(usage.todayTokens))} tokens`));
    }
    console.log(label('Account', DIM('check claude.ai/settings/usage')));
  } catch { /* skip */ }

  console.log(divider());
  console.log('');
  console.log(pc.bold('  Quick commands:'));
  console.log(`    ${ACCENT(':help')}     ${DIM('all commands')}        ${ACCENT(':status')}   ${DIM('dashboard')}`);
  console.log(`    ${ACCENT(':model')}    ${DIM('active models')}       ${ACCENT(':usage')}    ${DIM('token budget')}`);
  console.log(`    ${ACCENT(':stats')}    ${DIM('agent metrics')}       ${ACCENT(':quit')}     ${DIM('exit')}`);
  console.log('');
  console.log(`  ${DIM('Mode:')} ${ACCENT('auto')} ${DIM('\u2014 type a prompt to dispatch via mini-round triage')}`);
  console.log('');
}

function buildAgentMessage(agent, userPrompt) {
  const agentConfig = getAgent(agent);
  const rolePrompt = agentConfig ? agentConfig.rolePrompt : 'Contribute effectively to this objective.';
  const agentLabel = agentConfig ? agentConfig.label : agent.toUpperCase();

  return [
    `Hydra dispatch for ${agentLabel}:`,
    `Primary objective: ${userPrompt}`,
    '',
    rolePrompt,
    '',
    agent === 'codex' ? 'You will receive precise task specs. Execute efficiently and report what you changed.' : '',
    agent === 'gemini' ? 'Cite specific file paths and line numbers in all findings.' : '',
    agent === 'claude' ? 'Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.' : '',
    '',
    'If blocked or unclear, ask direct questions immediately.',
    'When done with current chunk, create a Hydra handoff with exact next step.',
    '',
    getProjectContext(agent, {}, config),
  ].filter(Boolean).join('\n');
}

function buildMiniRoundBrief(agent, userPrompt, report) {
  const agentConfig = getAgent(agent);
  const tasks = Array.isArray(report?.tasks) ? report.tasks.map(normalizeTask).filter(Boolean) : [];
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const consensus = String(report?.consensus || '').trim();

  const myTasks = tasks.filter((task) => task.owner === agent || task.owner === 'unassigned');
  const myQuestions = questions.filter((q) => q && (q.to === agent || q.to === 'human'));

  const taskText =
    myTasks.length === 0
      ? '- No explicit task assigned. Start by proposing first concrete step.'
      : myTasks
          .map((task) => `- ${task.title}${task.done ? ` (DoD: ${task.done})` : ''}${task.rationale ? ` [${task.rationale}]` : ''}`)
          .join('\n');

  const questionText =
    myQuestions.length === 0
      ? '- none'
      : myQuestions
          .map((q) => {
            const to = String(q.to || 'human');
            const question = String(q.question || '').trim();
            return question ? `- to ${to}: ${question}` : null;
          })
          .filter(Boolean)
          .join('\n');

  return [
    `Hydra mini-round delegation for ${agentConfig ? agentConfig.label : agent.toUpperCase()}.`,
    '',
    agentConfig ? agentConfig.rolePrompt : '',
    '',
    getProjectContext(agent, {}, config),
    '',
    `Objective: ${userPrompt}`,
    `Recommendation: ${report?.recommendedMode || 'handoff'} (${report?.recommendationRationale || 'n/a'})`,
    `Consensus: ${consensus || 'No explicit consensus text.'}`,
    'Assigned tasks:',
    taskText,
    'Open questions:',
    questionText,
    'Next step: execute first task and publish milestone/blocker via Hydra handoff.',
  ].filter(Boolean).join('\n');
}

async function publishMiniRoundDelegation({ baseUrl, from, agents, promptText, report }) {
  const normalizedTasks = (Array.isArray(report?.tasks) ? report.tasks : []).map(normalizeTask).filter(Boolean);
  const tasksToCreate =
    normalizedTasks.length > 0
      ? normalizedTasks
      : agents.map((agent) => ({
          owner: agent,
          title: `Execute ${agent} contribution for: ${short(promptText, 120)}`,
          done: '',
          rationale: 'Generated fallback task because mini-round had no explicit allocations.',
        }));

  const createdTasks = [];
  for (const task of tasksToCreate) {
    const created = await request('POST', baseUrl, '/task/add', {
      title: task.title,
      owner: task.owner,
      status: 'todo',
      notes: task.rationale ? `Mini-round rationale: ${task.rationale}` : '',
    });
    createdTasks.push(created.task);
  }

  const decision = await request('POST', baseUrl, '/decision', {
    title: `Hydra Mini Round: ${short(promptText, 90)}`,
    owner: from,
    rationale: short(report?.consensus || 'Mini-round completed without explicit consensus.', 600),
    impact: `recommended=${report?.recommendedMode || 'handoff'}; tasks=${createdTasks.length}`,
  });

  const handoffs = [];
  for (const agent of agents) {
    const agentTaskIds = createdTasks.filter((task) => task.owner === agent || task.owner === 'unassigned').map((task) => task.id);
    const summary = buildMiniRoundBrief(agent, promptText, report);
    const handoff = await request('POST', baseUrl, '/handoff', {
      from,
      to: agent,
      summary,
      nextStep: 'Acknowledge and execute top-priority delegated task.',
      tasks: agentTaskIds,
    });
    handoffs.push(handoff.handoff);
  }

  return {
    decision: decision.decision,
    tasks: createdTasks,
    handoffs,
  };
}

async function dispatchPrompt({ baseUrl, from, agents, promptText }) {
  const records = [];
  for (const agent of agents) {
    const summary = buildAgentMessage(agent, promptText);
    const payload = {
      from,
      to: agent,
      summary,
      nextStep: 'Start work and report first milestone via hydra:handoff.',
      tasks: [],
    };
    const result = await request('POST', baseUrl, '/handoff', payload);
    records.push({
      agent,
      handoffId: result?.handoff?.id || null,
      summary,
    });
  }
  return records;
}

async function publishFastPathDelegation({ baseUrl, from, promptText, classification }) {
  const { taskType, suggestedAgent } = classification;

  const task = await request('POST', baseUrl, '/task/add', {
    title: short(promptText, 200),
    owner: suggestedAgent,
    status: 'todo',
    type: taskType,
    notes: `Fast-path dispatch (confidence=${classification.confidence}, reason: ${classification.reason})`,
  });

  const summary = buildAgentMessage(suggestedAgent, promptText);
  const handoff = await request('POST', baseUrl, '/handoff', {
    from,
    to: suggestedAgent,
    summary,
    nextStep: 'Start work and report first milestone via hydra:handoff.',
    tasks: task.task?.id ? [task.task.id] : [],
  });

  return {
    task: task.task,
    handoff: handoff.handoff,
    agent: suggestedAgent,
  };
}

/**
 * Spawn a child process asynchronously, collecting stdout/stderr.
 * Unlike spawnSync, this does NOT block the event loop, so status bar
 * polling and redraws continue while the subprocess runs.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [onProgress] - Called with parsed JSON progress markers from stderr
 */
function spawnAsync(cmd, args, opts = {}, onProgress = null) {
  return new Promise((resolve) => {
    const chunks = { stdout: [], stderr: [] };
    let stderrBuf = '';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => chunks.stdout.push(d));
    child.stderr.on('data', (d) => {
      chunks.stderr.push(d);
      if (onProgress) {
        stderrBuf += d;
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop(); // keep incomplete last line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed[0] !== '{') continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'council_phase') onProgress(parsed);
          } catch { /* not a progress marker */ }
        }
      }
    });
    child.on('error', (err) => {
      resolve({ status: 1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({
        status: code ?? 1,
        stdout: chunks.stdout.join(''),
        stderr: chunks.stderr.join(''),
      });
    });
  });
}

async function runCouncilPrompt({ baseUrl, promptText, rounds = 2, preview = false, onProgress = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const args = [councilScript, `prompt=${promptText}`, `url=${baseUrl}`, `rounds=${rounds}`];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  } else {
    args.push('publish=true');
  }

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function runCouncilJson({ baseUrl, promptText, rounds = 1, preview = false, publish = false, onProgress = null }) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.mjs');
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${rounds}`,
    'emit=json',
    'save=false',
    `publish=${publish ? 'true' : 'false'}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  }

  const result = await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress);

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: null,
    };
  }

  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      ok: true,
      status: result.status,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      report: parsed.report || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout || '',
      stderr: `Failed to parse council JSON: ${error.message}`,
      report: null,
    };
  }
}

async function runAutoPrompt({ baseUrl, from, agents, promptText, miniRounds, councilRounds, preview, onProgress = null }) {
  // Fast-path: classify locally before running expensive council mini-round
  const classification = classifyPrompt(promptText);

  if (classification.tier === 'simple' && !preview) {
    const published = await publishFastPathDelegation({
      baseUrl,
      from,
      promptText,
      classification,
    });

    return {
      mode: 'fast-path',
      recommended: 'handoff',
      route: `fast-path \u2192 ${published.agent} (${classification.taskType}, ${classification.confidence} confidence)`,
      classification,
      triage: null,
      published: {
        tasks: [published.task],
        handoffs: [published.handoff],
      },
      escalatedToCouncil: false,
    };
  }

  const triage = await runCouncilJson({
    baseUrl,
    promptText,
    rounds: miniRounds,
    preview,
    publish: false,
    onProgress,
  });

  if (!triage.ok || !triage.report) {
    throw new Error(triage.stderr || triage.stdout || `Mini-round exited with status ${triage.status}`);
  }

  const recommended = String(triage.report.recommendedMode || 'handoff').toLowerCase();
  if (preview) {
    return {
      mode: 'preview',
      recommended,
      route: classification.tier === 'complex' ? 'council (complex prompt)' : 'mini-round triage \u2192 preview',
      classification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: recommended === 'council',
    };
  }

  if (recommended === 'council' || classification.tier === 'complex') {
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: false,
      onProgress,
    });
    if (!council.ok) {
      throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    }
    return {
      mode: 'council',
      recommended,
      route: 'council (escalated)',
      classification,
      triage: triage.report,
      published: null,
      escalatedToCouncil: true,
      councilOutput: council.stdout.trim(),
    };
  }

  const published = await publishMiniRoundDelegation({
    baseUrl,
    from,
    agents,
    promptText,
    report: triage.report,
  });

  return {
    mode: 'handoff',
    recommended,
    route: 'mini-round triage \u2192 delegated',
    classification,
    triage: triage.report,
    published,
    escalatedToCouncil: false,
  };
}

async function printStatus(baseUrl, agents) {
  const summary = await request('GET', baseUrl, '/summary');
  const agentNextMap = {};
  for (const agent of agents) {
    try {
      const next = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
      agentNextMap[agent] = next.next;
    } catch { agentNextMap[agent] = { action: 'unknown' }; }
  }
  console.log('');
  console.log(renderDashboard(summary.summary, agentNextMap));
}

function printHelp() {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Operator Console'));
  console.log('');
  console.log(pc.bold('Interactive commands:'));
  console.log(`  ${ACCENT(':help')}                 Show help`);
  console.log(`  ${ACCENT(':status')}               Dashboard with agents & tasks`);
  console.log(`  ${ACCENT(':mode auto')}            Mini-round triage then delegate/escalate`);
  console.log(`  ${ACCENT(':mode handoff')}         Direct handoffs (fast, no triage)`);
  console.log(`  ${ACCENT(':mode council')}         Full council deliberation`);
  console.log(`  ${ACCENT(':mode dispatch')}        Headless pipeline (Claude\u2192Gemini\u2192Codex)`);
  console.log(`  ${ACCENT(':model')}                Show mode & active models`);
  console.log(`  ${ACCENT(':model mode=economy')} Switch global mode`);
  console.log(`  ${ACCENT(':model claude=sonnet')} Override agent model`);
  console.log(`  ${ACCENT(':model reset')}         Clear all overrides`);
  console.log(`  ${ACCENT(':usage')}                Token usage & contingencies`);
  console.log(`  ${ACCENT(':stats')}                Agent metrics & performance`);
  console.log(`  ${ACCENT(':quit')}                 Exit operator console`);
  console.log(`  ${DIM('<any text>')}             Dispatch as shared prompt`);
  console.log('');
  console.log(pc.bold('One-shot mode:'));
  console.log(DIM('  npm run hydra:go -- prompt="Your objective"'));
  console.log(DIM('  npm run hydra:go -- mode=council prompt="Your objective"'));
  console.log('');
}

async function interactiveLoop({
  baseUrl,
  from,
  agents,
  initialMode,
  councilRounds,
  councilPreview,
  autoMiniRounds,
  autoCouncilRounds,
  autoPreview,
  showWelcome,
}) {
  let mode = initialMode;
  if (showWelcome) {
    printWelcome(baseUrl);
  } else {
    printHelp();
    console.log(label('Mode', ACCENT(mode)));
    console.log('');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${ACCENT('hydra')}${DIM('>')} `,
  });

  initStatusBar(agents);
  startEventStream(baseUrl, agents);

  // Subscribe to significant activity events and show them inline
  onActivityEvent(({ event, agent, detail }) => {
    const significant = ['handoff_ack', 'task_done', 'verify'];
    if (!significant.includes(event)) return;
    const prefix = event === 'verify' ? WARNING('\u2691') : SUCCESS('\u2714');
    const msg = `  ${prefix} ${DIM(event.replace(/_/g, ' '))}${agent ? ` ${colorAgent(agent)}` : ''} ${DIM(detail || '')}`;
    // Clear current prompt line, print event, re-show prompt
    process.stdout.write(`\r\x1b[2K${msg}\n`);
    rl.prompt(true);
  });

  rl.prompt();

  rl.on('line', async (lineRaw) => {
    const line = String(lineRaw || '').trim();

    try {
      if (!line) {
        rl.prompt();
        return;
      }
      if (line === ':quit' || line === ':exit') {
        rl.close();
        return;
      }
      if (line === ':help') {
        printHelp();
        rl.prompt();
        return;
      }
      if (line === ':status') {
        await printStatus(baseUrl, agents);
        rl.prompt();
        return;
      }
      if (line === ':usage') {
        const usage = checkUsage();
        console.log(renderUsageDashboard(usage));
        rl.prompt();
        return;
      }
      if (line === ':stats') {
        try {
          const statsData = await request('GET', baseUrl, '/stats');
          console.log(renderStatsDashboard(statsData.metrics, statsData.usage));
        } catch {
          // Fallback to just usage if daemon is down
          const usage = checkUsage();
          console.log(renderStatsDashboard(null, usage));
        }
        rl.prompt();
        return;
      }
      if (line === ':model' || line.startsWith(':model ')) {
        const modelArgs = line.slice(':model'.length).trim();
        if (modelArgs) {
          // Handle "reset" — clear all overrides
          if (modelArgs === 'reset') {
            setMode(getMode());
            console.log(`  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`);
            rl.prompt();
            return;
          }
          // Parse "mode=economy" or "claude=sonnet gemini=flash" style
          const pairs = modelArgs.split(/\s+/);
          for (const pair of pairs) {
            const eqIdx = pair.indexOf('=');
            if (eqIdx > 0) {
              const key = pair.slice(0, eqIdx).toLowerCase();
              const value = pair.slice(eqIdx + 1);
              if (key === 'mode') {
                try {
                  setMode(value);
                  console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(value)}`);
                } catch (e) {
                  console.log(`  ${ERROR(e.message)}`);
                }
              } else if (AGENT_NAMES.includes(key)) {
                if (value === 'default') {
                  const resolved = resetAgentModel(key);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`);
                } else {
                  const resolved = setActiveModel(key, value);
                  console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)}`);
                }
              } else {
                console.log(`  ${ERROR('Unknown key:')} ${key}`);
              }
            }
          }
        } else {
          const summary = getModelSummary();
          const currentMode = summary._mode || getMode();
          console.log('');
          console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode)}`);
          for (const [agent, info] of Object.entries(summary)) {
            if (agent === '_mode') continue;
            const model = info.isOverride ? pc.white(info.active) : DIM(info.active);
            const tag = info.isOverride ? WARNING('(override)') : DIM(`(${info.tierSource})`);
            console.log(`  ${colorAgent(agent)}  ${model} ${tag}`);
          }
          console.log('');
          console.log(DIM(`  Set mode:  :model mode=economy`));
          console.log(DIM(`  Override:  :model codex=gpt-5.3`));
          console.log(DIM(`  Reset all: :model reset`));
          console.log(DIM(`  Reset one: :model codex=default`));
        }
        rl.prompt();
        return;
      }
      if (line.startsWith(':mode ')) {
        const nextMode = line.slice(':mode '.length).trim().toLowerCase();
        if (!['auto', 'handoff', 'council', 'dispatch'].includes(nextMode)) {
          console.log('Invalid mode. Use :mode auto, :mode handoff, :mode council, or :mode dispatch');
          rl.prompt();
          return;
        }
        mode = nextMode;
        console.log(label('Mode', ACCENT(mode)));
        rl.prompt();
        return;
      }

      if (mode === 'auto') {
        const classification = classifyPrompt(line);
        const EST_MS = { simple: 2_000, moderate: 45_000, complex: 90_000 };
        const PHASE_VERBS = { propose: 'proposing', critique: 'critiquing', refine: 'refining', implement: 'implementing' };
        const spinner = classification.tier === 'simple'
          ? createSpinner(`Fast-path \u2192 ${classification.suggestedAgent}`, { estimatedMs: EST_MS.simple }).start()
          : createSpinner(`Running ${classification.tier === 'complex' ? 'council deliberation' : 'mini-round triage'}`, { estimatedMs: EST_MS[classification.tier] }).start();
        const onProgress = (evt) => {
          if (evt.action === 'start') {
            const verb = PHASE_VERBS[evt.phase] || evt.phase;
            const prefix = classification.tier === 'complex' ? 'Council' : 'Mini-round';
            spinner.update(`${prefix}: ${evt.agent} ${verb}...  [${evt.step}/${evt.totalSteps}]`);
          }
        };
        let auto;
        try {
          auto = await runAutoPrompt({
            baseUrl,
            from,
            agents,
            promptText: line,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview,
            onProgress,
          });
          spinner.succeed(auto.mode === 'fast-path' ? `Fast-path dispatched to ${classification.suggestedAgent}` : `${auto.mode} complete`);
        } catch (e) {
          spinner.fail(e.message);
          throw e;
        }
        console.log(sectionHeader('Auto Dispatch'));
        console.log(label('Route', auto.mode === 'fast-path' ? SUCCESS(auto.route) : ACCENT(auto.route || auto.recommended)));
        if (auto.triage) {
          console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
        }
        if (auto.escalatedToCouncil) {
          if (auto.councilOutput) {
            console.log(auto.councilOutput);
          }
        } else if (auto.published) {
          console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
          console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
        } else {
          console.log(label('Route', DIM('preview only')));
        }
      } else if (mode === 'council') {
        const PHASE_VERBS_C = { propose: 'proposing', critique: 'critiquing', refine: 'refining', implement: 'implementing' };
        const councilSpinner = createSpinner('Running council deliberation', { estimatedMs: 90_000 }).start();
        const council = await runCouncilPrompt({
          baseUrl,
          promptText: line,
          rounds: councilRounds,
          preview: councilPreview,
          onProgress: (evt) => {
            if (evt.action === 'start') {
              const verb = PHASE_VERBS_C[evt.phase] || evt.phase;
              councilSpinner.update(`Council: ${evt.agent} ${verb}...  [${evt.step}/${evt.totalSteps}]`);
            }
          },
        });
        if (!council.ok) {
          councilSpinner.fail('Council failed');
          throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
        }
        councilSpinner.succeed('Council completed');
        console.log(council.stdout.trim());
      } else if (mode === 'dispatch') {
        console.log('Dispatch mode: run `npm run hydra:go -- mode=dispatch prompt="..."` for headless pipeline.');
      } else {
        const handoffSpinner = createSpinner('Dispatching to agents', { estimatedMs: 5_000 }).start();
        const records = await dispatchPrompt({
          baseUrl,
          from,
          agents,
          promptText: line,
        });
        handoffSpinner.succeed('Dispatched');

        console.log(sectionHeader('Dispatched'));
        for (const item of records) {
          console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
        }
        console.log('');
        console.log(DIM('  Pull commands:'));
        for (const agent of agents) {
          console.log(DIM(`    npm run hydra:next -- agent=${agent}`));
        }
      }
    } catch (error) {
      console.error(`Error: ${error.message}`);
    }

    drawStatusBar();
    rl.prompt();
  });

  rl.on('close', () => {
    stopEventStream();
    destroyStatusBar();
    console.log('Hydra operator console closed.');
    process.exit(0);
  });
}

async function main() {
  const { options, positionals } = parseArgs(process.argv);
  const baseUrl = String(options.url || DEFAULT_URL);
  const from = String(options.from || 'human').toLowerCase();
  const agents = parseList(options.agents || 'claude,gemini,codex');
  const mode = String(options.mode || 'auto').toLowerCase();
  const councilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.councilRounds || '2'), 10) || 2));
  const councilPreview = boolFlag(options.councilPreview, false);
  const autoMiniRounds = Math.max(1, Math.min(2, Number.parseInt(String(options.autoMiniRounds || '1'), 10) || 1));
  const autoCouncilRounds = Math.max(1, Math.min(4, Number.parseInt(String(options.autoCouncilRounds || String(councilRounds)), 10) || councilRounds));
  const autoPreview = boolFlag(options.autoPreview, false);
  const promptText = getPrompt(options, positionals);
  const interactive = !promptText;
  const showWelcome = boolFlag(options.welcome, interactive);

  // Auto-start daemon if not running
  const daemonOk = await ensureDaemon(baseUrl, { quiet: !interactive });
  if (!daemonOk) {
    console.error(`Hydra daemon unreachable at ${baseUrl}.`);
    console.error('Start manually: npm run hydra:start');
    process.exit(1);
  }

  if (interactive) {
    await interactiveLoop({
      baseUrl,
      from,
      agents,
      initialMode: mode,
      councilRounds,
      councilPreview,
      autoMiniRounds,
      autoCouncilRounds,
      autoPreview,
      showWelcome,
    });
    return;
  }

  if (mode === 'auto') {
    const auto = await runAutoPrompt({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds: autoMiniRounds,
      councilRounds: autoCouncilRounds,
      preview: autoPreview,
    });
    console.log(sectionHeader('Auto Dispatch Complete'));
    console.log(label('Route', auto.mode === 'fast-path' ? SUCCESS(auto.route) : ACCENT(auto.route || auto.recommended)));
    if (auto.triage) {
      console.log(label('Rationale', DIM(auto.triage.recommendationRationale || 'n/a')));
    }
    if (auto.escalatedToCouncil) {
      if (auto.councilOutput) {
        console.log(auto.councilOutput);
      }
    } else if (auto.published) {
      console.log(label('Tasks created', pc.white(String(auto.published.tasks.length))));
      console.log(label('Handoffs queued', pc.white(String(auto.published.handoffs.length))));
    } else {
      console.log(label('Route', DIM('preview')));
    }
  } else if (mode === 'council') {
    const council = await runCouncilPrompt({
      baseUrl,
      promptText,
      rounds: councilRounds,
      preview: councilPreview,
    });
    if (!council.ok) {
      throw new Error(council.stderr || council.stdout || `Council exited with status ${council.status}`);
    }
    console.log(council.stdout.trim());
  } else if (mode === 'dispatch') {
    // Headless dispatch pipeline: spawn hydra-dispatch.mjs
    const dispatchScript = path.join(HYDRA_ROOT, 'lib', 'hydra-dispatch.mjs');
    const args = [dispatchScript, `prompt=${promptText}`, `url=${baseUrl}`];
    if (boolFlag(options.preview, false)) {
      args.push('mode=preview');
    }
    const result = spawnSync('node', args, {
      cwd: config.projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 8,
      windowsHide: true,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      process.exit(result.status || 1);
    }
  } else {
    const records = await dispatchPrompt({
      baseUrl,
      from,
      agents,
      promptText,
    });

    console.log(sectionHeader('Dispatch Complete'));
    for (const item of records) {
      console.log(`  ${agentBadge(item.agent)}  ${DIM('handoff=')}${pc.bold(item.handoffId || '?')}`);
    }
    console.log('');
    console.log(DIM('  Pull commands:'));
    for (const agent of agents) {
      console.log(DIM(`    npm run hydra:next -- agent=${agent}`));
    }
  }
}

main().catch((error) => {
  console.error(`Hydra operator failed: ${error.message}`);
  process.exit(1);
});
