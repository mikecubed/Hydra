/**
 * Hydra single-terminal dispatch runner.
 *
 * Runs one prompt across:
 * 1) Claude (coordination/delegation)
 * 2) Gemini (critique/second-opinion)
 * 3) Codex (final synthesis in read-only mode)
 *
 * Usage:
 *   node hydra-dispatch.mjs prompt="Your request"
 *   node hydra-dispatch.mjs prompt="Your request" mode=preview
 */

import './hydra-env.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentContext } from './hydra-context.ts';
import { getAgent, getMode, setMode } from './hydra-agents.ts';
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
import { executeAgent } from './hydra-shared/agent-executor.ts';
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
import { detectInstalledCLIs } from './hydra-setup.ts';
import pc from 'picocolors';

const config = resolveProject();
const RUNS_DIR = config.runsDir;

const DEFAULT_DAEMON_URL = process.env['AI_ORCH_URL'] || 'http://127.0.0.1:4173';
const DEFAULT_TIMEOUT_MS = 1000 * 60 * 7;

const MODE_DOWNSHIFT = { performance: 'balanced', balanced: 'economy' };

function usageGuard(_agent: string) {
  try {
    const usage = checkUsage();
    if (usage.level === 'critical') {
      const currentMode = getMode();
      const nextMode = (MODE_DOWNSHIFT as Record<string, string>)[currentMode];
      if (nextMode) {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 downshifting mode: ${currentMode} \u2192 ${nextMode}`,
          ),
        );
        setMode(nextMode);
      } else {
        console.log(
          WARNING(
            `  \u26A0 Token usage CRITICAL (${usage.percent.toFixed(1)}%) \u2014 already in economy mode`,
          ),
        );
      }
    } else if (usage.level === 'warning') {
      console.log(DIM(`  \u26A0 Token usage at ${usage.percent.toFixed(1)}%`));
    }
  } catch {
    /* non-critical */
  }
}

async function callAgent(agent: string, prompt: string, timeoutMs: number) {
  usageGuard(agent);
  return executeAgent(agent, prompt, { cwd: config.projectRoot, timeoutMs });
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
    return (payload as Record<string, unknown>)?.['summary'] ?? null;
  } catch {
    return null;
  }
}

/**
 * Preference order used when falling back from an unavailable role agent.
 * 'local' is last and only considered when local.enabled is true in config.
 */
const DISPATCH_PREFERENCE_ORDER = ['claude', 'copilot', 'gemini', 'codex', 'local'] as const;

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

  if (preferred) {
    if (preferred === 'local') {
      // Only dispatch to local if explicitly enabled
      if (cfg.local.enabled) return preferred;
    } else if (installedCLIs[preferred] !== false) {
      // Validate the agent is known and enabled before returning it
      try {
        const agentDef = getAgent(preferred);
        if (agentDef && (agentDef as { enabled?: boolean }).enabled !== false) {
          return preferred;
        }
      } catch {
        // Unknown agent name — fall through to preference chain
      }
    }
  }

  // Fallback: first installed agent from preference order
  for (const name of DISPATCH_PREFERENCE_ORDER) {
    if (name === 'local') {
      if (cfg.local.enabled) return name;
    } else if (installedCLIs[name] === true) {
      return name;
    }
  }
  // Last resort: any installed agent
  const anyInstalled = Object.entries(installedCLIs).find(([, v]) => v === true);
  if (anyInstalled) return anyInstalled[0];
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

  if (!prompt) {
    console.error(
      'Missing prompt. Example: node hydra-dispatch.mjs prompt="Plan offline sync rollout"',
    );
    process.exit(1);
  }

  const mode = String(options['mode'] || 'live').toLowerCase();
  const isPreview = mode === 'preview' || boolFlag(options['preview'], false);
  const save = boolFlag(options['save'], true);
  const daemonUrl = String(options['url'] || DEFAULT_DAEMON_URL);
  const timeoutMs = Number.parseInt(String(options['timeoutMs'] || DEFAULT_TIMEOUT_MS), 10);

  const id = runId('HYDRA_RUN');
  const startedAt = nowIso();

  // Resolve role → agent mapping once, using installed CLI detection
  const installedCLIs = detectInstalledCLIs();
  const coordinatorAgent = getRoleAgent('coordinator', installedCLIs);
  const criticAgent = getRoleAgent('critic', installedCLIs);
  const synthesizerAgent = getRoleAgent('synthesizer', installedCLIs);

  type DispatchSlot = {
    ok?: boolean;
    preview?: boolean;
    command?: unknown;
    parsed?: unknown;
    stdout?: string;
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
    report.coordinator = {
      ok: true,
      preview: true,
      command: coordConfig?.invoke?.nonInteractive?.('<coordinator-prompt>'),
    };
    report.critic = {
      ok: true,
      preview: true,
      command: criticConfig?.invoke?.nonInteractive?.('<critic-prompt>'),
    };
    report.synthesizer = {
      ok: true,
      preview: true,
      command: synthConfig?.invoke?.nonInteractive?.('<synthesizer-prompt>', {
        outputPath: '<tempfile>',
        cwd: config.projectRoot,
      }),
    };
  } else {
    const spinCoord = createSpinner(`${colorAgent(coordinatorAgent)} ${DIM('coordinating...')}`, {
      style: 'solar',
    });
    spinCoord.start();
    const coordResult = await callAgent(coordinatorAgent, coordinatorPromptText, timeoutMs);
    const coordParsed = parseJsonLoose(coordResult.stdout);
    report.coordinator = { ...coordResult, parsed: coordParsed };
    coordResult.ok
      ? spinCoord.succeed(`${colorAgent(coordinatorAgent)} coordination complete`)
      : spinCoord.fail(`${colorAgent(coordinatorAgent)} coordination failed`);

    const criticPromptText = buildCriticPrompt(
      criticAgent,
      prompt,
      coordParsed ?? coordResult.stdout,
      report.daemonSummary,
    );
    const spinCritic = createSpinner(`${colorAgent(criticAgent)} ${DIM('critiquing...')}`, {
      style: 'solar',
    });
    spinCritic.start();
    const criticResult = await callAgent(criticAgent, criticPromptText, timeoutMs);
    const criticParsed = parseJsonLoose(criticResult.stdout);
    report.critic = { ...criticResult, parsed: criticParsed };
    criticResult.ok
      ? spinCritic.succeed(`${colorAgent(criticAgent)} critique complete`)
      : spinCritic.fail(`${colorAgent(criticAgent)} critique failed`);

    const synthPromptText = buildSynthesizerPrompt(
      synthesizerAgent,
      prompt,
      coordParsed ?? coordResult.stdout,
      criticParsed ?? criticResult.stdout,
      report.daemonSummary,
    );
    const spinSynth = createSpinner(`${colorAgent(synthesizerAgent)} ${DIM('synthesizing...')}`, {
      style: 'solar',
    });
    spinSynth.start();
    const synthResult = await callAgent(synthesizerAgent, synthPromptText, timeoutMs);
    report.synthesizer = { ...synthResult, lastMessage: synthResult.stdout };
    synthResult.ok
      ? spinSynth.succeed(`${colorAgent(synthesizerAgent)} synthesis complete`)
      : spinSynth.fail(`${colorAgent(synthesizerAgent)} synthesis failed`);
  }

  // Set backward-compat aliases so existing consumers reading report.claude etc. still work
  report.claude = report.coordinator;
  report.gemini = report.critic;
  report.codex = report.synthesizer;

  report.finishedAt = nowIso();
  // TypeScript control flow: coordinator/critic/synthesizer are non-null here (assigned in both branches above)
  const coord = report.coordinator;
  const critic = report.critic;
  const synth = report.synthesizer;
  const coordSnippet = short(coord.stdout ?? JSON.stringify(coord.parsed ?? {}), 280);
  const criticSnippet = short(critic.stdout ?? JSON.stringify(critic.parsed ?? {}), 280);
  const synthSnippet = short(synth.lastMessage ?? synth.stdout ?? '', 280);
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

const _isMain = fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '');

if (_isMain) {
  main().catch((err: unknown) => {
    console.error(`Hydra dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
