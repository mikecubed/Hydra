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
    if (preferred === 'local') {
      // Only dispatch to local if explicitly enabled
      if (cfg.local.enabled) return preferred;
    } else {
      const agentDef = getAgent(preferred);
      if (agentDef?.enabled === true) {
        // CLI agents require explicit confirmation (=== true); API agents (cli === null) are always reachable
        const needsCli = agentDef.cli !== null && agentDef.cli !== undefined;
        if (!needsCli || installedCLIs[preferred] === true) {
          return preferred;
        }
      }
    }
  }

  // Fallback: first installed AND enabled agent from preference order
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
  // Last resort: any installed, registered, and enabled agent
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

async function main() {
  const { options, positionals } = parseArgs(process.argv);
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

  const id = runId('HYDRA_RUN');
  const startedAt = nowIso();

  // Resolve role → agent mapping once, using installed CLI detection
  const installedCLIs = detectInstalledCLIs();
  const coordinatorAgent = getRoleAgent('coordinator', installedCLIs);
  const criticAgent = getRoleAgent('critic', installedCLIs);
  const synthesizerAgent = getRoleAgent('synthesizer', installedCLIs);

  // Resolve per-role model overrides, validating each against the resolved agent.
  // If the configured model doesn't belong to the resolved agent (e.g., role configured
  // for copilot with a copilot-* model but copilot isn't installed and fell back to claude),
  // clear the override so the agent uses its own default model.
  const _coordinatorModelRaw = getRoleConfig('coordinator')?.model ?? null;
  const _criticModelRaw = getRoleConfig('critic')?.model ?? null;
  const _synthesizerModelRaw = getRoleConfig('synthesizer')?.model ?? null;

  const coordinatorModel =
    _coordinatorModelRaw != null &&
    getAgent(coordinatorAgent)?.modelBelongsTo(_coordinatorModelRaw) === true
      ? _coordinatorModelRaw
      : null;
  const criticModel =
    _criticModelRaw != null && getAgent(criticAgent)?.modelBelongsTo(_criticModelRaw) === true
      ? _criticModelRaw
      : null;
  const synthesizerModel =
    _synthesizerModelRaw != null &&
    getAgent(synthesizerAgent)?.modelBelongsTo(_synthesizerModelRaw) === true
      ? _synthesizerModelRaw
      : null;

  type DispatchSlot = {
    ok?: boolean;
    preview?: boolean;
    command?: unknown;
    parsed?: unknown;
    stdout?: string;
    output?: string;
    lastMessage?: string;
  };

  const report: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    mode: string;
    prompt: string;
    project: string;
    daemonUrl: string;
    daemonSummary: unknown;
    // Role → agent mapping for this run
    roleAgents: Record<string, string>;
    // Role-based keys (canonical)
    coordinator: DispatchSlot | null;
    critic: DispatchSlot | null;
    synthesizer: DispatchSlot | null;
    // Backward-compat aliases (point at role-based objects)
    claude: DispatchSlot | null;
    gemini: DispatchSlot | null;
    codex: DispatchSlot | null;
    outputSummary: {
      coordinatorOk: boolean;
      criticOk: boolean;
      synthesizerOk: boolean;
      // Backward-compat aliases
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
  } = {
    id,
    startedAt,
    finishedAt: null,
    mode: isPreview ? 'preview' : 'live',
    prompt,
    project: config.projectName,
    daemonUrl,
    daemonSummary: null,
    coordinator: null,
    critic: null,
    synthesizer: null,
    roleAgents: {
      coordinator: coordinatorAgent,
      critic: criticAgent,
      synthesizer: synthesizerAgent,
    },
    // Backward-compat aliases — set after role slots are populated
    claude: null,
    gemini: null,
    codex: null,
    outputSummary: null,
  };

  report.daemonSummary = await fetchDaemonSummary(daemonUrl);

  const coordinatorPromptText = buildCoordinatorPrompt(
    coordinatorAgent,
    prompt,
    report.daemonSummary,
  );

  if (isPreview) {
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
    report.coordinator = {
      ok: coordCmd !== undefined,
      preview: true,
      command: coordCmd,
      ...(coordCmd === undefined && {
        lastMessage: `${coordinatorAgent} does not support nonInteractive preview`,
      }),
    };
    report.critic = {
      ok: criticCmd !== undefined,
      preview: true,
      command: criticCmd,
      ...(criticCmd === undefined && {
        lastMessage: `${criticAgent} does not support nonInteractive preview`,
      }),
    };
    report.synthesizer = {
      ok: synthCmd !== undefined,
      preview: true,
      command: synthCmd,
      ...(synthCmd === undefined && {
        lastMessage: `${synthesizerAgent} does not support nonInteractive preview`,
      }),
    };
  } else {
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
      report.daemonSummary,
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
      report.daemonSummary,
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

  // Set backward-compat aliases so existing consumers reading report.claude etc. still work
  report.claude = report.coordinator;
  report.gemini = report.critic;
  report.codex = report.synthesizer;

  report.finishedAt = nowIso();
  const coord = report.coordinator;
  const critic = report.critic;
  const synth = report.synthesizer;

  // Defensive runtime guard — TS proves these are assigned but report is mutable data
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
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
    // Backward-compat aliases
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

  if (save) {
    ensureDir(RUNS_DIR);
    const outPath = path.join(RUNS_DIR, `${id}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Hydra dispatch report saved: ${path.relative(config.projectRoot, outPath)}`);
  }

  console.log(sectionHeader('Hydra Dispatch Summary'));
  console.log(label('Run ID', DIM(id)));
  console.log(label('Project', pc.white(config.projectName)));
  console.log(label('Mode', pc.white(report.mode)));
  console.log(
    label(
      'Coordinator',
      `${colorAgent(coordinatorAgent)} ${report.outputSummary.coordinatorOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(
    label(
      'Critic',
      `${colorAgent(criticAgent)} ${report.outputSummary.criticOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(
    label(
      'Synthesizer',
      `${colorAgent(synthesizerAgent)} ${report.outputSummary.synthesizerOk ? SUCCESS('ok') : ERROR('failed')}`,
    ),
  );
  console.log(label('Coordinator snippet', DIM(report.outputSummary.coordinatorSnippet)));
  console.log(label('Critic snippet', DIM(report.outputSummary.criticSnippet)));
  console.log(label('Synthesizer snippet', DIM(report.outputSummary.synthesizerSnippet)));
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
