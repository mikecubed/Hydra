import pc from 'picocolors';
import { request } from './hydra-utils.ts';
import {
  ACCENT,
  DIM,
  hydraLogoCompact,
  label,
  renderDashboard,
  sectionHeader,
  type TaskLike,
} from './hydra-ui.ts';

type AgentNextAction = {
  action?: string;
  task?: { id?: string };
  handoff?: { id?: string };
};

type AgentNextMap = Record<string, AgentNextAction>;

type OpenTask = TaskLike & {
  pendingDependencies?: unknown[];
  blockedBy?: unknown[];
};

type OperatorStatusSummary = {
  openTasks?: number | OpenTask[];
  pendingHandoffs?: number;
} & Record<string, unknown>;

type StatusResponse = {
  summary?: OperatorStatusSummary;
};

type NextResponse = {
  next?: AgentNextAction;
};

type PrintNextStepsInput = {
  agentSuggestions?: AgentNextMap;
  pendingHandoffs?: unknown[];
  staleTasks?: unknown[];
  inProgressTasks?: unknown[];
  summary?: OperatorStatusSummary;
};

export type CommandHelpEntry = {
  usage: string[];
  desc: string;
};

export type SelfAwarenessConfig = {
  enabled?: boolean;
  includeSnapshot?: boolean;
  includeIndex?: boolean;
  snapshotMaxLines?: number;
  indexMaxChars?: number;
  indexRefreshMs?: number;
};

export type SelfAwarenessSummary = {
  enabled: boolean;
  includeSnapshot: boolean;
  includeIndex: boolean;
  level: 'off' | 'minimal' | 'full';
};

export const SMART_TIER_MAP = {
  simple: 'economy',
  medium: 'balanced',
  complex: 'performance',
};

export async function printStatus(
  baseUrl: string,
  agents: string[],
): Promise<OperatorStatusSummary> {
  const summary = await request<StatusResponse>('GET', baseUrl, '/summary');
  const dashboardSummary: OperatorStatusSummary = summary.summary ?? {};
  const agentNextEntries = await Promise.all(
    agents.map(async (agent): Promise<[string, AgentNextAction]> => {
      try {
        const next = await request<NextResponse>(
          'GET',
          baseUrl,
          `/next?agent=${encodeURIComponent(agent)}`,
        );
        return [agent, next.next ?? { action: 'unknown' }];
      } catch {
        return [agent, { action: 'unknown' }];
      }
    }),
  );
  const agentNextMap: AgentNextMap = Object.fromEntries(agentNextEntries);

  // Normalize openTasks: renderDashboard expects TaskLike[], not number | OpenTask[]
  const normalizedTasks: TaskLike[] = Array.isArray(dashboardSummary.openTasks)
    ? dashboardSummary.openTasks
    : [];
  const renderInput = { ...dashboardSummary, openTasks: normalizedTasks };

  console.log('');
  console.log(renderDashboard(renderInput, agentNextMap));
  printNextSteps({ agentSuggestions: agentNextMap, summary: dashboardSummary });
  return dashboardSummary;
}

function extractNextStepCounts(input: PrintNextStepsInput): {
  openTasks: number;
  handoffCount: number;
  staleCount: number;
  inProgressCount: number;
} {
  const { pendingHandoffs, staleTasks, inProgressTasks, summary } = input;
  const openTasks =
    typeof summary?.openTasks === 'number' ? summary.openTasks : (summary?.openTasks?.length ?? 0);
  const handoffCount = pendingHandoffs?.length ?? summary?.pendingHandoffs ?? 0;
  const staleCount = staleTasks?.length ?? 0;
  const inProgressCount = inProgressTasks?.length ?? 0;
  return { openTasks, handoffCount, staleCount, inProgressCount };
}

function buildPendingWorkStep(
  handoffCount: number,
  staleCount: number,
  inProgressCount: number,
): string {
  const parts: string[] = [];
  if (handoffCount > 0) parts.push(`${String(handoffCount)} handoff${handoffCount > 1 ? 's' : ''}`);
  if (staleCount > 0) parts.push(`${String(staleCount)} stale`);
  if (inProgressCount > 0) parts.push(`${String(inProgressCount)} in progress`);
  return `${ACCENT(':resume')}    ${DIM(`Ack handoffs & launch agents (${parts.join(', ')})`)}`;
}

function buildStepsList(
  openTasks: number,
  handoffCount: number,
  staleCount: number,
  inProgressCount: number,
): string[] {
  const steps: string[] = [];
  const hasPendingWork = handoffCount > 0 || staleCount > 0 || inProgressCount > 0;

  if (hasPendingWork) {
    steps.push(buildPendingWorkStep(handoffCount, staleCount, inProgressCount));
  }

  if (openTasks > 0 && !hasPendingWork) {
    steps.push(
      `${ACCENT(':status')}    ${DIM(`Review ${String(openTasks)} open task${openTasks > 1 ? 's' : ''}`)}`,
    );
  }

  if (openTasks === 0 && !hasPendingWork) {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Type a prompt to dispatch work to agents')}`);
    steps.push(
      `${ACCENT(':mode council')}     ${DIM('Switch to council mode for complex objectives')}`,
    );
  } else {
    steps.push(`${ACCENT('<your objective>')}  ${DIM('Dispatch additional work to agents')}`);
  }

  return steps;
}

/**
 * Print actionable suggested next steps based on current daemon state.
 * Shows concrete commands the user can type at the hydra> prompt.
 */
export function printNextSteps(input: PrintNextStepsInput = {}): void {
  const { openTasks, handoffCount, staleCount, inProgressCount } = extractNextStepCounts(input);

  const steps = buildStepsList(openTasks, handoffCount, staleCount, inProgressCount);

  if (steps.length > 0) {
    console.log(sectionHeader('Try next'));
    for (const step of steps.slice(0, 4)) {
      console.log(`  ${DIM('>')} ${step}`);
    }
  }
}

function printInteractiveCommandsHelp(): void {
  console.log(pc.bold('Interactive commands:'));
  console.log(`  ${ACCENT(':help')}                 Show help`);
  console.log(`  ${ACCENT(':status')}               Dashboard with agents & tasks`);
  console.log(`  ${ACCENT(':sitrep')}               AI-narrated situation report`);
  console.log(`  ${ACCENT(':self')}                 Hydra self snapshot (models, config, runtime)`);
  console.log(
    `  ${ACCENT(':aware')}                Hyper-awareness toggle (self snapshot/index injection)`,
  );
  console.log(`  ${ACCENT(':mode auto')}            Mini-round triage then delegate/escalate`);
  console.log(`  ${ACCENT(':mode smart')}           Auto-select model tier per prompt complexity`);
  console.log(`  ${ACCENT(':mode handoff')}         Direct handoffs (fast, no triage)`);
  console.log(`  ${ACCENT(':mode council')}         Full council deliberation`);
  console.log(`  ${ACCENT(':mode dispatch')}        Headless pipeline (Claude→Gemini→Codex)`);
  console.log(
    `  ${ACCENT(':mode economy')}         Set routing mode (economy|balanced|performance)`,
  );
  console.log(`  ${ACCENT(':model')}                Show mode & active models`);
  console.log(`  ${ACCENT(':model mode=economy')} Switch global mode`);
  console.log(`  ${ACCENT(':model claude=sonnet')} Override agent model`);
  console.log(`  ${ACCENT(':model reset')}         Clear all overrides`);
  console.log(`  ${ACCENT(':model:select')}         Interactive model picker`);
  console.log(
    `  ${ACCENT(':roles')}                Show role→agent→model mapping & recommendations`,
  );
  console.log(
    `  ${ACCENT(':roster')}               Edit role→agent→model assignments interactively`,
  );
  console.log(`  ${ACCENT(':persona')}              Edit personality settings interactively`);
  console.log(`  ${ACCENT(':persona show')}         Show current personality config`);
  console.log(
    `  ${ACCENT(':persona <preset>')}     Apply preset (default/professional/casual/analytical/terse)`,
  );
  console.log(`  ${ACCENT(':usage')}                Token usage & contingencies`);
  console.log(`  ${ACCENT(':stats')}                Agent metrics & performance`);
  console.log(
    `  ${ACCENT(':resume')}               Scan all resumable state (daemon, evolve, branches)`,
  );
  console.log(`  ${ACCENT(':pause [reason]')}       Pause the active session`);
  console.log(`  ${ACCENT(':unpause')}              Resume a paused session`);
  console.log(`  ${ACCENT(':fork')}                 Fork current session (explore alternatives)`);
  console.log(`  ${ACCENT(':spawn <focus>')}       Spawn child session (fresh context)`);
  console.log('');
}

function printTaskHandoffHelp(): void {
  console.log(pc.bold('Task & handoff management:'));
  console.log(`  ${ACCENT(':tasks')}                List active daemon tasks`);
  console.log(`  ${ACCENT(':tasks scan')}           Scan codebase for TODO/FIXME/issues`);
  console.log(`  ${ACCENT(':tasks run')}            Launch autonomous tasks runner`);
  console.log(`  ${ACCENT(':tasks review')}         Interactive branch review & merge`);
  console.log(`  ${ACCENT(':tasks status')}         Show latest tasks run report`);
  console.log(`  ${ACCENT(':tasks clean')}          Delete all tasks/* branches`);
  console.log(`  ${ACCENT(':handoffs')}             List pending & recent handoffs`);
  console.log(`  ${ACCENT(':cancel <id>')}          Cancel a task (e.g. :cancel T003)`);
  console.log(`  ${ACCENT(':clear')}                Interactive menu to select clear target`);
  console.log(`  ${ACCENT(':clear all')}            Cancel all tasks & ack all handoffs`);
  console.log(`  ${ACCENT(':clear tasks')}          Cancel all open tasks`);
  console.log(`  ${ACCENT(':clear handoffs')}       Ack all pending handoffs`);
  console.log(`  ${ACCENT(':clear concierge')}      Clear conversation history`);
  console.log(`  ${ACCENT(':clear metrics')}        Reset session metrics`);
  console.log(`  ${ACCENT(':clear screen')}         Clear terminal`);
  console.log(`  ${ACCENT(':archive')}              Archive completed work & trim events`);
  console.log(`  ${ACCENT(':events')}               Show recent event log`);
  console.log('');
}

function printWorkersAndConciergeHelp(): void {
  console.log(pc.bold('Workers:'));
  console.log(`  ${ACCENT(':workers')}              Show worker status (running/idle/stopped)`);
  console.log(`  ${ACCENT(':workers start [agent]')} Start worker(s)`);
  console.log(`  ${ACCENT(':workers stop [agent]')}  Stop worker(s)`);
  console.log(`  ${ACCENT(':workers restart')}      Restart all workers`);
  console.log(`  ${ACCENT(':workers mode <mode>')}  Change permission mode (auto-edit/full-auto)`);
  console.log(`  ${ACCENT(':watch <agent>')}        Open visible terminal for agent observation`);
  console.log('');
  console.log(pc.bold('Concierge (conversational AI):'));
  console.log(`  ${ACCENT(':chat')}                 Toggle concierge on/off`);
  console.log(`  ${ACCENT(':chat off')}             Disable concierge`);
  console.log(`  ${ACCENT(':chat reset')}           Clear conversation history`);
  console.log(`  ${ACCENT(':chat stats')}           Show token usage`);
  console.log(`  ${ACCENT(':chat model')}           Show active model & fallback chain`);
  console.log(`  ${ACCENT(':chat model <name>')}    Switch model (e.g. sonnet, flash, opus)`);
  console.log(`  ${ACCENT(':chat export')}          Export conversation to file`);
  console.log(`  ${ACCENT('!<prompt>')}             Force dispatch (bypass concierge)`);
  console.log('');
}

function printEvolveAndNightlyHelp(): void {
  console.log(pc.bold('Evolve (autonomous self-improvement):'));
  console.log(
    `  ${ACCENT(':evolve')}               Launch evolve session (research→plan→test→implement)`,
  );
  console.log(
    `  ${ACCENT(':evolve focus=<area>')}  Focus on specific area (e.g. testing-reliability)`,
  );
  console.log(`  ${ACCENT(':evolve max-rounds=N')} Limit rounds (default: 3)`);
  console.log(`  ${ACCENT(':evolve status')}        Show latest evolve session report`);
  console.log(`  ${ACCENT(':evolve resume')}        Resume an incomplete/interrupted session`);
  console.log(`  ${ACCENT(':evolve knowledge')}     Browse accumulated knowledge base`);
  console.log('');
  console.log(pc.bold('Actualize (experimental self-actualization):'));
  console.log(
    `  ${ACCENT(':actualize')}            Launch actualize run (branches only, no auto-merge)`,
  );
  console.log(
    `  ${ACCENT(':actualize dry-run')}    Scan + discover + prioritize without executing`,
  );
  console.log(`  ${ACCENT(':actualize review')}     Interactive branch review & merge`);
  console.log(`  ${ACCENT(':actualize status')}     Show latest actualize run report`);
  console.log(`  ${ACCENT(':actualize clean')}      Delete all actualize/* branches`);
  console.log('');
  console.log(pc.bold('Nightly (autonomous overnight tasks):'));
  console.log(`  ${ACCENT(':nightly')}              Launch nightly run (interactive setup)`);
  console.log(`  ${ACCENT(':nightly dry-run')}      Scan & prioritize without executing`);
  console.log(`  ${ACCENT(':nightly review')}       Interactive branch review & merge`);
  console.log(`  ${ACCENT(':nightly status')}       Show latest nightly run report`);
  console.log(`  ${ACCENT(':nightly clean')}        Delete all nightly/* branches`);
  console.log('');
}

function printGithubAndForgeHelp(): void {
  console.log(pc.bold('GitHub (requires gh CLI):'));
  console.log(`  ${ACCENT(':github')}               GitHub status (gh installed, auth, repo, PRs)`);
  console.log(`  ${ACCENT(':github prs')}           List open pull requests`);
  console.log(`  ${ACCENT(':pr create [branch]')}   Push branch & create pull request`);
  console.log(`  ${ACCENT(':pr list')}              List open pull requests`);
  console.log(`  ${ACCENT(':pr view <number>')}     Show PR details`);
  console.log('');
  console.log(pc.bold('Agent Forge (create custom agents):'));
  console.log(`  ${ACCENT(':forge')}                Interactive agent creation wizard`);
  console.log(`  ${ACCENT(':forge <description>')} Start forge with a goal description`);
  console.log(`  ${ACCENT(':forge list')}           List all forged agents`);
  console.log(`  ${ACCENT(':forge info <name>')}    Show forge details + metadata`);
  console.log(`  ${ACCENT(':forge test <name>')}    Test an existing forged agent`);
  console.log(`  ${ACCENT(':forge delete <name>')}  Remove a forged agent`);
  console.log(`  ${ACCENT(':forge edit <name>')}    Re-run refinement on an existing agent`);
  console.log('');
}

function printAgentsAndSystemHelp(): void {
  console.log(pc.bold('Agents & diagnostics:'));
  console.log(`  ${ACCENT(':agents')}               List all registered agents`);
  console.log(`  ${ACCENT(':agents add')}            Register a new custom agent (CLI or API)`);
  console.log(`  ${ACCENT(':agents remove <name>')}  Remove a custom agent`);
  console.log(`  ${ACCENT(':agents test <name>')}    Send a test prompt to verify agent works`);
  console.log(`  ${ACCENT(':agents info <name>')}   Show agent details & config`);
  console.log(`  ${ACCENT(':doctor')}               Diagnostic stats & recent log entries`);
  console.log(`  ${ACCENT(':doctor log')}           Show last 25 diagnostic entries`);
  console.log(`  ${ACCENT(':doctor fix')}           Auto-detect and fix issues`);
  console.log(`  ${ACCENT(':doctor config')}        Diff hydra.config.json against DEFAULT_CONFIG`);
  console.log(`  ${ACCENT(':doctor diagnose <text>')} Investigate a failure via GPT-5.3`);
  console.log(`  ${ACCENT(':kb')}                   Knowledge base stats & recent entries`);
  console.log(`  ${ACCENT(':kb <query>')}           Search knowledge base entries`);
  console.log(`  ${ACCENT(':cleanup')}              Scan & clean stale branches, tasks, artifacts`);
  console.log('');
  console.log(pc.bold('System:'));
  console.log(`  ${ACCENT(':sync')}                 Sync HYDRA.md → agent instruction files`);
  console.log(`  ${ACCENT(':confirm')}              Show/toggle dispatch confirmations`);
  console.log(
    `  ${ACCENT(':dry-run')}              Toggle dry-run mode (preview only, no tasks created)`,
  );
  console.log(`  ${ACCENT(':shutdown')}             Stop the daemon`);
  console.log(
    `  ${ACCENT(':quit')}                 Exit operator console  ${DIM('(alias: :exit)')}`,
  );
  console.log(`  ${DIM('<any text>')}             Dispatch as shared prompt`);
  console.log('');
  console.log(pc.bold('One-shot mode:'));
  console.log(DIM('  npm run hydra:go -- prompt="Your objective"'));
  console.log(DIM('  npm run hydra:go -- mode=council prompt="Your objective"'));
  console.log('');
}

export function printHelp(): void {
  console.log('');
  console.log(hydraLogoCompact());
  console.log(DIM('  Operator Console'));
  console.log('');
  printInteractiveCommandsHelp();
  printTaskHandoffHelp();
  printWorkersAndConciergeHelp();
  printEvolveAndNightlyHelp();
  printGithubAndForgeHelp();
  printAgentsAndSystemHelp();
}

export const KNOWN_COMMANDS = [
  ':help',
  ':status',
  ':sitrep',
  ':self',
  ':aware',
  ':mode',
  ':model',
  ':usage',
  ':stats',
  ':resume',
  ':pause',
  ':unpause',
  ':fork',
  ':spawn',
  ':tasks',
  ':handoffs',
  ':cancel',
  ':clear',
  ':archive',
  ':events',
  ':workers',
  ':watch',
  ':chat',
  ':evolve',
  ':nightly',
  ':actualize',
  ':github',
  ':pr',
  ':forge',
  ':confirm',
  ':dry-run',
  ':roster',
  ':persona',
  ':doctor',
  ':kb',
  ':agents',
  ':cleanup',
  ':shutdown',
  ':quit',
  ':exit',
  ':sync',
];

export const COMMAND_HELP: Partial<Record<string, CommandHelpEntry>> = {
  ':help': { usage: [':help'], desc: 'Show full help' },
  ':status': { usage: [':status'], desc: 'Dashboard with agents & tasks' },
  ':sitrep': { usage: [':sitrep'], desc: 'AI-narrated situation report' },
  ':self': {
    usage: [':self', ':self json'],
    desc: 'Hydra self snapshot (models, config, runtime state)',
  },
  ':aware': {
    usage: [':aware', ':aware status', ':aware on|off', ':aware minimal|full'],
    desc: 'Hyper-awareness injection (self snapshot/index) for concierge prompts',
  },
  ':mode': {
    usage: [':mode', ':mode auto|smart|handoff|council|dispatch'],
    desc: 'Show or switch orchestration mode',
  },
  ':model': {
    usage: [
      ':model',
      ':model mode=economy|balanced|performance',
      ':model <agent>=<model>',
      ':model <agent>=default',
      ':model reset',
    ],
    desc: 'Show or change active models',
  },
  ':model:select': {
    usage: [':model:select', ':model:select [agent]'],
    desc: 'Interactive model picker',
  },
  ':roles': {
    usage: [':roles'],
    desc: 'Show role→agent→model mapping & recommendations',
  },
  ':roster': { usage: [':roster'], desc: 'Interactive role→agent→model editor' },
  ':persona': {
    usage: [':persona', ':persona show', ':persona on|off', ':persona <preset>'],
    desc: 'Personality settings (presets: default/professional/casual/analytical/terse)',
  },
  ':usage': { usage: [':usage'], desc: 'Token usage & budget' },
  ':stats': { usage: [':stats'], desc: 'Agent metrics & performance' },
  ':resume': { usage: [':resume'], desc: 'Scan all resumable state (daemon, evolve, branches)' },
  ':pause': { usage: [':pause', ':pause [reason]'], desc: 'Pause the active session' },
  ':unpause': { usage: [':unpause'], desc: 'Resume a paused session' },
  ':fork': { usage: [':fork', ':fork [reason]'], desc: 'Fork current session' },
  ':spawn': { usage: [':spawn <focus>'], desc: 'Spawn child session with focus area' },
  ':tasks': {
    usage: [
      ':tasks',
      ':tasks scan',
      ':tasks run [args]',
      ':tasks review',
      ':tasks status',
      ':tasks clean',
    ],
    desc: 'Task management & autonomous runner',
  },
  ':handoffs': { usage: [':handoffs'], desc: 'List pending & recent handoffs' },
  ':cancel': { usage: [':cancel <id>'], desc: 'Cancel a task (e.g. :cancel T003)' },
  ':clear': {
    usage: [
      ':clear',
      ':clear all',
      ':clear tasks',
      ':clear handoffs',
      ':clear concierge',
      ':clear metrics',
      ':clear screen',
    ],
    desc: 'Clear/reset various state',
  },
  ':archive': { usage: [':archive'], desc: 'Archive completed work & trim events' },
  ':events': { usage: [':events'], desc: 'Show recent event log' },
  ':workers': {
    usage: [
      ':workers',
      ':workers start [agent]',
      ':workers stop [agent]',
      ':workers restart [agent]',
      ':workers mode auto-edit|full-auto',
    ],
    desc: 'Worker management',
  },
  ':watch': { usage: [':watch <agent>'], desc: 'Open visible terminal for agent observation' },
  ':chat': {
    usage: [
      ':chat',
      ':chat off',
      ':chat reset',
      ':chat stats',
      ':chat model',
      ':chat model <name>',
      ':chat export',
    ],
    desc: 'Concierge (conversational AI)',
  },
  ':evolve': {
    usage: [
      ':evolve',
      ':evolve focus=<area>',
      ':evolve max-rounds=N',
      ':evolve status',
      ':evolve resume [args]',
      ':evolve knowledge',
    ],
    desc: 'Autonomous self-improvement',
  },
  ':nightly': {
    usage: [':nightly', ':nightly dry-run', ':nightly review', ':nightly status', ':nightly clean'],
    desc: 'Autonomous overnight tasks',
  },
  ':actualize': {
    usage: [
      ':actualize',
      ':actualize dry-run',
      ':actualize review',
      ':actualize status',
      ':actualize clean',
    ],
    desc: 'Self-actualization runner (branches only, no auto-merge)',
  },
  ':github': { usage: [':github', ':github prs'], desc: 'GitHub status & pull requests' },
  ':pr': {
    usage: [':pr create [branch]', ':pr list', ':pr view <number>'],
    desc: 'Pull request management',
  },
  ':forge': {
    usage: [
      ':forge',
      ':forge <description>',
      ':forge list',
      ':forge info <name>',
      ':forge test <name>',
      ':forge delete <name>',
      ':forge edit <name>',
    ],
    desc: 'Custom agent creation',
  },
  ':agents': {
    usage: [
      ':agents',
      ':agents list [virtual|physical|all]',
      ':agents info <name>',
      ':agents add',
      ':agents remove <name>',
      ':agents test <name>',
      ':agents enable <name>',
      ':agents disable <name>',
    ],
    desc: 'Agent registry management — list, add, remove, test, enable/disable agents',
  },
  ':doctor': {
    usage: [':doctor', ':doctor log', ':doctor fix', ':doctor config', ':doctor diagnose <text>'],
    desc: 'Diagnostics & self-healing',
  },
  ':kb': { usage: [':kb', ':kb <query>'], desc: 'Knowledge base stats & search' },
  ':cleanup': { usage: [':cleanup'], desc: 'Scan & clean stale branches, tasks, artifacts' },
  ':sync': { usage: [':sync'], desc: 'Sync HYDRA.md → agent instruction files' },
  ':confirm': {
    usage: [':confirm', ':confirm on|off'],
    desc: 'Show/toggle dispatch confirmations',
  },
  ':dry-run': {
    usage: [':dry-run', ':dry-run on|off'],
    desc: 'Toggle dry-run mode (preview dispatches without executing)',
  },
  ':shutdown': { usage: [':shutdown'], desc: 'Stop the daemon' },
  ':quit': { usage: [':quit'], desc: 'Exit operator console (alias: :exit)' },
  ':exit': { usage: [':exit'], desc: 'Exit operator console (alias: :quit)' },
};

export function printCommandHelp(cmd: string): void {
  const help = COMMAND_HELP[cmd];
  if (!help) {
    console.log(`  ${DIM('No help available for')} ${ACCENT(cmd)}`);
    return;
  }

  console.log('');
  console.log(`  ${ACCENT(cmd)} ${DIM('—')} ${help.desc}`);
  console.log('');
  for (const usage of help.usage) {
    console.log(`    ${pc.white(usage)}`);
  }
  console.log('');
}

export function getSelfAwarenessSummary(
  sa: SelfAwarenessConfig | null | undefined = {},
): SelfAwarenessSummary {
  const obj = sa ?? {};
  const enabled = obj.enabled !== false;
  const includeSnapshot = obj.includeSnapshot !== false;
  const includeIndex = obj.includeIndex !== false;

  if (!enabled) {
    return { enabled, includeSnapshot, includeIndex, level: 'off' };
  }
  if (includeIndex) {
    return { enabled, includeSnapshot, includeIndex, level: 'full' };
  }
  return { enabled, includeSnapshot, includeIndex, level: 'minimal' };
}

export function printSelfAwarenessStatus(sa: SelfAwarenessConfig = {}): void {
  const summary = getSelfAwarenessSummary(sa);
  const value = summary.enabled ? pc.green(summary.level) : pc.red('off');
  console.log(label('Hyper-awareness', value));
  console.log(
    DIM(
      `  snapshot: ${summary.includeSnapshot ? 'on' : 'off'} (maxLines=${String(sa.snapshotMaxLines ?? 80)})`,
    ),
  );
  console.log(
    DIM(
      `  index: ${summary.includeIndex ? 'on' : 'off'} (maxChars=${String(sa.indexMaxChars ?? 7000)}, refreshMs=${String(sa.indexRefreshMs ?? 300_000)})`,
    ),
  );
}
