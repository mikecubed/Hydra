/**
 * Hydra single-terminal dispatch runner.
 *
 * Runs one prompt across:
 * 1) Coordinator (coordination/delegation)
 * 2) Critic (critique/second-opinion)
 * 3) Synthesizer (final synthesis in read-only mode)
 *
 * Usage:
 *   node lib/hydra-dispatch.ts prompt="Your request"
 *   node lib/hydra-dispatch.ts prompt="Your request" mode=preview
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentContext } from './hydra-context.ts';
import { getAgent, getMode, setMode } from './hydra-agents.ts';
import { DISPATCH_PREFERENCE_ORDER } from './hydra-routing-constants.ts';
import { resolveProject, getRoleConfig, loadHydraConfig } from './hydra-config.ts';
import {
  nowIso,
  runId,
  parseArgs,
  getPrompt,
  boolFlag,
  short,
  parseJsonLoose,
  ensureDir,
} from './hydra-utils.ts';
import { DefaultAgentExecutor, type IAgentExecutor } from './hydra-shared/agent-executor.ts';
import {
  sectionHeader,
  label,
  colorAgent,
  createSpinner,
  SUCCESS,
  ERROR,
  WARNING,
  DIM,
} from './hydra-ui.ts';
import { checkUsage } from './hydra-usage.ts';
import { isPersonaEnabled, getAgentFraming } from './hydra-persona.ts';
import { detectInstalledCLIs } from './hydra-cli-detect.ts';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;

const DEFAULT_DAEMON_URL = process.env['AI_ORCH_URL'] ?? 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };

// Module-level executor — replace via setDispatchExecutor() for testing
let _dispatchExecutor: IAgentExecutor = new DefaultAgentExecutor();

/** Override the agent executor used by this module (primarily for testing).
 *  Returns the displaced executor so callers can restore it in teardown:
 *  `const prev = setDispatchExecutor(mock); ... setDispatchExecutor(prev)` */
export function setDispatchExecutor(executor: IAgentExecutor): IAgentExecutor {
  const previous = _dispatchExecutor;
  _dispatchExecutor = executor;
  return previous;
}

function usageGuard(_agent: string) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = (MODE_DOWNSHIFT as Record<string, string | undefined>)[currentMode];
      if (nextMode == null || nextMode === '') {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode`,
          ),
        );
      } else {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}`,
          ),
        );
        setMode(nextMode);
      }
    } else if (usage.level === 'warning') {
      console.log(DIM(`  \u26A0 Token usage at ${usage.percent.toFixed(1)}%`));
    }
  } catch {
    /* non-critical */
  }
}

async function callAgent(agent: string, prompt: string, timeoutMs: number, model?: string | null) {
  usageGuard(agent);
  return _dispatchExecutor.executeAgent(agent, prompt, {
    cwd: config.projectRoot,
    timeoutMs,
    ...(model == null ? {} : { modelOverride: model }),
  });
}

async function fetchDaemonSummary(baseUrl: string) {
  try {
    const response = await fetch(`${baseUrl}/summary`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return (payload as Record<string, unknown>)['summary'] ?? null;
  } catch {
    return null;
  }
}

function resolvePreferredAgentName(
  preferred: string,
  cfg: ReturnType<typeof loadHydraConfig>,
  installedCLIs: Record<string, boolean | undefined>,
): string | null {
  if (preferred === 'local') {
    return cfg.local.enabled ? preferred : null;
  }
  const agentDef = getAgent(preferred);
  if (agentDef?.enabled !== true) return null;
  const needsCli = agentDef.cli !== null && agentDef.cli !== undefined;
  if (!needsCli || installedCLIs[preferred] === true) return preferred;
  return null;
}

function findAgentFromPreferenceOrder(
  installedCLIs: Record<string, boolean | undefined>,
  cfg: ReturnType<typeof loadHydraConfig>,
): string | null {
  for (const name of DISPATCH_PREFERENCE_ORDER) {
    if (name === 'local') {
      if (cfg.local.enabled) return name;
    } else if (installedCLIs[name] === true) {
      try {
        const agentDef = getAgent(name);
        if (agentDef && (agentDef as { enabled?: boolean }).enabled !== false) {
          return name;
        }
      } catch {
        // Unknown agent name in preference order — skip
      }
    }
  }
  return null;
}

function findAnyInstalledAgentName(
  installedCLIs: Record<string, boolean | undefined>,
  cfg: ReturnType<typeof loadHydraConfig>,
): string | null {
  for (const [name, v] of Object.entries(installedCLIs)) {
    if (v !== true) continue;
    if (name === 'local') {
      if (cfg.local.enabled) return name;
      continue;
    }
    try {
      const agentDef = getAgent(name);
      if (agentDef && (agentDef as { enabled?: boolean }).enabled !== false) {
        return name;
      }
    } catch {
      // Unknown agent — skip
    }
  }
  return null;
}

/**
 * Resolve the agent name for a dispatch role, with installed-CLI fallback.
 *
 * Resolution order:
 *   1. roles.<roleName>.agent from config (user override)
 *   2. DEFAULT_CONFIG.roles.<roleName>.agent (built-in default via getRoleConfig)
 *   3. First available agent from DISPATCH_PREFERENCE_ORDER
 *
 * @param roleName     - 'coordinator' | 'critic' | 'synthesizer' (or any role name)
 * @param installedCLIs - output of detectInstalledCLIs()
 */
export function getRoleAgent(
  roleName: string,
  installedCLIs: Record<string, boolean | undefined>,
): string {
  const cfg = loadHydraConfig();
  const roleCfg = getRoleConfig(roleName);
  const preferred = roleCfg?.agent;

  if (preferred != null && preferred !== '') {
    const resolved = resolvePreferredAgentName(preferred, cfg, installedCLIs);
    if (resolved !== null) return resolved;
  }

  const fromPreference = findAgentFromPreferenceOrder(installedCLIs, cfg);
  if (fromPreference !== null) return fromPreference;

  const anyAgent = findAnyInstalledAgentName(installedCLIs, cfg);
  if (anyAgent !== null) return anyAgent;

  throw new Error('No agents available: install at least one agent CLI or enable local');
}

function buildCoordinatorPrompt(agentName: string, userPrompt: string, daemonSummary: unknown) {
  const agentConfig = getAgent(agentName);
  const schemaHint = {
    understanding: 'string',
    delegation: {
      critic_prompt: 'string',
      synthesizer_prompt: 'string',
      task_splits: [
        {
          owner: 'string',
          title: 'string',
          definition_of_done: 'string',
        },
      ],
    },
    risks: ['string'],
    next_actions: ['string'],
  };

  return [
    `${isPersonaEnabled() ? getAgentFraming(agentName) : `You are ${agentConfig?.label ?? agentName}`} Acting as coordinator for ${config.projectName}.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    buildAgentContext(agentName, {}, config, userPrompt),
    '',
    'Create a high-quality delegation plan for the critic and synthesizer agents.',
    'Return ONLY JSON (no markdown) matching this shape:',
    JSON.stringify(schemaHint, null, 2),
    '',
    `User request: ${userPrompt}`,
    '',
    'Current Hydra summary (may be null):',
    JSON.stringify(daemonSummary, null, 2),
    '',
    'Requirements:',
    '1) Generate specific prompts for the critic and synthesizer.',
    '2) Split work into concrete, non-overlapping tasks.',
    '3) Include risk checks and execution order.',
    '4) Create detailed task specs (file paths, signatures, DoD).',
  ].join('\n');
}

function buildCriticPrompt(
  agentName: string,
  userPrompt: string,
  coordinatorOutput: unknown,
  daemonSummary: unknown,
) {
  const agentConfig = getAgent(agentName);

  return [
    `${isPersonaEnabled() ? getAgentFraming(agentName) : `You are ${agentConfig?.label ?? agentName}`} Triage mode for ${config.projectName}.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    buildAgentContext(agentName, {}, config, userPrompt),
    '',
    "Critique and improve the coordinator's delegation plan.",
    'Return JSON only with keys: critique, improvements, revised_synthesizer_prompt, revised_risks.',
    'Cite specific file paths and line numbers.',
    '',
    `User request: ${userPrompt}`,
    '',
    'Coordinator plan JSON:',
    JSON.stringify(coordinatorOutput, null, 2),
    '',
    'Hydra summary:',
    JSON.stringify(daemonSummary, null, 2),
    '',
    'Focus on gaps, regressions, edge cases, and stronger sequencing.',
  ].join('\n');
}

function buildSynthesizerPrompt(
  agentName: string,
  userPrompt: string,
  coordinatorOutput: unknown,
  criticOutput: unknown,
  daemonSummary: unknown,
) {
  const agentConfig = getAgent(agentName);

  return [
    `${isPersonaEnabled() ? getAgentFraming(agentName) : `You are ${agentConfig?.label ?? agentName}`} Generating the final execution packet.`,
    '',
    agentConfig?.rolePrompt ?? '',
    '',
    buildAgentContext(agentName, { files: [] }, config, userPrompt),
    '',
    'Do NOT modify files. Produce a concise execution plan and concrete commands.',
    'Return markdown with sections:',
    '- Final Delegation',
    '- Ordered Steps',
    '- Task Updates to record in Hydra',
    '- Handoff chain',
    '',
    `User request: ${userPrompt}`,
    '',
    'Coordinator output:',
    JSON.stringify(coordinatorOutput, null, 2),
    '',
    'Critic output:',
    JSON.stringify(criticOutput, null, 2),
    '',
    'Hydra summary:',
    JSON.stringify(daemonSummary, null, 2),
  ].join('\n');
}

type DispatchSlot = {
  ok?: boolean;
  preview?: boolean;
  command?: unknown;
  parsed?: unknown;
  stdout?: string;
  output?: string;
  lastMessage?: string;
};

type DispatchReport = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  mode: string;
  prompt: string;
  project: string;
  daemonUrl: string;
  daemonSummary: unknown;
  roleAgents: Record<string, string>;
  coordinator: DispatchSlot | null;
  critic: DispatchSlot | null;
  synthesizer: DispatchSlot | null;
  claude: DispatchSlot | null;
  gemini: DispatchSlot | null;
  codex: DispatchSlot | null;
  outputSummary: {
    coordinatorOk: boolean;
    criticOk: boolean;
    synthesizerOk: boolean;
    claudeOk: boolean;
    geminiOk: boolean;
    codexOk: boolean;
    coordinatorSnippet: string;
    criticSnippet: string;
    synthesizerSnippet: string;
    claudeSnippet: string;
    geminiSnippet: string;
    codexSnippet: string;
  } | null;
};

function parseDispatchOptions(argv: string[]) {
  const { options, positionals } = parseArgs(argv);
  const prompt = getPrompt(options, positionals);
  if (prompt === '') {
    throw new Error(
      'Missing prompt. Example: node lib/hydra-dispatch.ts prompt="Plan offline sync rollout"',
    );
  }
  const modeVal = options['mode'];
  const mode = (typeof modeVal === 'string' && modeVal !== '' ? modeVal : 'live').toLowerCase();
  const isPreview = mode === 'preview' || boolFlag(options['preview'], false);
  const save = boolFlag(options['save'], true);
  const urlVal = options['url'];
  const daemonUrl = typeof urlVal === 'string' && urlVal !== '' ? urlVal : DEFAULT_DAEMON_URL;
  const tmVal = options['timeoutMs'];
  const timeoutMs = Number.parseInt(
    typeof tmVal === 'string' && tmVal !== '' ? tmVal : String(DEFAULT_TIMEOUT_MS),
    10,
  );
  return { prompt, mode, isPreview, save, daemonUrl, timeoutMs };
}

function resolveRoleModel(roleAgent: string, rawModel: string | null | undefined): string | null {
  if (rawModel == null) return null;
  return getAgent(roleAgent)?.modelBelongsTo(rawModel) === true ? rawModel : null;
}

function buildPreviewSlot(agent: string, cmd: unknown): DispatchSlot {
  return {
    ok: cmd !== undefined,
    preview: true,
    command: cmd,
    ...(cmd === undefined && {
      lastMessage: `${agent} does not support nonInteractive preview`,
    }),
  };
}

function populatePreviewSlots(
  coordinatorAgent: string,
  criticAgent: string,
  synthesizerAgent: string,
  coordinatorModel: string | null,
  criticModel: string | null,
  synthesizerModel: string | null,
  report: DispatchReport,
): void {
  const coordConfig = getAgent(coordinatorAgent);
  const criticConfig = getAgent(criticAgent);
  const synthConfig = getAgent(synthesizerAgent);
  const coordCmd = coordConfig?.invoke?.nonInteractive?.('<coordinator-prompt>', {
    model: coordinatorModel ?? undefined,
  });
  const criticCmd = criticConfig?.invoke?.nonInteractive?.('<critic-prompt>', {
    model: criticModel ?? undefined,
  });
  const synthCmd = synthConfig?.invoke?.nonInteractive?.('<synthesizer-prompt>', {
    outputPath: '<tempfile>',
    cwd: config.projectRoot,
    model: synthesizerModel ?? undefined,
  });
  report.coordinator = buildPreviewSlot(coordinatorAgent, coordCmd);
  report.critic = buildPreviewSlot(criticAgent, criticCmd);
  report.synthesizer = buildPreviewSlot(synthesizerAgent, synthCmd);
}

async function populateLiveSlots(
  coordinatorAgent: string,
  criticAgent: string,
  synthesizerAgent: string,
  coordinatorModel: string | null,
  criticModel: string | null,
  synthesizerModel: string | null,
  prompt: string,
  timeoutMs: number,
  coordinatorPromptText: string,
  daemonSummary: unknown,
  report: DispatchReport,
): Promise<void> {
  const spinCoord = createSpinner(`${colorAgent(coordinatorAgent)} ${DIM('coordinating...')}`, {
    style: 'solar',
  });
  spinCoord.start();
  const coordResult = await callAgent(
    coordinatorAgent,
    coordinatorPromptText,
    timeoutMs,
    coordinatorModel,
  );
  const coordParsed = parseJsonLoose(coordResult.output);
  report.coordinator = { ...coordResult, parsed: coordParsed };
  if (coordResult.ok) {
    spinCoord.succeed(`${colorAgent(coordinatorAgent)} coordination complete`);
  } else {
    spinCoord.fail(`${colorAgent(coordinatorAgent)} coordination failed`);
  }

  const criticPromptText = buildCriticPrompt(
    criticAgent,
    prompt,
    coordParsed ?? coordResult.output,
    daemonSummary,
  );
  const spinCritic = createSpinner(`${colorAgent(criticAgent)} ${DIM('critiquing...')}`, {
    style: 'solar',
  });
  spinCritic.start();
  const criticResult = await callAgent(criticAgent, criticPromptText, timeoutMs, criticModel);
  const criticParsed = parseJsonLoose(criticResult.output);
  report.critic = { ...criticResult, parsed: criticParsed };
  if (criticResult.ok) {
    spinCritic.succeed(`${colorAgent(criticAgent)} critique complete`);
  } else {
    spinCritic.fail(`${colorAgent(criticAgent)} critique failed`);
  }

  const synthPromptText = buildSynthesizerPrompt(
    synthesizerAgent,
    prompt,
    coordParsed ?? coordResult.output,
    criticParsed ?? criticResult.output,
    daemonSummary,
  );
  const spinSynth = createSpinner(`${colorAgent(synthesizerAgent)} ${DIM('synthesizing...')}`, {
    style: 'solar',
  });
  spinSynth.start();
  const synthResult = await callAgent(
    synthesizerAgent,
    synthPromptText,
    timeoutMs,
    synthesizerModel,
  );
  report.synthesizer = { ...synthResult, lastMessage: synthResult.output };
  if (synthResult.ok) {
    spinSynth.succeed(`${colorAgent(synthesizerAgent)} synthesis complete`);
  } else {
    spinSynth.fail(`${colorAgent(synthesizerAgent)} synthesis failed`);
  }
}

function finalizeOutputSummary(report: DispatchReport): void {
  const coord = report.coordinator;
  const critic = report.critic;
  const synth = report.synthesizer;
  // Defensive runtime guard — report is mutable data
  if (coord == null || critic == null || synth == null) {
    throw new Error(
      'Hydra dispatch invariant violated: coordinator, critic, and synthesizer slots must be populated before computing outputSummary.',
    );
  }
  const coordSnippet = short(coord.output ?? JSON.stringify(coord.parsed ?? {}), 280);
  const criticSnippet = short(critic.output ?? JSON.stringify(critic.parsed ?? {}), 280);
  const synthSnippet = short(synth.lastMessage ?? synth.output ?? '', 280);
  report.outputSummary = {
    coordinatorOk: Boolean(coord.ok),
    criticOk: Boolean(critic.ok),
    synthesizerOk: Boolean(synth.ok),
    claudeOk: Boolean(coord.ok),
    geminiOk: Boolean(critic.ok),
    codexOk: Boolean(synth.ok),
    coordinatorSnippet: coordSnippet,
    criticSnippet,
    synthesizerSnippet: synthSnippet,
    claudeSnippet: coordSnippet,
    geminiSnippet: criticSnippet,
    codexSnippet: synthSnippet,
  };
}

function printDispatchSummary(
  report: DispatchReport,
  coordinatorAgent: string,
  criticAgent: string,
  synthesizerAgent: string,
): void {
  const summary = report.outputSummary;
  if (!summary) return;
  console.log(sectionHeader('Hydra Dispatch Summary'));
  console.log(label('Run ID', DIM(report.id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', pc.white(report.mode)));
  console.log(
    label(
      'Coordinator',
      `${colorAgent(coordinatorAgent)} ${summary.coordinatorOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(
    label(
      'Critic',
      `${colorAgent(criticAgent)} ${summary.criticOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(
    label(
      'Synthesizer',
      `${colorAgent(synthesizerAgent)} ${summary.synthesizerOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(label('Coordinator snippet', DIM(summary.coordinatorSnippet)));
  console.log(label('Critic snippet', DIM(summary.criticSnippet)));
  console.log(label('Synthesizer snippet', DIM(summary.synthesizerSnippet)));
}

async function main() {
  const opts = parseDispatchOptions(process.argv);
  const id = runId('HYDRA_RUN');
  const startedAt = nowIso();

  const installedCLIs = detectInstalledCLIs();
  const coordinatorAgent = getRoleAgent('coordinator', installedCLIs);
  const criticAgent = getRoleAgent('critic', installedCLIs);
  const synthesizerAgent = getRoleAgent('synthesizer', installedCLIs);

  const coordinatorModel = resolveRoleModel(coordinatorAgent, getRoleConfig('coordinator')?.model);
  const criticModel = resolveRoleModel(criticAgent, getRoleConfig('critic')?.model);
  const synthesizerModel = resolveRoleModel(synthesizerAgent, getRoleConfig('synthesizer')?.model);

  const report: DispatchReport = {
    id,
    startedAt,
    finishedAt: null,
    mode: opts.isPreview ? 'preview' : 'live',
    prompt: opts.prompt,
    project: config.projectName,
    daemonUrl: opts.daemonUrl,
    daemonSummary: null,
    coordinator: null,
    critic: null,
    synthesizer: null,
    roleAgents: {
      coordinator: coordinatorAgent,
      critic: criticAgent,
      synthesizer: synthesizerAgent,
    },
    claude: null,
    gemini: null,
    codex: null,
    outputSummary: null,
  };

  report.daemonSummary = await fetchDaemonSummary(opts.daemonUrl);
  const coordinatorPromptText = buildCoordinatorPrompt(
    coordinatorAgent,
    opts.prompt,
    report.daemonSummary,
  );

  if (opts.isPreview) {
    populatePreviewSlots(
      coordinatorAgent,
      criticAgent,
      synthesizerAgent,
      coordinatorModel,
      criticModel,
      synthesizerModel,
      report,
    );
  } else {
    await populateLiveSlots(
      coordinatorAgent,
      criticAgent,
      synthesizerAgent,
      coordinatorModel,
      criticModel,
      synthesizerModel,
      opts.prompt,
      opts.timeoutMs,
      coordinatorPromptText,
      report.daemonSummary,
      report,
    );
  }

  report.claude = report.coordinator;
  report.gemini = report.critic;
  report.codex = report.synthesizer;
  report.finishedAt = nowIso();
  finalizeOutputSummary(report);

  if (opts.save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra dispatch report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  printDispatchSummary(report, coordinatorAgent, criticAgent, synthesizerAgent);
}

const _isMain = (() => {
  try {
    const normalize = (p: string) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const a = normalize(fileURLToPath(import.meta.url));
    const b = normalize(path.resolve(process.argv[1] ?? ''));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
})();

if (_isMain) {
  main().catch((err: unknown) => {
    console.error(`Hydra dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
