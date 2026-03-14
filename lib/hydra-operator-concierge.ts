/**
 * Hydra Operator Concierge — mode-execution functions
 *
 * Extracted from lib/hydra-operator.ts (rf-op-concierge).
 * Contains the five dispatch-mode runners:
 *   runCouncilPrompt, runCouncilJson, runAutoPrompt, runAutoPromptLegacy, runSmartPrompt
 *
 * Shared brief-builders and delegation helpers live in hydra-operator-dispatch.ts.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- T7A: operator uses polymorphic any for dynamic dispatch */
/* eslint-disable @typescript-eslint/strict-boolean-expressions -- T7A: standard JS truthiness; type narrowing tracked as follow-up */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-type-conversion -- T7A: operator uses || for truthiness-based defaults */

/* eslint-disable @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-redundant-type-constituents -- T7A: return types use polymorphic any; full typing is a follow-up task */

import path from 'node:path';
import { spawn } from 'node:child_process';

import { rewriteNodeInvocation } from './hydra-exec-spawn.ts';
import { getMode, setMode } from './hydra-agents.ts';
import { resolveProject, HYDRA_ROOT, loadHydraConfig } from './hydra-config.ts';
import { classifyPrompt, selectTandemPair, generateSpec } from './hydra-utils.ts';
import { gateIntent } from './hydra-intent-gate.ts';
import { setLastDispatch } from './hydra-statusbar.ts';
import { SMART_TIER_MAP } from './hydra-operator-ui.ts';
import {
  shouldCrossVerify,
  runCrossVerification,
  publishFastPathDelegation,
  publishMiniRoundDelegation,
  publishTandemDelegation,
} from './hydra-operator-dispatch.ts';

const config = resolveProject();

// ── Shared result types ───────────────────────────────────────────────────────

interface DispatchPublished {
  tasks: unknown[];
  handoffs?: Array<{ to?: string }>;
}

interface DispatchResult {
  mode: string;
  recommended: string;
  route: string;
  classification: unknown;
  triage: unknown;
  published: DispatchPublished | null;
  escalatedToCouncil: boolean;
  councilOutput?: string;
  spec?: { specId: string; specPath: string } | null;
  verification?: unknown;
  smartTier?: string;
  smartMode?: string;
}

// ── Subprocess runner ─────────────────────────────────────────────────────────

/**
 * Spawn a child process asynchronously, collecting stdout/stderr.
 * Unlike spawnSync, this does NOT block the event loop, so status bar
 * polling and redraws continue while the subprocess runs.
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @param {Function} [onProgress] - Called with parsed JSON progress markers from stderr
 */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: any = {},
  onProgress: ((data: any) => void) | null = null,
) {
  return new Promise((resolve) => {
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    let stderrBuf = '';
    const invocation = rewriteNodeInvocation(cmd, args, HYDRA_ROOT);
    const child = spawn(invocation.command, invocation.args, {
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
        stderrBuf += String(d);
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed[0] !== '{') continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'council_phase') onProgress(parsed);
          } catch {
            /* not a progress marker */
          }
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

// ── Council runners ───────────────────────────────────────────────────────────

export async function runCouncilPrompt({
  baseUrl,
  promptText,
  rounds = 2,
  preview = false,
  onProgress = null,
  agents = null,
}: {
  baseUrl: string;
  promptText: string;
  rounds?: number;
  preview?: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
  agents?: string[] | null;
}) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.ts');
  const councilTimeoutMs = (config as any).routing?.councilTimeoutMs ?? 420_000;
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${String(rounds)}`,
    `timeoutMs=${String(councilTimeoutMs)}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  } else {
    args.push('publish=true');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = (await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress)) as any;

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function parseCouncilJsonOutput(result: any): {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  report: any;
} {
  try {
    const parsed = JSON.parse(result.stdout ?? '{}');
    return {
      ok: true,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      report: parsed.report ?? null,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: `Failed to parse council JSON: ${err instanceof Error ? err.message : String(err)}`,
      report: null,
    };
  }
}

export async function runCouncilJson({
  baseUrl,
  promptText,
  rounds = 1,
  preview = false,
  publish = false,
  onProgress = null,
  agents = null,
}: {
  baseUrl: string;
  promptText: string;
  rounds?: number;
  preview?: boolean;
  publish?: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
  agents?: string[] | null;
}) {
  const councilScript = path.join(HYDRA_ROOT, 'lib', 'hydra-council.ts');
  const councilTimeoutMs = (config as any).routing?.councilTimeoutMs ?? 420_000;
  const args = [
    councilScript,
    `prompt=${promptText}`,
    `url=${baseUrl}`,
    `rounds=${String(rounds)}`,
    `timeoutMs=${String(councilTimeoutMs)}`,
    'emit=json',
    'save=false',
    `publish=${publish ? 'true' : 'false'}`,
  ];
  if (preview) {
    args.push('mode=preview', 'publish=false');
  }
  if (agents && agents.length > 0) {
    args.push(`agents=${agents.join(',')}`);
  }

  const result = (await spawnAsync('node', args, { cwd: config.projectRoot }, onProgress)) as any;

  if (result.status !== 0) {
    return {
      ok: false,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      report: null,
    };
  }
  return parseCouncilJsonOutput(result);
}

async function loadIntentGateResult(
  promptText: string,
): Promise<{ effectivePrompt: string; classification: any }> {
  const intentCfg = (() => {
    try {
      const c = loadHydraConfig();
      return c.routing.intentGate;
    } catch {
      return {};
    }
  })();
  try {
    const { text: gatedText, classification } = await gateIntent(promptText, {
      enabled: (intentCfg as any).enabled !== false,
      confidenceThreshold: (intentCfg as any).confidenceThreshold ?? 0.55,
    });
    return { effectivePrompt: gatedText, classification };
  } catch {
    return { effectivePrompt: promptText, classification: classifyPrompt(promptText) };
  }
}

async function handleSingleRoute(
  baseUrl: string,
  from: string,
  effectivePrompt: string,
  classification: any,
  agents: string[],
  preview: boolean,
): Promise<DispatchResult> {
  if (preview) {
    return {
      mode: 'fast-path',
      recommended: 'handoff',
      route: `fast-path → ${String(classification.suggestedAgent)}`,
      classification,
      triage: null,
      published: null,
      escalatedToCouncil: false,
    };
  }
  const published = await publishFastPathDelegation({
    baseUrl,
    from,
    promptText: effectivePrompt,
    classification,
    agents,
  });
  return {
    mode: 'fast-path',
    recommended: 'handoff',
    route: `fast-path → ${String(published.agent)} (${String(classification.taskType)}, ${String(classification.confidence)} confidence)`,
    classification,
    triage: null,
    published: { tasks: [published.task], handoffs: [published.handoff] },
    escalatedToCouncil: false,
  };
}

async function handleTandemRoute(
  baseUrl: string,
  from: string,
  effectivePrompt: string,
  classification: any,
  agents: string[],
  tandemPair: any,
  preview: boolean,
): Promise<DispatchResult> {
  if (preview) {
    const pair = tandemPair ?? { lead: 'claude', follow: 'codex' };
    return {
      mode: 'tandem',
      recommended: 'tandem',
      route: `tandem: ${String(pair.lead)} → ${String(pair.follow)}`,
      classification,
      triage: null,
      published: null,
      escalatedToCouncil: false,
    };
  }
  const published = await publishTandemDelegation({
    baseUrl,
    from,
    promptText: effectivePrompt,
    classification,
    agents,
  });
  const pair = (published as any).lead
    ? { lead: (published as any).lead, follow: (published as any).follow }
    : (tandemPair ?? { lead: '?', follow: '?' });
  return {
    mode: 'tandem',
    recommended: 'tandem',
    route: `tandem: ${String(pair.lead)} → ${String(pair.follow)} (${String(classification.taskType)})`,
    classification,
    triage: null,
    published: { tasks: (published as any).tasks, handoffs: (published as any).handoffs },
    escalatedToCouncil: false,
  };
}

async function handleCouncilRoute(
  baseUrl: string,
  effectivePrompt: string,
  classification: any,
  agents: string[],
  councilRounds: number,
  preview: boolean,
  onProgress: any,
): Promise<DispatchResult> {
  let spec = null;
  try {
    spec = await generateSpec(effectivePrompt, null, { cwd: config.projectRoot });
  } catch {
    /* non-critical */
  }

  if (preview) {
    return {
      mode: 'council',
      recommended: 'council',
      route: 'council (complex prompt)',
      classification,
      triage: null,
      published: null,
      escalatedToCouncil: true,
      spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    };
  }

  const council = await runCouncilPrompt({
    baseUrl,
    promptText: effectivePrompt,
    rounds: councilRounds,
    preview: false,
    onProgress,
    agents,
  });
  if (!council.ok) {
    throw new Error(
      council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
    );
  }

  let verification = null;
  if (shouldCrossVerify(classification) && council.stdout) {
    verification = await runCrossVerification(
      'claude',
      council.stdout.trim(),
      effectivePrompt,
      spec?.specContent,
    );
  }

  return {
    mode: 'council',
    recommended: 'council',
    route: 'council (complex prompt)',
    classification,
    triage: null,
    published: null,
    escalatedToCouncil: true,
    councilOutput: council.stdout.trim(),
    spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    verification,
  };
}

// ── Auto prompt runners ───────────────────────────────────────────────────────

export async function runAutoPrompt({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress = null,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
}): Promise<DispatchResult> {
  const { effectivePrompt, classification } = await loadIntentGateResult(promptText);

  const routingConfig = (config as any).routing ?? {};

  // Re-resolve route strategy with agent filter
  let { routeStrategy } = classification;
  let tandemPair = classification.tandemPair;
  if (routeStrategy === 'tandem' && agents.length > 0) {
    tandemPair = selectTandemPair(classification.taskType, classification.suggestedAgent, agents);
    if (!tandemPair) routeStrategy = 'single';
  }
  if (routeStrategy === 'tandem' && routingConfig.tandemEnabled === false) {
    routeStrategy = 'single';
  }

  if (routingConfig.useLegacyTriage && routeStrategy !== 'single') {
    return runAutoPromptLegacy({
      baseUrl,
      from,
      agents,
      promptText: effectivePrompt,
      miniRounds,
      councilRounds,
      preview,
      onProgress,
      classification,
    });
  }

  if (routeStrategy === 'single') {
    return handleSingleRoute(baseUrl, from, effectivePrompt, classification, agents, preview);
  }

  if (routeStrategy === 'tandem') {
    return handleTandemRoute(
      baseUrl,
      from,
      effectivePrompt,
      classification,
      agents,
      tandemPair,
      preview,
    );
  }

  return handleCouncilRoute(
    baseUrl,
    effectivePrompt,
    classification,
    agents,
    councilRounds,
    preview,
    onProgress,
  );
}

async function resolveClassificationIfNeeded(
  promptText: string,
  existing: any,
): Promise<{ effectivePrompt: string; classification: any }> {
  if (existing) {
    return { effectivePrompt: promptText, classification: existing };
  }
  return loadIntentGateResult(promptText);
}

async function handleLegacyCouncilEscalation(
  baseUrl: string,
  effectivePrompt: string,
  localClassification: any,
  spec: any,
  councilRounds: number,
  preview: boolean,
  onProgress: any,
  agents: string[],
  recommended: string,
  triageReport: any,
): Promise<DispatchResult> {
  if (preview) {
    return {
      mode: 'preview',
      recommended,
      route:
        localClassification.tier === 'complex'
          ? 'council (complex prompt)'
          : 'mini-round triage → preview',
      classification: localClassification,
      triage: triageReport,
      published: null,
      escalatedToCouncil: recommended === 'council',
    };
  }

  const council = await runCouncilPrompt({
    baseUrl,
    promptText: effectivePrompt,
    rounds: councilRounds,
    preview: false,
    onProgress,
    agents,
  });
  if (!council.ok) {
    throw new Error(
      council.stderr ?? council.stdout ?? `Council exited with status ${String(council.status)}`,
    );
  }
  let verification = null;
  if (shouldCrossVerify(localClassification) && council.stdout) {
    verification = await runCrossVerification(
      'claude',
      council.stdout.trim(),
      effectivePrompt,
      spec?.specContent,
    );
  }
  return {
    mode: 'council',
    recommended,
    route: 'council (escalated)',
    classification: localClassification,
    triage: triageReport,
    published: null,
    escalatedToCouncil: true,
    councilOutput: council.stdout.trim(),
    spec: spec ? { specId: spec.specId, specPath: spec.specPath } : null,
    verification,
  };
}

/**
 * Legacy auto prompt path: uses mini-round triage (4 agent calls).
 * Retained behind `routing.useLegacyTriage` config toggle.
 */
export async function runAutoPromptLegacy({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress,
  classification,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress: ((data: any) => void) | null;
  classification: any | null;
}): Promise<DispatchResult> {
  const { effectivePrompt, classification: localClassification } =
    await resolveClassificationIfNeeded(promptText, classification);

  const triage = await runCouncilJson({
    baseUrl,
    promptText: effectivePrompt,
    rounds: miniRounds,
    preview,
    publish: false,
    onProgress,
    agents,
  });

  if (!triage.ok || !triage.report) {
    throw new Error(
      triage.stderr ?? triage.stdout ?? `Mini-round exited with status ${String(triage.status)}`,
    );
  }

  const recommended = String(triage.report.recommendedMode ?? 'handoff').toLowerCase();

  let spec = null;
  if (!preview && localClassification.tier === 'complex') {
    try {
      spec = await generateSpec(effectivePrompt, null, { cwd: config.projectRoot });
    } catch {
      /* non-critical */
    }
  }

  if (preview || recommended === 'council' || localClassification.tier === 'complex') {
    return handleLegacyCouncilEscalation(
      baseUrl,
      effectivePrompt,
      localClassification,
      spec,
      councilRounds,
      preview,
      onProgress,
      agents,
      recommended,
      triage.report,
    );
  }

  const published = await publishMiniRoundDelegation({
    baseUrl,
    from,
    agents,
    promptText: effectivePrompt,
    report: triage.report,
  });
  return {
    mode: 'handoff',
    recommended,
    route: 'mini-round triage → delegated',
    classification: localClassification,
    triage: triage.report,
    published,
    escalatedToCouncil: false,
  };
}

// ── Smart Mode ────────────────────────────────────────────────────────────────

export async function runSmartPrompt({
  baseUrl,
  from,
  agents,
  promptText,
  miniRounds,
  councilRounds,
  preview,
  onProgress = null,
}: {
  baseUrl: string;
  from: string;
  agents: string[];
  promptText: string;
  miniRounds: number;
  councilRounds: number;
  preview: boolean;
  onProgress?: ((data: Record<string, unknown>) => void) | null;
}): Promise<DispatchResult> {
  const classification = classifyPrompt(promptText);
  const targetMode = (SMART_TIER_MAP as Record<string, string>)[classification.tier] || 'balanced';

  const previousMode = getMode();

  try {
    setMode(targetMode);
  } catch {
    // If targetMode doesn't exist in modeTiers, fall through to auto
  }

  try {
    const result = await runAutoPrompt({
      baseUrl,
      from,
      agents,
      promptText,
      miniRounds,
      councilRounds,
      preview,
      onProgress,
    });

    (result as any).smartTier = classification.tier;
    (result as any).smartMode = targetMode;
    result.route = `${String(classification.tier)}\u2192${String(result.route)}`;

    setLastDispatch({
      route: `${classification.tier}\u2192${String(result.mode === 'fast-path' ? (result.published?.handoffs?.[0]?.to ?? (classification.suggestedAgent || 'agent')) : result.mode)}`,
      tier: classification.tier,
      agent: result.mode === 'fast-path' ? classification.suggestedAgent || '' : '',
      mode: 'smart',
    });

    return result;
  } finally {
    try {
      setMode(previousMode);
    } catch {
      /* ignore */
    }
  }
}
