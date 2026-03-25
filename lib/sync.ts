/**
 * Multi-agent synchronization CLI for Gemini + Codex + Claude Code.
 *
 * Canonical state:
 * - <project>/docs/coordination/AI_SYNC_STATE.json
 * - <project>/docs/coordination/AI_SYNC_LOG.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSyncCapture } from './hydra-proc.ts';
import { getCurrentBranch as getCurrentBranchGit } from './hydra-shared/git-ops.ts';
import { resolveProject } from './hydra-config.ts';
import { getAgentInstructionFile } from './hydra-sync-md.ts';
import { exit } from './hydra-process.ts';

interface AgentRecord {
  installed: boolean | null;
  path: string;
  version: string;
  lastCheckedAt: string | null;
}

interface ActiveSession {
  id: string;
  focus: string;
  owner: string;
  branch: string;
  participants: string[];
  status: string;
  startedAt: string;
  updatedAt: string;
}

interface TaskItem {
  id?: string;
  title?: string;
  owner?: string;
  status?: string;
  files?: string[];
  notes?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

interface DecisionItem {
  id?: string;
  title?: string;
  owner?: string;
  rationale?: string;
  impact?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface BlockerItem {
  id?: string;
  title?: string;
  owner?: string;
  status?: string;
  nextStep?: string;
  createdAt?: string;
  [key: string]: unknown;
}

interface HandoffItem {
  id?: string;
  from?: string;
  to?: string;
  summary?: string;
  nextStep?: string;
  tasks?: string[];
  createdAt?: string;
  [key: string]: unknown;
}

interface SyncState {
  schemaVersion: number;
  project: string;
  updatedAt: string;
  activeSession: ActiveSession | null;
  agents: {
    codex: AgentRecord;
    claude: AgentRecord;
    gemini: AgentRecord;
    [key: string]: AgentRecord;
  };
  tasks: TaskItem[];
  decisions: DecisionItem[];
  blockers: BlockerItem[];
  handoffs: HandoffItem[];
}

type CliOptions = Record<string, string | boolean>;

const config = resolveProject();
const ROOT = config.projectRoot;
const COORD_DIR = config.coordDir;
const STATE_PATH = config.statePath;
const LOG_PATH = config.logPath;

const STATUS_VALUES = new Set(['todo', 'in_progress', 'blocked', 'done', 'failed', 'cancelled']);

function nowIso() {
  return new Date().toISOString();
}

function toSessionId(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `SYNC_${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function createAgentRecord(): AgentRecord {
  return {
    installed: null,
    path: '',
    version: '',
    lastCheckedAt: null,
  };
}

function createDefaultState(): SyncState {
  return {
    schemaVersion: 1,
    project: config.projectName,
    updatedAt: nowIso(),
    activeSession: null,
    agents: {
      codex: createAgentRecord(),
      claude: createAgentRecord(),
      gemini: createAgentRecord(),
    },
    tasks: [],
    decisions: [],
    blockers: [],
    handoffs: [],
  };
}

function normalizeState(raw: unknown): SyncState {
  const defaults = createDefaultState();
  const safe = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const safeAgents =
    typeof safe['agents'] === 'object' && safe['agents'] !== null
      ? (safe['agents'] as Record<string, unknown>)
      : {};

  return {
    ...defaults,
    ...safe,
    agents: {
      ...defaults.agents,
      ...(safeAgents as Record<string, AgentRecord>),
      codex: {
        ...defaults.agents.codex,
        ...(typeof safeAgents['codex'] === 'object' && safeAgents['codex'] !== null
          ? (safeAgents['codex'] as Partial<AgentRecord>)
          : {}),
      },
      claude: {
        ...defaults.agents.claude,
        ...(typeof safeAgents['claude'] === 'object' && safeAgents['claude'] !== null
          ? (safeAgents['claude'] as Partial<AgentRecord>)
          : {}),
      },
      gemini: {
        ...defaults.agents.gemini,
        ...(typeof safeAgents['gemini'] === 'object' && safeAgents['gemini'] !== null
          ? (safeAgents['gemini'] as Partial<AgentRecord>)
          : {}),
      },
    },
    tasks: Array.isArray(safe['tasks']) ? (safe['tasks'] as TaskItem[]) : [],
    decisions: Array.isArray(safe['decisions']) ? (safe['decisions'] as DecisionItem[]) : [],
    blockers: Array.isArray(safe['blockers']) ? (safe['blockers'] as BlockerItem[]) : [],
    handoffs: Array.isArray(safe['handoffs']) ? (safe['handoffs'] as HandoffItem[]) : [],
  } as SyncState;
}

function ensureCoordFiles() {
  if (!fs.existsSync(COORD_DIR)) {
    fs.mkdirSync(COORD_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_PATH)) {
    const state = createDefaultState();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  if (!fs.existsSync(LOG_PATH)) {
    const lines = [
      '# AI Sync Log',
      '',
      `Created: ${nowIso()}`,
      '',
      'Use `npm run hydra:summary` to see current state.',
      '',
    ];
    fs.writeFileSync(LOG_PATH, `${lines.join('\n')}\n`, 'utf8');
  }
}

function readState(): SyncState {
  ensureCoordFiles();
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return normalizeState(raw);
  } catch (err) {
    console.error(`Failed to read ${path.relative(ROOT, STATE_PATH)}: ${(err as Error).message}`);
    exit(1);
  }
}

function writeState(state: SyncState): void {
  const next = normalizeState(state);
  next.updatedAt = nowIso();
  if (next.activeSession?.status === 'active') {
    next.activeSession.updatedAt = next.updatedAt;
  }
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function appendLog(entry: string): void {
  ensureCoordFiles();
  fs.appendFileSync(LOG_PATH, `- ${nowIso()} | ${entry}\n`, 'utf8');
}

function parseList(value: unknown): string[] {
  if (typeof value !== 'string' || value === '') {
    return [];
  }
  return value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCli(argv: string[]) {
  const [command = 'help', ...rest] = argv.slice(2);
  const options: CliOptions = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];

    if (token.includes('=') && !token.startsWith('--')) {
      const [rawKey, ...rawValue] = token.split('=');
      const key = rawKey.trim();
      if (key !== '') {
        options[key] = rawValue.join('=').trim();
      }
      continue;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const maybeInline = token.slice(2);
    if (maybeInline.includes('=')) {
      const [rawKey, ...rawValue] = maybeInline.split('=');
      options[rawKey] = rawValue.join('=');
      continue;
    }

    const key = maybeInline;
    const maybeValue = rest[i + 1];
    if (maybeValue === '' || maybeValue.startsWith('--') || maybeValue.includes('=')) {
      options[key] = true;
      continue;
    }

    options[key] = maybeValue;
    i += 1;
  }

  return { command, options, positionals };
}

function getOptionValue(
  options: CliOptions,
  positionals: string[],
  key: string,
  positionIndex: number,
  defaultValue = '',
): string {
  const opt = options[key];
  if (typeof opt === 'string') {
    return opt;
  }
  const pos = positionals[positionIndex];
  if (pos !== '') {
    return pos;
  }
  return defaultValue;
}

function getRequiredOption(
  options: CliOptions,
  positionals: string[],
  key: string,
  positionIndex: number,
  helpHint = '',
): string {
  const value = getOptionValue(options, positionals, key, positionIndex, '');
  if (value === '') {
    const extra = helpHint === '' ? '' : `\n${helpHint}`;
    console.error(`Missing required option --${key}.${extra}`);
    exit(1);
  }
  return value;
}

function nextId(prefix: string, items: Array<{ id?: string | null }>): string {
  let max = 0;
  const pattern = new RegExp(`^${prefix}(\\d+)$`);

  for (const item of items) {
    const match = (item.id ?? '').match(pattern);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }

  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

function getCurrentBranch() {
  const branch = getCurrentBranchGit(ROOT);
  return branch === '' ? 'unknown' : branch;
}

function detectCommand(name: string) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSyncCapture(cmd, [name], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 || r.stdout.trim() === '') {
    return { installed: false, path: '' };
  }
  const firstPath = r.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  return { installed: true, path: firstPath };
}

function detectVersion(name: string, customCommand: string) {
  const command = customCommand === '' ? `${name} --version` : customCommand;
  // If the command contains quotes or the executable token itself contains a space
  // (e.g. "C:\Program Files\node\node.exe"), fall back to shell parsing.
  const firstToken = command.split(/\s/)[0];
  const needsShell = /["']/.test(command) || /\s/.test(firstToken);
  if (needsShell) {
    const r = spawnSyncCapture(command, [], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      shell: true,
    });
    return r.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  }
  const parts = command.split(/\s+/).filter(Boolean);
  const exe = parts[0];
  const args = parts.slice(1);
  const r = spawnSyncCapture(exe, args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.stdout.split(/\r?\n/)[0]?.trim() ?? '';
}

function printHelp() {
  console.log(`
Hydra Multi-Agent Sync CLI

Usage:
  node sync.mjs <command> [options]

Commands:
  help                Show this help
  init                Create coordination files if missing
  doctor              Detect local Gemini/Codex/Claude tooling
  start               Start a new shared session
  task:add            Add a task
  task:update         Update a task
  decision:add        Record an important decision
  blocker:add         Record a blocker
  handoff             Record handoff notes between agents
  summary             Print current shared state summary
  prompt              Print copy/paste prompt for an agent

Project: ${config.projectName} (${config.projectRoot})
`);
}

function ensureStatus(status: string) {
  if (!STATUS_VALUES.has(status)) {
    console.error(
      `Invalid status "${status}". Use one of: ${Array.from(STATUS_VALUES).join(', ')}`,
    );
    exit(1);
  }
}

function commandInit() {
  ensureCoordFiles();
  const state = readState();
  writeState(state);
  appendLog('Initialized coordination files');

  console.log('Initialized multi-agent sync files:');
  console.log(`- ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`- ${path.relative(ROOT, LOG_PATH)}`);
}

function commandDoctor() {
  const checks = [
    { key: 'codex', command: 'codex', versionCommand: 'codex --version' },
    { key: 'claude', command: 'claude', versionCommand: 'claude --version' },
    { key: 'gemini', command: 'gemini', versionCommand: 'gemini --version' },
    { key: 'gcloud', command: 'gcloud', versionCommand: 'gcloud --version' },
  ];

  const state = readState();
  const checkedAt = nowIso();

  console.log('Tooling check:');
  for (const item of checks) {
    const detected = detectCommand(item.command);
    const version = detected.installed ? detectVersion(item.command, item.versionCommand) : '';

    if (item.key === 'gcloud') {
      console.log(
        `- ${item.key.padEnd(7)} installed=${String(detected.installed).padEnd(5)} path=${detected.path === '' ? 'n/a' : detected.path}${
          version === '' ? '' : ` version=${version}`
        }`,
      );
      continue;
    }

    state.agents[item.key] = {
      installed: detected.installed,
      path: detected.path,
      version,
      lastCheckedAt: checkedAt,
    };

    console.log(
      `- ${item.key.padEnd(7)} installed=${String(detected.installed).padEnd(5)} path=${detected.path === '' ? 'n/a' : detected.path}${
        version === '' ? '' : ` version=${version}`
      }`,
    );
  }

  writeState(state);
  appendLog('Ran tooling doctor');

  if (state.agents.gemini.installed !== true) {
    console.log('\nGemini CLI was not detected on PATH.');
    console.log('You can still use Gemini Pro via web by pasting output from prompt command.');
  }
}

function commandStart(options: CliOptions, positionals: string[]) {
  const focus = getRequiredOption(
    options,
    positionals,
    'focus',
    0,
    'Example: --focus "Stabilize auth callback flow" or focus="Stabilize auth callback flow"',
  );
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const branch = getOptionValue(options, positionals, 'branch', 2, getCurrentBranch());
  const participants = parseList(
    getOptionValue(options, positionals, 'participants', 3, 'human,codex,claude'),
  );

  const state = readState();
  const now = nowIso();
  const session = {
    id: toSessionId(),
    focus,
    owner,
    branch,
    participants,
    status: 'active',
    startedAt: now,
    updatedAt: now,
  };

  state.activeSession = session;
  writeState(state);
  appendLog(`Started session ${session.id} | focus="${focus}" | owner=${owner} | branch=${branch}`);

  console.log(`Started session ${session.id}`);
  console.log(`Focus: ${focus}`);
  console.log(`Branch: ${branch}`);
  const participantList = participants.join(', ');
  console.log(`Participants: ${participantList === '' ? 'none' : participantList}`);
}

function commandTaskAdd(options: CliOptions, positionals: string[]) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'unassigned');
  const status = getOptionValue(options, positionals, 'status', 2, 'todo');
  const files = parseList(getOptionValue(options, positionals, 'files', 3, ''));
  const notes = getOptionValue(options, positionals, 'notes', 4, '');
  ensureStatus(status);

  const state = readState();
  const task = {
    id: nextId('T', state.tasks),
    title,
    owner,
    status,
    files,
    notes,
    updatedAt: nowIso(),
  };

  state.tasks.push(task);
  writeState(state);
  appendLog(`Added task ${task.id} | status=${status} | owner=${owner} | title="${title}"`);

  console.log(`Added ${task.id}: ${task.title}`);
}

function resolveFieldFromOptionOrPositional(
  options: CliOptions,
  key: string,
  positional: string | undefined,
): string {
  if (typeof options[key] === 'string') return options[key];
  if (positional !== undefined) return positional;
  return '';
}

function resolveStatusField(options: CliOptions, positionalStatus: string | undefined): string {
  const fromOption = typeof options['status'] === 'string' ? options['status'] : '';
  const fromPositional =
    positionalStatus !== undefined && positionalStatus !== '' && STATUS_VALUES.has(positionalStatus)
      ? positionalStatus
      : '';
  return fromOption === '' ? fromPositional : fromOption;
}

function resolveOwnerField(
  options: CliOptions,
  positionalOwner: string | undefined,
  positionalStatus: string | undefined,
): string {
  const fromOption = typeof options['owner'] === 'string' ? options['owner'] : '';
  let fromPositional = '';
  if (
    positionalOwner !== undefined &&
    positionalOwner !== '' &&
    !STATUS_VALUES.has(positionalOwner)
  ) {
    fromPositional = positionalOwner;
  } else if (
    positionalStatus !== undefined &&
    positionalStatus !== '' &&
    !STATUS_VALUES.has(positionalStatus)
  ) {
    fromPositional = positionalStatus;
  }
  return fromOption === '' ? fromPositional : fromOption;
}

function commandTaskUpdate(options: CliOptions, positionals: string[]) {
  const id = getRequiredOption(options, positionals, 'id', 0);
  const state = readState();
  const task = state.tasks.find((item) => item.id === id);

  if (!task) {
    console.error(`Task ${id} not found.`);
    exit(1);
  }

  const nextTitle = getOptionValue(options, positionals, 'title', 5, '');
  if (nextTitle !== '') {
    task.title = nextTitle;
  }

  const nextStatus = resolveStatusField(options, positionals[1]);
  if (nextStatus !== '') {
    ensureStatus(nextStatus);
    task.status = nextStatus;
  }

  const nextOwner = resolveOwnerField(options, positionals[2], positionals[1]);
  if (nextOwner !== '') {
    task.owner = nextOwner;
  }

  const nextFilesRaw = resolveFieldFromOptionOrPositional(options, 'files', positionals[4]);
  if (nextFilesRaw !== '') {
    task.files = parseList(nextFilesRaw);
  }

  const nextNoteRaw = resolveFieldFromOptionOrPositional(options, 'notes', positionals[3]);
  if (nextNoteRaw !== '') {
    task.notes =
      task.notes != null && task.notes !== '' ? `${task.notes}\n${nextNoteRaw}` : nextNoteRaw;
  }

  task.updatedAt = nowIso();
  writeState(state);
  appendLog(
    `Updated task ${task.id ?? ''} | status=${task.status ?? ''} | owner=${task.owner ?? ''}`,
  );

  console.log(`Updated ${task.id ?? ''}`);
}

function commandDecisionAdd(options: CliOptions, positionals: string[]) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const rationale = getOptionValue(options, positionals, 'rationale', 2, '');
  const impact = getOptionValue(options, positionals, 'impact', 3, '');

  const state = readState();
  const decision = {
    id: nextId('D', state.decisions),
    title,
    rationale,
    impact,
    owner,
    createdAt: nowIso(),
  };

  state.decisions.push(decision);
  writeState(state);
  appendLog(`Recorded decision ${decision.id} | owner=${owner} | title="${title}"`);

  console.log(`Recorded ${decision.id}`);
}

function commandBlockerAdd(options: CliOptions, positionals: string[]) {
  const title = getRequiredOption(options, positionals, 'title', 0);
  const owner = getOptionValue(options, positionals, 'owner', 1, 'human');
  const nextStep = getOptionValue(options, positionals, 'next-step', 2, '');

  const state = readState();
  const blocker = {
    id: nextId('B', state.blockers),
    title,
    owner,
    status: 'open',
    nextStep,
    createdAt: nowIso(),
  };

  state.blockers.push(blocker);
  writeState(state);
  appendLog(`Added blocker ${blocker.id} | owner=${owner} | title="${title}"`);

  console.log(`Recorded ${blocker.id}`);
}

function commandHandoff(options: CliOptions, positionals: string[]) {
  const from = getRequiredOption(options, positionals, 'from', 0);
  const to = getRequiredOption(options, positionals, 'to', 1);
  const summary = getRequiredOption(options, positionals, 'summary', 2);
  const nextStep = getOptionValue(options, positionals, 'next-step', 3, '');
  const relatedTasks = parseList(getOptionValue(options, positionals, 'tasks', 4, ''));

  const state = readState();
  const handoff = {
    id: nextId('H', state.handoffs),
    from,
    to,
    summary,
    nextStep,
    tasks: relatedTasks,
    createdAt: nowIso(),
  };

  state.handoffs.push(handoff);
  writeState(state);
  appendLog(
    `Added handoff ${handoff.id} | ${from} -> ${to} | tasks=${relatedTasks.join(',') === '' ? 'none' : relatedTasks.join(',')}`,
  );

  console.log(`Recorded ${handoff.id}`);
}

function formatTask(task: TaskItem): string {
  return `${task.id ?? ''} [${task.status ?? ''}] owner=${task.owner ?? ''} :: ${task.title ?? ''}`;
}

function renderBlockers(blockers: BlockerItem[]): void {
  if (blockers.length === 0) {
    console.log('- none');
    return;
  }
  for (const blocker of blockers) {
    console.log(`- ${blocker.id ?? ''} owner=${blocker.owner ?? ''} :: ${blocker.title ?? ''}`);
    if (blocker.nextStep != null && blocker.nextStep !== '') {
      console.log(`  next: ${blocker.nextStep}`);
    }
  }
}

function renderDecisions(decisions: DecisionItem[]): void {
  if (decisions.length === 0) {
    console.log('- none');
    return;
  }
  for (const decision of decisions) {
    console.log(`- ${decision.id ?? ''} owner=${decision.owner ?? ''} :: ${decision.title ?? ''}`);
  }
}

function renderLatestHandoff(handoff: HandoffItem | undefined): void {
  if (handoff == null) {
    console.log('- none');
    return;
  }
  console.log(`- ${handoff.id ?? ''} ${handoff.from ?? ''} -> ${handoff.to ?? ''}`);
  console.log(`  summary: ${handoff.summary ?? ''}`);
  if (handoff.nextStep != null && handoff.nextStep !== '') {
    console.log(`  next: ${handoff.nextStep}`);
  }
}

function commandSummary() {
  const state = readState();
  const openTasks = state.tasks.filter(
    (task) => !['done', 'cancelled'].includes(task.status ?? ''),
  );
  const activeBlockers = state.blockers.filter((blocker) => blocker.status !== 'resolved');
  const recentDecisions = state.decisions.slice(-3);
  const recentHandoff = state.handoffs.at(-1);

  console.log(`Hydra Sync Summary (${config.projectName})`);
  console.log(`State: ${path.relative(ROOT, STATE_PATH)}`);
  console.log(`Log:   ${path.relative(ROOT, LOG_PATH)}`);
  console.log(`Updated: ${state.updatedAt}`);

  if (state.activeSession) {
    console.log('\nActive Session');
    console.log(`- id: ${state.activeSession.id}`);
    console.log(`- focus: ${state.activeSession.focus}`);
    console.log(`- owner: ${state.activeSession.owner}`);
    console.log(`- branch: ${state.activeSession.branch}`);
    console.log(`- participants: ${state.activeSession.participants.join(', ')}`);
  } else {
    console.log('\nActive Session');
    console.log('- none');
  }

  console.log(`\nOpen Tasks (${String(openTasks.length)})`);
  if (openTasks.length === 0) {
    console.log('- none');
  } else {
    for (const task of openTasks) {
      console.log(`- ${formatTask(task)}`);
    }
  }

  console.log(`\nOpen Blockers (${String(activeBlockers.length)})`);
  renderBlockers(activeBlockers);

  console.log(`\nRecent Decisions (${String(recentDecisions.length)})`);
  renderDecisions(recentDecisions);

  console.log('\nLatest Handoff');
  renderLatestHandoff(recentHandoff);
}

function buildPrompt(agent: string, state: SyncState): string {
  const labelByAgent: Record<string, string> = {
    codex: 'Codex',
    claude: 'Claude Code',
    gemini: 'Gemini Pro',
    generic: 'AI Assistant',
  };
  const agentLabel = labelByAgent[agent] ?? 'AI Assistant';

  const openTasks = state.tasks
    .filter((task) => !['done', 'cancelled'].includes(task.status ?? ''))
    .slice(0, 8)
    .map((task) => `- ${formatTask(task)}`)
    .join('\n');

  const instructionFile = getAgentInstructionFile(agent, ROOT);

  return [
    `You are ${agentLabel} collaborating in the ${config.projectName} repository with Gemini Pro, Codex, and Claude Code.`,
    '',
    'Read these files first:',
    `1) ${instructionFile}`,
    '2) docs/QUICK_REFERENCE.md',
    '3) docs/coordination/AI_SYNC_STATE.json',
    '4) docs/coordination/AI_SYNC_LOG.md',
    '',
    'Rules for this run:',
    '- Do not start edits until you claim a task in AI_SYNC_STATE.json.',
    '- Update task status when moving to in_progress, blocked, or done.',
    '- Record important decisions and blockers in AI_SYNC_STATE.json.',
    '- Before handing off, add a handoff entry with what changed and next step.',
    '',
    `Current focus: ${state.activeSession?.focus ?? 'not set'}`,
    `Current branch: ${state.activeSession?.branch ?? getCurrentBranch()}`,
    '',
    'Open tasks:',
    openTasks === '' ? '- none' : openTasks,
  ].join('\n');
}

function commandPrompt(options: CliOptions, positionals: string[]) {
  const agent = getOptionValue(options, positionals, 'agent', 0, 'generic').toLowerCase();
  const state = readState();
  console.log(buildPrompt(agent, state));
}

function main() {
  const { command, options, positionals } = parseCli(process.argv);

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    case 'init':
      commandInit();
      return;
    case 'doctor':
      commandDoctor();
      return;
    case 'start':
      commandStart(options, positionals);
      return;
    case 'task:add':
      commandTaskAdd(options, positionals);
      return;
    case 'task:update':
      commandTaskUpdate(options, positionals);
      return;
    case 'decision:add':
      commandDecisionAdd(options, positionals);
      return;
    case 'blocker:add':
      commandBlockerAdd(options, positionals);
      return;
    case 'handoff':
      commandHandoff(options, positionals);
      return;
    case 'summary':
      commandSummary();
      return;
    case 'prompt':
      commandPrompt(options, positionals);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      exit(1);
  }
}

main();
