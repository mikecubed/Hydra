#!/usr/bin/env node
/**
 * CLI client for the local orchestrator daemon.
 */

import path from 'node:path';
import {
  parseArgsWithCommand,
  getOption,
  requireOption,
  parseList,
  request,
} from './hydra-utils.ts';
import {
  AGENT_NAMES,
  getActiveModel,
  setActiveModel,
  getModelSummary,
  getMode,
  setMode,
  resetAgentModel,
} from './hydra-agents.ts';
import {
  hydraLogoCompact,
  renderDashboard,
  renderStatsDashboard,
  label,
  agentBadge,
  relativeTime,
  sectionHeader,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
  ACCENT,
} from './hydra-ui.ts';
import { checkUsage } from './hydra-usage.ts';
import type { ModelSummaryEntry } from './types.ts';
import pc from 'picocolors';
import { spawnHydraNodeSync } from './hydra-exec.ts';

const DEFAULT_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function printHelp() {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  CLI client for the Hydra orchestrator daemon'));
  console.log('');
  console.log(`${pc.bold('Usage:')}  node orchestrator-client.mjs <command> [key=value]`);
  console.log('');
  console.log(pc.bold('Commands:'));
  console.log(`  ${ACCENT('status')}              Show daemon health`);
  console.log(`  ${ACCENT('summary')}             Dashboard with tasks, agents, handoffs`);
  console.log(`  ${ACCENT('state')}               Raw sync state JSON`);
  console.log(`  ${ACCENT('next')} agent=NAME      Suggested next action for agent`);
  console.log(`  ${ACCENT('prompt')} agent=NAME    Context prompt for agent`);
  console.log(`  ${ACCENT('session:start')} ...    Start a coordination session`);
  console.log(`  ${ACCENT('task:add')} title=...   Add a task`);
  console.log(`  ${ACCENT('task:route')} taskId=   Route task to best agent`);
  console.log(`  ${ACCENT('claim')} agent=...      Claim a task`);
  console.log(`  ${ACCENT('task:update')} ...      Update task status/notes`);
  console.log(`  ${ACCENT('decision:add')} ...     Record a decision`);
  console.log(`  ${ACCENT('blocker:add')} ...      Record a blocker`);
  console.log(`  ${ACCENT('handoff')} ...          Create agent handoff`);
  console.log(`  ${ACCENT('handoff:ack')} ...      Acknowledge a handoff`);
  console.log(`  ${ACCENT('events')} [limit=50]    Recent daemon events`);
  console.log(`  ${ACCENT('verify')} taskId=...    Run tsc verification`);
  console.log(`  ${ACCENT('archive')}              Archive completed items`);
  console.log(`  ${ACCENT('stats')}                Agent metrics & usage dashboard`);
  console.log(`  ${ACCENT('model')} [mode=|agent=]  Show/set mode & active models`);
  console.log(`  ${ACCENT('model:select')} [agent]  Interactive model picker`);
  console.log(`  ${ACCENT('archive:status')}       Show archive stats`);
  console.log(`  ${ACCENT('init')}                 Initialize Hydra for current project`);
  console.log(`  ${ACCENT('stop')}                 Stop the daemon`);
  console.log('');
  console.log(DIM('  Add json=true to any command for raw JSON output'));
  console.log('');
}

async function handleStatus(baseUrl: string, jsonMode: boolean): Promise<void> {
  const data = await request<Record<string, unknown>>('GET', baseUrl, '/health');
  if (jsonMode) {
    print(data);
    return;
  }
  console.log('');
  console.log(hydraLogoCompact());
  console.log(label('Status', data['running'] === true ? SUCCESS('running') : ERROR('stopped')));
  console.log(label('PID', pc.white((data['pid'] as string | null | undefined) ?? '?')));
  console.log(
    label('Uptime', pc.white(`${String((data['uptimeSec'] as number | null | undefined) ?? 0)}s`)),
  );
  console.log(label('Project', pc.white((data['project'] as string | null | undefined) ?? '?')));
  console.log(
    label('Events', pc.white(String((data['eventsRecorded'] as number | null | undefined) ?? 0))),
  );
  console.log(label('Last event', relativeTime(data['lastEventAt'] as string)));
  console.log(label('State updated', relativeTime(data['stateUpdatedAt'] as string)));
  console.log('');
}

async function handleSummary(baseUrl: string, jsonMode: boolean): Promise<void> {
  const data = await request<Record<string, unknown>>('GET', baseUrl, '/summary');
  if (jsonMode) {
    print(data);
    return;
  }
  const agentNextMap: Record<string, unknown> = {};
  for (const agent of ['gemini', 'codex', 'claude']) {
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential: each agent next-action call is independent
      const nextData = await request('GET', baseUrl, `/next?agent=${encodeURIComponent(agent)}`);
      agentNextMap[agent] = (nextData as Record<string, unknown>)['next'];
    } catch {
      agentNextMap[agent] = { action: 'unknown' };
    }
  }
  const extras: Record<string, unknown> = {};
  try {
    extras['usage'] = checkUsage();
  } catch {
    /* ignore */
  }
  try {
    const modelSummary = getModelSummary();
    extras['models'] = {};
    for (const [agent, info] of Object.entries(modelSummary)) {
      const typedInfo = info as ModelSummaryEntry;
      const short = typedInfo.active.replace(/^claude-/, '').replace(/^gemini-/, '');
      if (typedInfo.isDefault !== true) (extras['models'] as Record<string, string>)[agent] = short;
    }
  } catch {
    /* ignore */
  }
  console.log('');
  console.log(
    renderDashboard(
      data['summary'] as Parameters<typeof renderDashboard>[0],
      agentNextMap as Parameters<typeof renderDashboard>[1],
      extras,
    ),
  );
}

async function handleNext(
  baseUrl: string,
  options: Record<string, string | boolean>,
  jsonMode: boolean,
): Promise<void> {
  const agent = requireOption(options, 'agent');
  const data = await request<Record<string, unknown>>(
    'GET',
    baseUrl,
    `/next?agent=${encodeURIComponent(agent)}`,
  );
  if (jsonMode) {
    print(data);
    return;
  }
  const next = data['next'] as Record<string, unknown>;
  console.log('');
  console.log(`  ${agentBadge(agent)}  ${pc.white(next['action'] as string)}`);
  console.log(label('Message', (next['message'] as string | null | undefined) ?? 'n/a'));
  if (next['task'] != null) {
    const t = next['task'] as Record<string, unknown>;
    console.log(
      label(
        'Task',
        `${pc.bold(t['id'] as string)} ${DIM((t['title'] as string | null | undefined) ?? '')}`,
      ),
    );
  }
  if (next['handoff'] != null) {
    const h = next['handoff'] as Record<string, unknown>;
    console.log(label('Handoff', `${pc.bold(h['id'] as string)} from ${h['from'] as string}`));
  }
  console.log('');
}

async function handleStats(baseUrl: string, jsonMode: boolean): Promise<void> {
  try {
    const data = await request('GET', baseUrl, '/stats');
    if (jsonMode) {
      print(data);
      return;
    }
    console.log(
      renderStatsDashboard(
        (data as Record<string, unknown>)['metrics'] as Parameters<typeof renderStatsDashboard>[0],
        (data as Record<string, unknown>)['usage'] as Parameters<typeof renderStatsDashboard>[1],
      ),
    );
  } catch {
    console.log(
      renderStatsDashboard(null, checkUsage() as Parameters<typeof renderStatsDashboard>[1]),
    );
  }
}

function handleModelAssignments(options: Record<string, string | boolean>): boolean {
  const assignments: { agent: string; model: unknown }[] = [];
  for (const [key, val] of Object.entries(options)) {
    if (AGENT_NAMES.includes(key)) assignments.push({ agent: key, model: val });
  }
  if (assignments.length === 0) return false;
  for (const { agent, model } of assignments) {
    if (model === 'default') {
      const resolved = resetAgentModel(agent);
      console.log(
        `  ${SUCCESS('\u2713')} ${pc.bold(agent)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`,
      );
    } else {
      const resolved = setActiveModel(agent, model as string);
      console.log(
        `  ${SUCCESS('\u2713')} ${pc.bold(agent)} ${DIM('\u2192')} ${pc.white(resolved)}`,
      );
    }
  }
  console.log('');
  return true;
}

function handleModelShow(): void {
  const summary = getModelSummary();
  const currentMode = (summary['_mode'] as string | undefined) ?? getMode();
  console.log('');
  console.log(hydraLogoCompact());
  console.log(sectionHeader('Active Models'));
  console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode)}`);
  console.log('');
  for (const [agent, info] of Object.entries(summary)) {
    if (agent === '_mode') continue;
    const typedInfo = info as ModelSummaryEntry;
    const badge = agentBadge(agent);
    const model =
      typedInfo.isOverride === true ? pc.white(typedInfo.active) : DIM(typedInfo.active);
    const tag =
      typedInfo.isOverride === true
        ? WARNING('(override)')
        : DIM(`(${typedInfo.tierSource ?? ''})`);
    const effort =
      typedInfo.reasoningEffort != null && typedInfo.reasoningEffort !== ''
        ? pc.yellow(` [${typedInfo.reasoningEffort}]`)
        : '';
    console.log(`  ${badge}  ${model}${effort} ${tag}`);
  }
  console.log('');
  console.log(DIM('  Set mode:  hydra model mode=economy'));
  console.log(DIM('  Override:  hydra model codex=gpt-5.2-codex'));
  console.log(DIM('  Reset all: hydra model reset'));
  console.log(DIM('  Reset one: hydra model codex=default'));
  console.log(DIM('  Browse:    hydra model:select'));
  console.log('');
}

function handleModel(options: Record<string, string | boolean>): void {
  if (getOption(options, 'reset', '') === 'true' || process.argv.includes('reset')) {
    setMode(getMode());
    console.log(
      `  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`,
    );
    console.log('');
    return;
  }
  const modeVal = getOption(options, 'mode', '');
  if (modeVal !== '') {
    try {
      setMode(modeVal);
      console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(modeVal)}`);
    } catch (err) {
      console.log(`  ${ERROR((err as Error).message)}`);
    }
    console.log('');
    return;
  }
  if (handleModelAssignments(options)) return;
  handleModelShow();
}

async function handleModelSelect(options: Record<string, string | boolean>): Promise<void> {
  const { pickAgent, pickModel, applySelection } = await import('./hydra-models-select.ts');
  let agentName: string | null = null;
  for (const [key, val] of Object.entries(options)) {
    if (AGENT_NAMES.includes(key)) {
      agentName = key;
      break;
    }
    if (AGENT_NAMES.includes(String(val))) {
      agentName = String(val);
      break;
    }
  }
  if (agentName == null || agentName === '') {
    for (const arg of process.argv.slice(3)) {
      const name = arg.toLowerCase().replace(/^--?/, '');
      if (AGENT_NAMES.includes(name)) {
        agentName = name;
        break;
      }
    }
  }
  if (agentName == null || agentName === '') {
    console.log('');
    agentName = await pickAgent();
    if (agentName == null || agentName === '') {
      console.log(DIM('  Cancelled.\n'));
      return;
    }
  }
  console.log('');
  const modelId = await pickModel(agentName);
  if (modelId == null || modelId === '') {
    console.log(DIM('  Cancelled.\n'));
    return;
  }
  const current = getActiveModel(agentName);
  if (modelId === current) {
    console.log(`\n  ${DIM(`${modelId} is already active for ${agentName}.`)}\n`);
    return;
  }
  const resolved = applySelection(agentName, modelId, null);
  console.log(
    `\n  ${SUCCESS('\u2713')} ${pc.bold(agentName)} \u2192 ${pc.white(resolved)}  ${DIM('(mode \u2192 custom)')}\n`,
  );
}

function handleInit(): void {
  const syncScript = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
    'sync.mjs',
  );
  console.log('');
  console.log(hydraLogoCompact());
  console.log(sectionHeader('Initialize'));
  console.log(label('Step 1', DIM('Creating coordination files...')));
  const initResult = spawnHydraNodeSync(syncScript, ['init'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (initResult.status === 0) {
    console.log(`  ${SUCCESS('\u2713')} Coordination files created`);
  } else {
    console.log(
      `  ${WARNING('\u26A0')} ${(initResult.stderr as string) === '' ? 'init had warnings' : (initResult.stderr as string)}`,
    );
  }
  console.log(label('Step 2', DIM('Running diagnostics...')));
  const doctorResult = spawnHydraNodeSync(syncScript, ['doctor'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    windowsHide: true,
  });
  console.log((doctorResult.stdout as string | null | undefined) ?? '');
  console.log(`  ${SUCCESS('\u2713')} Hydra initialized for ${process.cwd()}`);
  console.log('');
}

async function routeReadCommand(
  command: string,
  baseUrl: string,
  options: Record<string, string | boolean>,
  jsonMode: boolean,
): Promise<boolean> {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return true;
    case 'status':
      await handleStatus(baseUrl, jsonMode);
      return true;
    case 'summary':
      await handleSummary(baseUrl, jsonMode);
      return true;
    case 'state':
      print(await request('GET', baseUrl, '/state'));
      return true;
    case 'next':
      await handleNext(baseUrl, options, jsonMode);
      return true;
    case 'prompt': {
      const agent = requireOption(options, 'agent');
      print(await request('GET', baseUrl, `/prompt?agent=${encodeURIComponent(agent)}`));
      return true;
    }
    case 'events': {
      const limit = Number.parseInt(getOption(options, 'limit', '50'), 10);
      print(
        await request(
          'GET',
          baseUrl,
          `/events?limit=${String(Number.isFinite(limit) ? limit : 50)}`,
        ),
      );
      return true;
    }
    case 'stats':
      await handleStats(baseUrl, jsonMode);
      return true;
    case 'model':
      handleModel(options);
      return true;
    case 'model:select':
      await handleModelSelect(options);
      return true;
    case 'archive:status':
      print(await request('GET', baseUrl, '/state/archive'));
      return true;
    default:
      return false;
  }
}

async function routeTaskCommand(
  command: string,
  baseUrl: string,
  options: Record<string, string | boolean>,
): Promise<boolean> {
  switch (command) {
    case 'task:add':
      print(
        await request('POST', baseUrl, '/task/add', {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'unassigned'),
          status: getOption(options, 'status', 'todo'),
          type: getOption(options, 'type', ''),
          files: parseList(getOption(options, 'files', '')),
          notes: getOption(options, 'notes', ''),
          blockedBy: parseList(getOption(options, 'blockedBy', '')),
        }),
      );
      return true;
    case 'task:route':
      print(
        await request('POST', baseUrl, '/task/route', { taskId: requireOption(options, 'taskId') }),
      );
      return true;
    case 'claim':
      print(
        await request('POST', baseUrl, '/task/claim', {
          agent: requireOption(options, 'agent'),
          taskId: getOption(options, 'taskId', ''),
          title: getOption(options, 'title', ''),
          files: parseList(getOption(options, 'files', '')),
          notes: getOption(options, 'notes', ''),
        }),
      );
      return true;
    case 'task:update': {
      const payload: Record<string, unknown> = { taskId: requireOption(options, 'taskId') };
      for (const key of ['status', 'owner', 'notes', 'title'] as const) {
        if (key in options) payload[key] = getOption(options, key);
      }
      if ('files' in options) payload['files'] = parseList(getOption(options, 'files'));
      if ('blockedBy' in options) payload['blockedBy'] = parseList(getOption(options, 'blockedBy'));
      print(await request('POST', baseUrl, '/task/update', payload));
      return true;
    }
    case 'verify':
      print(
        await request('POST', baseUrl, '/verify', { taskId: requireOption(options, 'taskId') }),
      );
      return true;
    default:
      return false;
  }
}

async function routeWriteCommand(
  command: string,
  baseUrl: string,
  options: Record<string, string | boolean>,
): Promise<boolean> {
  const taskHandled = await routeTaskCommand(command, baseUrl, options);
  if (taskHandled) return true;
  switch (command) {
    case 'session:start':
      print(
        await request('POST', baseUrl, '/session/start', {
          focus: requireOption(options, 'focus', 'Example: focus="Fix onboarding deadlock"'),
          owner: getOption(options, 'owner', 'human'),
          participants: parseList(getOption(options, 'participants', 'human,gemini,codex,claude')),
          branch: getOption(options, 'branch', ''),
        }),
      );
      return true;
    case 'decision:add':
      print(
        await request('POST', baseUrl, '/decision', {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'human'),
          rationale: getOption(options, 'rationale', ''),
          impact: getOption(options, 'impact', ''),
        }),
      );
      return true;
    case 'blocker:add':
      print(
        await request('POST', baseUrl, '/blocker', {
          title: requireOption(options, 'title'),
          owner: getOption(options, 'owner', 'human'),
          nextStep: getOption(options, 'nextStep', ''),
        }),
      );
      return true;
    case 'handoff':
      print(
        await request('POST', baseUrl, '/handoff', {
          from: requireOption(options, 'from'),
          to: requireOption(options, 'to'),
          summary: requireOption(options, 'summary'),
          nextStep: getOption(options, 'nextStep', ''),
          tasks: parseList(getOption(options, 'tasks', '')),
        }),
      );
      return true;
    case 'handoff:ack':
      print(
        await request('POST', baseUrl, '/handoff/ack', {
          handoffId: requireOption(options, 'handoffId'),
          agent: requireOption(options, 'agent'),
        }),
      );
      return true;
    case 'archive':
      print(await request('POST', baseUrl, '/state/archive', {}));
      return true;
    case 'init':
      handleInit();
      return true;
    case 'stop':
      print(await request('POST', baseUrl, '/shutdown', {}));
      return true;
    default:
      return false;
  }
}

async function main() {
  const { command, options } = parseArgsWithCommand(process.argv);
  const baseUrl = getOption(options, 'url', DEFAULT_URL);
  const jsonMode = getOption(options, 'json', 'false') === 'true';

  await executeCommand(command, baseUrl, options, jsonMode);
}

async function executeCommand(
  command: string,
  baseUrl: string,
  options: Record<string, string | boolean>,
  jsonMode: boolean,
): Promise<void> {
  try {
    const handled =
      (await routeReadCommand(command, baseUrl, options, jsonMode)) ||
      (await routeWriteCommand(command, baseUrl, options));
    if (!handled) throw new Error(`Unknown command "${command}". Run with "help".`);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

void main();
