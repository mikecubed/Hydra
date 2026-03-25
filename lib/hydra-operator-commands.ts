/**
 * Hydra Operator Command Handlers
 *
 * Extracted command handler functions from hydra-operator.ts.
 * Each handler receives a CommandContext and returns Promise<void>.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- T7A: operator uses polymorphic any for dynamic dispatch */
/* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-non-null-assertion -- T7A: standard JS truthiness; type narrowing tracked as follow-up */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-misused-promises -- T7A: handlers are async for uniform call-site API; child.on callbacks */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Interface as ReadlineInterface } from 'node:readline';
import { spawnHydraNode, spawnHydraNodeSync } from './hydra-exec-spawn.ts';
import {
  getAgent,
  AGENT_NAMES,
  getActiveModel,
  getModelSummary,
  setActiveModel,
  getMode,
  setMode,
  resetAgentModel,
  listAgents,
  formatEffortDisplay,
  setAgentEnabled,
} from './hydra-agents.ts';
import { DefaultAgentExecutor, type IAgentExecutor } from './hydra-shared/agent-executor.ts';
import { loadHydraConfig, saveHydraConfig } from './hydra-config.ts';
import type { ProjectConfig } from './hydra-config.ts';
import { request } from './hydra-utils.ts';
import {
  sectionHeader,
  colorAgent,
  label,
  ACCENT,
  DIM,
  SUCCESS,
  ERROR,
  WARNING,
} from './hydra-ui.ts';
import { setActiveMode } from './hydra-statusbar.ts';
import { promptChoice } from './hydra-prompt-choice.ts';
import { isGhAvailable, listPRs, getPR, pushBranchAndCreatePR } from './hydra-github.ts';
import { formatConflictWorktrees } from './hydra-worktree-conflicts.ts';
import pc from 'picocolors';

export interface CommandContext {
  baseUrl: string;
  agents: string[];
  config: ProjectConfig;
  rl: ReadlineInterface;
  HYDRA_ROOT: string;
  getLoopMode: () => string;
  setLoopMode: (mode: string) => void;
  initStatusBar: (agents: string[]) => void;
  destroyStatusBar: () => void;
  drawStatusBar: () => void;
  /** Optional executor for agent calls — defaults to DefaultAgentExecutor when absent. */
  executor?: IAgentExecutor;
}

function applyModelPairOverride(key: string, value: string): void {
  if (key === 'mode') {
    try {
      setMode(value);
      console.log(`  ${SUCCESS('\u2713')} Mode ${DIM('\u2192')} ${ACCENT(value)}`);
    } catch (err: unknown) {
      console.log(`  ${ERROR((err as Error).message)}`);
    }
  } else if (AGENT_NAMES.includes(key)) {
    if (value === 'default') {
      const resolved = resetAgentModel(key);
      console.log(
        `  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)} ${DIM('(following mode)')}`,
      );
    } else {
      const resolved = setActiveModel(key, value);
      console.log(`  ${SUCCESS('\u2713')} ${pc.bold(key)} ${DIM('\u2192')} ${pc.white(resolved)}`);
    }
  } else {
    console.log(`  ${ERROR('Unknown key:')} ${key}`);
  }
}

export async function handleModelCommand(ctx: CommandContext, args: string): Promise<void> {
  if (args) {
    if (args === 'reset') {
      setMode(getMode());
      console.log(
        `  ${SUCCESS('\u2713')} All agent overrides cleared, following mode ${ACCENT(getMode())}`,
      );
      ctx.rl.prompt();
      return;
    }
    const pairs = args.split(/\s+/);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        const key = pair.slice(0, eqIdx).toLowerCase();
        const value = pair.slice(eqIdx + 1);
        applyModelPairOverride(key, value);
      }
    }
  } else {
    const summary = getModelSummary();
    const currentMode = summary['_mode'] ?? getMode();
    console.log('');
    console.log(`  ${pc.bold('Mode:')} ${ACCENT(currentMode as string)}`);
    for (const [agent, info] of Object.entries(summary) as any) {
      if (agent === '_mode') continue;
      const model = info.isOverride ? pc.white(info.active) : DIM(info.active);
      const tag = info.isOverride ? WARNING('(override)') : DIM(`(${String(info.tierSource)})`);
      const effLabel2 = formatEffortDisplay(info.active, info.reasoningEffort);
      const effort = effLabel2 ? pc.yellow(` [${effLabel2}]`) : '';
      console.log(`  ${colorAgent(agent)}  ${model}${effort} ${tag}`);
    }
    console.log('');
    console.log(DIM(`  Set mode:  :model mode=economy`));
    console.log(DIM(`  Override:  :model codex=gpt-5.2-codex`));
    console.log(DIM(`  Reset all: :model reset`));
    console.log(DIM(`  Reset one: :model codex=default`));
    console.log(DIM(`  Browse:    :model:select [agent]`));
  }
  ctx.rl.prompt();
}

export async function handleModelSelectCommand(ctx: CommandContext, args: string): Promise<void> {
  const pickerArgs = [path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-models-select.ts')];
  if (args && AGENT_NAMES.includes(args.toLowerCase())) {
    pickerArgs.push(args.toLowerCase());
  }
  ctx.rl.pause();
  ctx.destroyStatusBar();
  spawnHydraNodeSync(pickerArgs[0], pickerArgs.slice(1), {
    stdio: 'inherit',
    windowsHide: true,
  });
  ctx.initStatusBar(ctx.agents);
  ctx.rl.resume();
  ctx.rl.prompt();
}

export async function handleRolesCommand(ctx: CommandContext): Promise<void> {
  const cfg = loadHydraConfig();
  const roles = cfg.roles;
  const recs = cfg.recommendations ?? {};
  console.log('');
  console.log(pc.bold('  Role → Agent → Model mapping'));
  console.log('');
  for (const [role, rc] of Object.entries(roles)) {
    const rec = (recs as any)[role];
    const modelStr = rc.model ? pc.white(rc.model) : DIM('(agent default)');
    const roleEffLabel = formatEffortDisplay(
      (rc.model ?? getActiveModel(rc.agent)) as string,
      rc.reasoningEffort,
    );
    const effortStr = roleEffLabel ? pc.yellow(` [${roleEffLabel}]`) : '';
    const match = rec?.models?.[0] === rc.model ? SUCCESS(' ✓') : '';
    console.log(
      `  ${ACCENT(role.padEnd(16))} ${colorAgent(rc.agent)}  ${modelStr}${effortStr}${match}`,
    );
    if (rec) {
      console.log(`  ${' '.repeat(16)} ${DIM(`Recommended: ${String(rec.models.join(', '))}`)}`);
      if (rec.note) console.log(`  ${' '.repeat(16)} ${DIM(rec.note)}`);
    }
  }
  console.log('');
  console.log(DIM('  Override in hydra.config.json under "roles" section'));
  console.log(DIM('  Or use :roster to edit interactively'));
  console.log('');
  ctx.rl.prompt();
}

export async function handleModeCommand(ctx: CommandContext, args: string): Promise<void> {
  if (!args) {
    const routingModeCfg = loadHydraConfig().routing.mode;
    let chip: string;
    if (routingModeCfg === 'economy') {
      chip = pc.yellow('◆ ECO');
    } else if (routingModeCfg === 'performance') {
      chip = pc.cyan('◆ PERF');
    } else {
      chip = pc.green('◆ BAL');
    }
    console.log(label('Mode', ACCENT(ctx.getLoopMode())));
    console.log(label('Routing mode', `${chip} ${pc.dim('(economy | balanced | performance)')}`));
    console.log(DIM(`  Switch orchestration: :mode auto | smart | handoff | council | dispatch`));
    console.log(DIM(`  Switch routing:       :mode economy | balanced | performance`));
    ctx.rl.prompt();
    return;
  }
  const nextMode = args.trim().toLowerCase();

  const routingModes = ['economy', 'balanced', 'performance'];
  if (routingModes.includes(nextMode)) {
    const cfg = loadHydraConfig();
    cfg.routing = { ...cfg.routing, mode: nextMode as any };
    saveHydraConfig(cfg);
    let chip: string;
    if (nextMode === 'economy') {
      chip = pc.yellow('◆ ECO');
    } else if (nextMode === 'performance') {
      chip = pc.cyan('◆ PERF');
    } else {
      chip = pc.green('◆ BAL');
    }
    console.log(`Mode set to ${chip}`);
    setActiveMode(nextMode);
    ctx.rl.prompt();
    return;
  }

  if (!['auto', 'handoff', 'council', 'dispatch', 'smart'].includes(nextMode)) {
    console.log(
      'Invalid mode. Use :mode auto, :mode handoff, :mode council, :mode dispatch, :mode smart, or :mode economy|balanced|performance',
    );
    ctx.rl.prompt();
    return;
  }
  ctx.setLoopMode(nextMode);
  setActiveMode(nextMode);
  console.log(label('Mode', ACCENT(nextMode)));
  ctx.drawStatusBar();
  ctx.rl.prompt();
}

function taskPriorityColor(priority: string): (s: string) => string {
  if (priority === 'high') return pc.red;
  if (priority === 'low') return DIM;
  return pc.yellow;
}

async function runTasksScan(ctx: CommandContext): Promise<void> {
  console.log(`  ${ACCENT('Scanning for work items...')}`);
  try {
    const { scanAllSources } = await import('./hydra-tasks-scanner.ts');
    const scanned = scanAllSources(ctx.config.projectRoot);
    if (scanned.length === 0) {
      console.log(`  ${DIM('No tasks found.')}`);
    } else {
      console.log('');
      console.log(sectionHeader(`Scanned Tasks (${String(scanned.length)})`));
      for (const t of scanned.slice(0, 15)) {
        const prioColor = taskPriorityColor(t.priority);
        console.log(`  ${prioColor(t.priority.padEnd(6))} ${t.title}`);
        console.log(
          `         ${DIM(`[${t.source}] ${t.taskType} → ${t.suggestedAgent} | ${t.sourceRef}`)}`,
        );
      }
      if (scanned.length > 15) {
        console.log(DIM(`  ... and ${String(scanned.length - 15)} more`));
      }
      console.log('');
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

function runTasksRun(ctx: CommandContext, tasksArg: string): void {
  const cwd = ctx.config.projectRoot;
  console.log(`  ${ACCENT('Launching tasks runner...')}`);
  ctx.rl.pause();
  ctx.destroyStatusBar();
  const tasksScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-tasks.ts');
  const tasksArgs = [tasksScript, `project=${cwd}`];
  const extra = tasksArg.slice('run'.length).trim();
  if (extra) {
    tasksArgs.push(...extra.split(/\s+/).filter(Boolean));
  }
  const child = spawnHydraNode(tasksArgs[0], tasksArgs.slice(1), {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('close', (code) => {
    ctx.initStatusBar(ctx.agents);
    ctx.rl.resume();
    if (code === 0) {
      console.log(`  ${SUCCESS('\u2713')} Tasks runner complete`);
    } else {
      console.log(`  ${ERROR(`Tasks runner exited with code ${String(code)}`)}`);
    }
    ctx.rl.prompt();
  });
}

function runTasksReview(ctx: CommandContext): void {
  const cwd = ctx.config.projectRoot;
  ctx.rl.pause();
  ctx.destroyStatusBar();
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-tasks-review.ts');
  const child = spawnHydraNode(reviewScript, ['review'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('close', async () => {
    try {
      const { state } = (await request('GET', ctx.baseUrl, '/state')) as any;
      const conflicts = formatConflictWorktrees(state.tasks ?? [], ctx.config.projectRoot);
      if (conflicts.length > 0) {
        console.log('');
        console.log(sectionHeader('Conflict Worktrees'));
        console.log(
          `  ${WARNING('\u26A0')}  ${String(conflicts.length)} task worktree${conflicts.length > 1 ? 's' : ''} have merge conflicts and were preserved for manual resolution:`,
        );
        console.log('');
        for (const t of conflicts) {
          console.log(`  ${ACCENT(t.id)} ${DIM(t.title)}`);
          console.log(`    ${DIM('Worktree:')} ${t.relPath}`);
          console.log(`    ${DIM('Branch:')}   ${t.branch}`);
          console.log('');
          console.log(`    ${DIM('Inspect:')}  git worktree list`);
          console.log(`    ${DIM('Diff:')}     git diff ${t.branch}`);
          console.log('');
        }
        console.log(
          `  ${DIM('To discard a conflict worktree, use :cleanup — stale worktrees appear after 24h.')}`,
        );
        console.log(
          `  ${DIM('To resolve manually: edit the conflicted files, commit, then run :cleanup.')}`,
        );
      }
    } catch {
      /* daemon may be unavailable — skip silently */
    }
    ctx.initStatusBar(ctx.agents);
    ctx.rl.resume();
    ctx.rl.prompt();
  });
}

function runTasksStatus(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-tasks-review.ts');
  const child = spawnHydraNode(reviewScript, ['status'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

function runTasksClean(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-tasks-review.ts');
  const child = spawnHydraNode(reviewScript, ['clean'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

async function showTasksList(ctx: CommandContext): Promise<void> {
  try {
    const { state } = (await request('GET', ctx.baseUrl, '/state')) as any;
    const active = state.tasks.filter((t: any) => t.status !== 'cancelled' && t.status !== 'done');
    if (active.length === 0) {
      console.log(`  ${DIM('No active tasks')}`);
    } else {
      console.log('');
      console.log(sectionHeader(`Tasks (${String(active.length)})`));
      for (const t of active) {
        const statusIcon = t.status === 'in_progress' ? WARNING('\u25CF') : DIM('\u25CB');
        console.log(
          `  ${statusIcon} ${pc.white(t.id)} ${colorAgent(t.owner)} ${String(t.title)} ${DIM(t.status)}`,
        );
      }
      console.log('');
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

export async function handleTasksCommand(ctx: CommandContext, args: string): Promise<void> {
  const tasksArg = args.trim().toLowerCase();
  if (tasksArg === 'scan') {
    await runTasksScan(ctx);
    return;
  }
  if (tasksArg === 'run' || tasksArg.startsWith('run ')) {
    runTasksRun(ctx, tasksArg);
    return;
  }
  if (tasksArg === 'review') {
    runTasksReview(ctx);
    return;
  }
  if (tasksArg === 'status') {
    runTasksStatus(ctx);
    return;
  }
  if (tasksArg === 'clean') {
    runTasksClean(ctx);
    return;
  }
  await showTasksList(ctx);
}

function showAgentsRegistry(): void {
  console.log('');
  console.log(sectionHeader('Agent Registry'));
  const physical = listAgents({ type: 'physical' });
  const virtual = listAgents({ type: 'virtual' });

  console.log(`  ${pc.bold('Physical Agents')} (${String(physical.length)})`);
  for (const a of physical) {
    const model = getActiveModel(a.name) ?? DIM('default');
    console.log(`    ${colorAgent(a.name)} ${DIM(a.label)}  ${DIM('model:')} ${pc.white(model)}`);
  }

  if (virtual.length > 0) {
    console.log('');
    console.log(`  ${pc.bold('Virtual Sub-Agents')} (${String(virtual.length)})`);
    for (const a of virtual) {
      const status = a.enabled ? SUCCESS('on') : ERROR('off');
      const base = DIM(`\u2192 ${String(a.baseAgent)}`);
      console.log(`    ${colorAgent(a.name)} ${DIM(a.displayName)}  ${base}  [${status}]`);
    }
  } else {
    console.log('');
    console.log(`  ${DIM('No virtual sub-agents registered.')}`);
  }

  console.log('');
  console.log(DIM('  :agents add              Add custom API agent (with provider preset picker)'));
  console.log(DIM('  :agents info <name>      Show agent details'));
  console.log(DIM('  :agents enable <name>    Enable a virtual agent'));
  console.log(DIM('  :agents disable <name>   Disable a virtual agent'));
  console.log(DIM('  :agents list virtual     List virtual agents only'));
  console.log(DIM('  :agents list physical    List physical agents only'));
  console.log('');
}

function handleAgentsList(filterType: string): void {
  const opts: any = {};
  if (filterType === 'virtual') opts.type = 'virtual';
  else if (filterType === 'physical') opts.type = 'physical';
  const list = listAgents(opts);
  console.log('');
  console.log(sectionHeader(`Agents (${filterType})`));
  for (const a of list) {
    const typeTag = a.type === 'virtual' ? DIM('[virtual]') : DIM('[physical]');
    const status = a.enabled ? SUCCESS('on') : ERROR('off');
    console.log(`    ${colorAgent(a.name)} ${typeTag} ${DIM(a.displayName)}  [${status}]`);
  }
  if (list.length === 0) console.log(`    ${DIM('(none)')}`);
  console.log('');
}

function handleAgentsInfo(targetName: string | undefined): void {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :agents info <name>`);
    return;
  }
  const agentDef = getAgent(targetName);
  if (!agentDef) {
    console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
    return;
  }
  console.log('');
  console.log(sectionHeader(`Agent: ${String(agentDef.displayName)}`));
  console.log(`  ${pc.bold('Name:')}      ${agentDef.name}`);
  console.log(`  ${pc.bold('Type:')}      ${agentDef.type}`);
  console.log(`  ${pc.bold('Label:')}     ${agentDef.label}`);
  console.log(`  ${pc.bold('Enabled:')}   ${agentDef.enabled ? SUCCESS('yes') : ERROR('no')}`);
  if (agentDef.baseAgent) {
    console.log(`  ${pc.bold('Base:')}      ${colorAgent(agentDef.baseAgent)}`);
  }
  if (agentDef.councilRole) {
    console.log(`  ${pc.bold('Council:')}   ${agentDef.councilRole}`);
  }
  if (agentDef.strengths!.length > 0) {
    console.log(`  ${pc.bold('Strengths:')} ${agentDef.strengths!.join(', ')}`);
  }
  if (agentDef.tags!.length > 0) {
    console.log(`  ${pc.bold('Tags:')}      ${agentDef.tags!.join(', ')}`);
  }
  const affinities = Object.entries(agentDef.taskAffinity).sort(([, a], [, b]) => b - a);
  if (affinities.length > 0) {
    console.log(`  ${pc.bold('Affinities:')}`);
    for (const [type, score] of affinities) {
      const bar = '\u2588'.repeat(Math.round(score * 20));
      const pad = ' '.repeat(20 - Math.round(score * 20));
      console.log(`    ${type.padEnd(16)} ${DIM(bar)}${DIM(pad)} ${(score * 100).toFixed(0)}%`);
    }
  }
  if (agentDef.rolePrompt) {
    console.log(`  ${pc.bold('Role Prompt:')}`);
    const lines = agentDef.rolePrompt.split('\n').slice(0, 6);
    for (const l of lines) console.log(`    ${DIM(l)}`);
    if (agentDef.rolePrompt.split('\n').length > 6) console.log(`    ${DIM('...')}`);
  }
  console.log('');
}

function handleAgentsToggle(subCmd: string, targetName: string | undefined): void {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :agents ${subCmd} <name>`);
    return;
  }
  const agentDef = getAgent(targetName);
  if (!agentDef) {
    console.log(`  ${ERROR('Unknown agent:')} ${targetName}`);
  } else if (agentDef.type === 'physical') {
    console.log(`  ${ERROR('Cannot')} ${subCmd} physical agents.`);
  } else {
    setAgentEnabled(targetName, subCmd === 'enable');
    console.log(`  ${SUCCESS('\u2713')} ${colorAgent(targetName)} ${subCmd}d`);
  }
}

function handleAgentsRemove(targetName: string | undefined): void {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :agents remove <name>`);
    return;
  }
  const cfg = loadHydraConfig();
  const before = cfg.agents.customAgents;
  const customAgents = before.filter((a) => a.name !== targetName);
  if (customAgents.length === before.length) {
    console.log(`  ${ERROR('Not found:')} "${targetName}" is not a custom agent`);
  } else {
    saveHydraConfig({ agents: { ...cfg.agents, customAgents } });
    console.log(
      `  ${SUCCESS('\u2713')} Removed agent "${targetName}" from config (restart to take effect)`,
    );
  }
}

async function handleAgentsTest(
  executor: IAgentExecutor,
  targetName: string | undefined,
): Promise<void> {
  if (!targetName) {
    console.log(`  ${ERROR('Usage:')} :agents test <name>`);
    return;
  }
  const agentDef = getAgent(targetName);
  if (!agentDef) {
    console.log(`  ${ERROR('Not found:')} agent "${targetName}" not in registry`);
    return;
  }
  console.log(`  Testing agent "${targetName}"...`);
  try {
    const result = await executor.executeAgent(targetName, 'Say "hello" in one sentence.');
    if (result.ok) {
      console.log(`  ${SUCCESS('OK')} ${DIM(result.output.slice(0, 200) || '(empty output)')}`);
    } else {
      console.log(
        `  ${ERROR('FAIL')} ${String(result.errorCategory)}: ${result.stderr.slice(0, 200)}`,
      );
    }
  } catch (err: unknown) {
    console.log(`  ${ERROR('ERROR')} ${(err as Error).message}`);
  }
}

export async function handleAgentsCommand(ctx: CommandContext, args: string): Promise<void> {
  const executor: IAgentExecutor = ctx.executor ?? new DefaultAgentExecutor();
  const agentParts = args.split(/\s+/);
  const agentSubCmd = agentParts[0] || '';

  if (!agentSubCmd) {
    showAgentsRegistry();
  } else if (agentSubCmd === 'list') {
    handleAgentsList(agentParts[1] || 'all');
  } else if (agentSubCmd === 'info') {
    handleAgentsInfo(agentParts[1]);
  } else if (agentSubCmd === 'enable' || agentSubCmd === 'disable') {
    handleAgentsToggle(agentSubCmd, agentParts[1]);
  } else if (agentSubCmd === 'add') {
    const { runAgentsWizard } = await import('./hydra-agents-wizard.ts');
    await runAgentsWizard(ctx.rl);
  } else if (agentSubCmd === 'remove') {
    handleAgentsRemove(agentParts[1]?.toLowerCase());
  } else if (agentSubCmd === 'test') {
    await handleAgentsTest(executor, agentParts[1]?.toLowerCase());
  } else {
    console.log(`  ${ERROR('Unknown subcommand:')} ${agentSubCmd}`);
    console.log(`  ${DIM('Usage: :agents [add|remove|test|info|list|enable|disable] [name]')}`);
  }

  ctx.rl.prompt();
}

export async function handleCleanupCommand(ctx: CommandContext): Promise<void> {
  try {
    const { runActionPipeline } = await import('./hydra-action-pipeline.ts');
    const {
      scanArchivableTasks,
      scanOldHandoffs,
      scanStaleBranches,
      scanStaleTasks,
      scanAbandonedSuggestions,
      scanOldCheckpoints,
      scanOldArtifacts,
      scanStaleTaskWorktrees,
      enrichCleanupWithSitrep,
      executeCleanupAction,
    } = await import('./hydra-cleanup.ts');

    await runActionPipeline(ctx.rl, {
      title: 'Cleanup',
      scanners: [
        () => scanArchivableTasks(ctx.baseUrl),
        () => scanOldHandoffs(ctx.baseUrl),
        () => scanStaleBranches(ctx.config.projectRoot),
        () => scanStaleTasks(ctx.baseUrl),
        () => scanAbandonedSuggestions(),
        () => scanOldCheckpoints(ctx.config.projectRoot),
        () => scanOldArtifacts(ctx.config.projectRoot),
        () => scanStaleTaskWorktrees(ctx.config.projectRoot),
      ],
      enrich: (items) =>
        enrichCleanupWithSitrep(items, {
          baseUrl: ctx.baseUrl,
          projectRoot: ctx.config.projectRoot,
        }),
      preSelectFilter: (item) => item.category === 'archive',
      executeFn: (item) =>
        executeCleanupAction(item, {
          baseUrl: ctx.baseUrl,
          projectRoot: ctx.config.projectRoot,
        }),
      projectRoot: ctx.config.projectRoot,
      baseUrl: ctx.baseUrl,
    });
  } catch (err: unknown) {
    console.log(`  ${ERROR((err as Error).message)}`);
  }
  ctx.rl.prompt();
}

function handlePrCreate(ctx: CommandContext, prRest: string): void {
  const branch = prRest || undefined;
  console.log(`  ${DIM('Pushing branch and creating PR...')}`);
  const result = pushBranchAndCreatePR({ cwd: ctx.config.projectRoot, branch });
  if (result.ok) {
    console.log(`  ${SUCCESS('PR created:')} ${String(result.url)}`);
  } else {
    console.log(`  ${ERROR('Failed:')} ${result.error ?? 'unknown error'}`);
  }
}

function handlePrList(ctx: CommandContext): void {
  const prs = listPRs({ cwd: ctx.config.projectRoot });
  if (prs.length === 0) {
    console.log(`  ${DIM('No open pull requests.')}`);
  } else {
    console.log(`  ${pc.bold(`Open PRs (${String(prs.length)}):`)}`);
    for (const pr of prs) {
      console.log(
        `    ${ACCENT(`#${String(pr.number)}`)} ${String(pr.title)} ${DIM(`(${String(pr.headRefName)} by ${String(pr.author)})`)}`,
      );
    }
  }
}

function handlePrView(ctx: CommandContext, prRest: string): void {
  const pr = getPR({ cwd: ctx.config.projectRoot, ref: prRest });
  if (pr) {
    console.log(`  ${ACCENT(`#${String(pr.number)}`)} ${String(pr.title)}`);
    console.log(`  ${label('State')}       ${String(pr.state)}`);
    console.log(`  ${label('Branch')}      ${String(pr.headRefName)} → ${String(pr.baseRefName)}`);
    console.log(`  ${label('Author')}      ${String(pr.author?.login ?? pr.author ?? '?')}`);
    console.log(
      `  ${label('Changes')}     ${SUCCESS(`+${String(pr.additions ?? 0)}`)} ${ERROR(`-${String(pr.deletions ?? 0)}`)}`,
    );
    if (pr.url) console.log(`  ${label('URL')}         ${String(pr.url)}`);
  } else {
    console.log(`  ${ERROR('PR not found:')} ${prRest}`);
  }
}

export async function handlePrCommand(ctx: CommandContext, args: string): Promise<void> {
  const prCmd = args.split(/\s+/)[0]?.toLowerCase() || '';
  const prRest = args.slice(prCmd.length).trim();

  if (!isGhAvailable()) {
    console.log(`  ${ERROR('gh CLI not found.')} Install: https://cli.github.com`);
    ctx.rl.prompt();
    return;
  }

  if (prCmd === 'create') {
    handlePrCreate(ctx, prRest);
  } else if (prCmd === 'list') {
    handlePrList(ctx);
  } else if (prCmd === 'view') {
    if (!prRest) {
      console.log(`  ${ERROR('Usage:')} :pr view <number>`);
      ctx.rl.prompt();
      return;
    }
    handlePrView(ctx, prRest);
  } else {
    console.log(`  ${ERROR('Usage:')} :pr <create|list|view> [args]`);
  }

  ctx.rl.prompt();
}

async function ensureBranchAndClean(
  ctx: CommandContext,
  cwd: string,
  baseBranch: string,
  runLabel: string,
): Promise<boolean> {
  const curBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  }).stdout.trim();
  if (curBranch !== baseBranch) {
    const brExists =
      spawnSync('git', ['rev-parse', '--verify', baseBranch], { cwd, encoding: 'utf8' }).status ===
      0;
    if (!brExists) {
      console.log(`  ${ACCENT(`Creating '${baseBranch}' branch from '${curBranch}'...`)}`);
      spawnSync('git', ['branch', baseBranch], { cwd });
    }
    console.log(`  ${ACCENT(`Switching from '${curBranch}' to '${baseBranch}'...`)}`);
    const sw = spawnSync('git', ['checkout', baseBranch], { cwd, encoding: 'utf8' });
    if (sw.status !== 0) {
      console.log(`  ${ERROR(`Failed to switch branch: ${(sw.stderr || '').trim()}`)}`);
      ctx.rl.prompt();
      return false;
    }
  }
  const status = spawnSync('git', ['status', '--porcelain'], {
    cwd,
    encoding: 'utf8',
  }).stdout.trim();
  if (status) {
    const confirm = (await promptChoice(ctx.rl, {
      message: `Working tree is not clean. Auto-commit before ${runLabel}?`,
      choices: [
        { label: 'Yes \u2014 commit all changes', value: 'yes' },
        { label: 'No \u2014 abort', value: 'no' },
      ],
      defaultIndex: 0,
      timeout: 30_000,
    })) as any;
    if (confirm.value !== 'yes') {
      console.log(`  ${WARNING('Aborted \u2014 commit or stash changes first.')}`);
      ctx.rl.prompt();
      return false;
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    spawnSync('git', ['add', '-A'], { cwd });
    spawnSync('git', ['commit', '-m', `chore: auto-commit before ${runLabel} ${ts}`], { cwd });
    console.log(`  ${SUCCESS('\u2713')} Changes committed.`);
  }
  return true;
}

function handleNightlyStatus(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-nightly-review.ts');
  const child = spawnHydraNode(reviewScript, ['status'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

function handleNightlyReview(ctx: CommandContext): void {
  const cwd = ctx.config.projectRoot;
  ctx.rl.pause();
  ctx.destroyStatusBar();
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-nightly-review.ts');
  const child = spawnHydraNode(reviewScript, ['review'], {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('close', () => {
    ctx.initStatusBar(ctx.agents);
    ctx.rl.resume();
    ctx.rl.prompt();
  });
}

function handleNightlyClean(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-nightly-review.ts');
  const child = spawnHydraNode(reviewScript, ['clean'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

function resolveNightlyModeDefaults(
  modeValue: string,
  nightlyCfg: any,
): { maxTasksDefault: string; maxHoursDefault: string } {
  if (modeValue === 'quick') return { maxTasksDefault: '3', maxHoursDefault: '1' };
  if (modeValue === 'deep') return { maxTasksDefault: '10', maxHoursDefault: '8' };
  if (modeValue === 'auto') return { maxTasksDefault: '7', maxHoursDefault: '6' };
  return {
    maxTasksDefault: String(nightlyCfg!.maxTasks ?? 5),
    maxHoursDefault: String(nightlyCfg!.maxHours ?? 4),
  };
}

function applyNightlyModeArgs(modeValue: string, nightlyArgs: string[]): void {
  if (modeValue === 'quick') {
    nightlyArgs.push('max-tasks=3', 'max-hours=1');
  } else if (modeValue === 'deep') {
    nightlyArgs.push('max-tasks=10', 'max-hours=8');
  } else if (modeValue === 'auto') {
    nightlyArgs.push('max-tasks=7', 'max-hours=6');
  }
}

function applyNumericArg(
  nightlyArgs: string[],
  prefix: string,
  rawValue: string,
  parseFn: (v: string) => number,
): void {
  const parsed = parseFn(rawValue);
  if (!Number.isNaN(parsed) && parsed > 0) {
    const idx = nightlyArgs.findIndex((a) => a.startsWith(`${prefix}=`));
    if (idx !== -1) nightlyArgs.splice(idx, 1);
    nightlyArgs.push(`${prefix}=${String(parsed)}`);
  }
}

async function collectDiscoveryOption(
  ctx: CommandContext,
  nightlyCfg: any,
  nightlyArgs: string[],
): Promise<void> {
  const discoveryChoice = (await promptChoice(ctx.rl, {
    message: 'Enable AI discovery? (agent suggests improvement tasks)',
    context: { default: nightlyCfg!.sources?.['aiDiscovery'] === false ? 'off' : 'on' },
    choices: [
      { label: 'Yes \u2014 discover + scan', value: 'yes' },
      { label: 'No \u2014 scan only', value: 'no' },
    ],
    defaultIndex: nightlyCfg!.sources?.['aiDiscovery'] === false ? 1 : 0,
    timeout: 20_000,
  })) as any;
  if (discoveryChoice.value === 'no') {
    nightlyArgs.push('--no-discovery');
  }
}

async function collectNightlyOptions(
  ctx: CommandContext,
  nightlyCfg: any,
  nightlyArgs: string[],
): Promise<void> {
  const modeChoice = (await promptChoice(ctx.rl, {
    message: 'Execution mode?',
    context: { default: 'balanced' },
    choices: [
      {
        label: 'Balanced',
        value: 'balanced',
        description: 'Default config: moderate budget & time limits',
      },
      {
        label: 'Quick / Fast',
        value: 'quick',
        description: 'Fewer tasks, shorter timeout, economy models',
      },
      {
        label: 'Deep / Thorough',
        value: 'deep',
        description: 'More tasks, longer timeout, high reasoning',
      },
      {
        label: 'Auto / Intuitive',
        value: 'auto',
        description: 'Let agents switch tiers per-task complexity',
      },
    ],
    defaultIndex: 0,
    timeout: 60_000,
  })) as any;
  applyNightlyModeArgs(modeChoice.value, nightlyArgs);
  const { maxTasksDefault, maxHoursDefault } = resolveNightlyModeDefaults(
    modeChoice.value,
    nightlyCfg,
  );

  const tasksChoice = (await promptChoice(ctx.rl, {
    message: `Max tasks to execute?`,
    context: { default: maxTasksDefault },
    choices: [
      { label: `${maxTasksDefault} (default)`, value: maxTasksDefault },
      { label: '3 (light)', value: '3' },
      { label: '5 (moderate)', value: '5' },
      { label: '10 (heavy)', value: '10' },
    ],
    defaultIndex: 0,
    freeform: true,
    timeout: 30_000,
  })) as any;
  applyNumericArg(nightlyArgs, 'max-tasks', tasksChoice.value, (v) => Number.parseInt(v, 10));

  const hoursChoice = (await promptChoice(ctx.rl, {
    message: `Max hours?`,
    context: { default: maxHoursDefault },
    choices: [
      { label: `${maxHoursDefault}h (default)`, value: maxHoursDefault },
      { label: '1h (quick)', value: '1' },
      { label: '4h (standard)', value: '4' },
      { label: '8h (overnight)', value: '8' },
    ],
    defaultIndex: 0,
    freeform: true,
    timeout: 30_000,
  })) as any;
  applyNumericArg(nightlyArgs, 'max-hours', hoursChoice.value, Number.parseFloat);

  await collectDiscoveryOption(ctx, nightlyCfg, nightlyArgs);
  nightlyArgs.push('--interactive');
}

export async function handleNightlyCommand(ctx: CommandContext, args: string): Promise<void> {
  const nightlyArg = args.trim().toLowerCase();

  if (nightlyArg === 'status') {
    handleNightlyStatus(ctx);
    return;
  }
  if (nightlyArg === 'review') {
    handleNightlyReview(ctx);
    return;
  }
  if (nightlyArg === 'clean') {
    handleNightlyClean(ctx);
    return;
  }

  const isDryRun = nightlyArg === 'dry-run';
  const cfg = loadHydraConfig();
  const nightlyCfg = cfg.nightly;
  const baseBranch = nightlyCfg!.baseBranch ?? 'dev';
  const cwd = ctx.config.projectRoot;

  if (!(await ensureBranchAndClean(ctx, cwd, baseBranch, 'nightly run'))) return;

  const nightlyArgs = [path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-nightly.ts'), `project=${cwd}`];
  if (isDryRun) {
    nightlyArgs.push('--dry-run');
  } else {
    await collectNightlyOptions(ctx, nightlyCfg, nightlyArgs);
  }

  const runLabel = isDryRun ? 'nightly dry-run' : 'nightly run';
  console.log(`  ${ACCENT(`Launching ${runLabel}...`)}`);
  ctx.rl.pause();
  ctx.destroyStatusBar();
  const child = spawnHydraNode(nightlyArgs[0], nightlyArgs.slice(1), {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('close', (code) => {
    ctx.initStatusBar(ctx.agents);
    ctx.rl.resume();
    if (code === 0) {
      console.log(`  ${SUCCESS('\u2713')} Nightly ${isDryRun ? 'dry-run' : 'run'} complete`);
    } else {
      console.log(`  ${ERROR(`Nightly exited with code ${String(code)}`)}`);
    }
    ctx.rl.prompt();
  });
}

function handleEvolveStatus(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-evolve-review.ts');
  const child = spawnHydraNode(reviewScript, ['status'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

function handleEvolveKnowledge(ctx: CommandContext): void {
  const reviewScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-evolve-review.ts');
  const child = spawnHydraNode(reviewScript, ['knowledge'], {
    cwd: ctx.config.projectRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('error', () => {});
  child.on('close', () => {
    ctx.rl.prompt();
  });
}

async function launchEvolveSession(
  ctx: CommandContext,
  cwd: string,
  evolveArg: string,
  extraArgs?: string,
): Promise<void> {
  const isResume = extraArgs !== undefined;
  console.log(
    `  ${ACCENT(isResume ? 'Resuming evolve session...' : 'Launching evolve session...')}`,
  );
  ctx.rl.pause();
  ctx.destroyStatusBar();
  const evolveScript = path.join(ctx.HYDRA_ROOT, 'lib', 'hydra-evolve.ts');
  const evolveArgs = [evolveScript, `project=${cwd}`];
  if (isResume) {
    evolveArgs.push('resume=1');
    if (extraArgs) evolveArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
  } else if (evolveArg) {
    evolveArgs.push(...evolveArg.split(/\s+/).filter(Boolean));
  }
  const child = spawnHydraNode(evolveArgs[0], evolveArgs.slice(1), {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('close', (code) => {
    ctx.initStatusBar(ctx.agents);
    ctx.rl.resume();
    if (code === 0) {
      console.log(`  ${SUCCESS('\u2713')} Evolve session complete`);
    } else {
      console.log(`  ${ERROR(`Evolve exited with code ${String(code)}`)}`);
    }
    ctx.rl.prompt();
  });
}

export async function handleEvolveCommand(ctx: CommandContext, args: string): Promise<void> {
  const evolveArg = args.trim().toLowerCase();

  if (evolveArg === 'status') {
    handleEvolveStatus(ctx);
    return;
  }
  if (evolveArg === 'knowledge') {
    handleEvolveKnowledge(ctx);
    return;
  }

  if (evolveArg === 'resume' || evolveArg.startsWith('resume ')) {
    const extraArgs = evolveArg.slice('resume'.length).trim();
    const cfg = loadHydraConfig();
    const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
    const cwd = ctx.config.projectRoot;
    if (!(await ensureBranchAndClean(ctx, cwd, baseBranch, 'evolve resume'))) return;
    await launchEvolveSession(ctx, cwd, evolveArg, extraArgs);
    return;
  }

  const cfg = loadHydraConfig();
  const baseBranch = cfg.evolve?.baseBranch ?? 'dev';
  const cwd = ctx.config.projectRoot;
  if (!(await ensureBranchAndClean(ctx, cwd, baseBranch, 'evolve'))) return;
  await launchEvolveSession(ctx, cwd, evolveArg);
}
