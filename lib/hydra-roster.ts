/**
 * Hydra Roster Editor — Inline REPL editor for role→agent→model assignments.
 *
 * Walks through each role in config.roles and lets the user change
 * the agent, model, and reasoning/thinking settings interactively.
 *
 * Usage:
 *   import { runRosterEditor } from './hydra-roster.mjs';
 *   await runRosterEditor(rl);
 */

import pc from 'picocolors';
import { loadHydraConfig, saveHydraConfig } from './hydra-config.ts';
import {
  getActiveModel,
  getPhysicalAgentNames,
  getEffortOptionsForModel,
  getModelReasoningCaps,
  formatEffortDisplay,
} from './hydra-agents.ts';
import { promptChoice } from './hydra-prompt-choice.ts';
import { formatBenchmarkAnnotation } from './hydra-model-profiles.ts';

interface RoleConfig {
  agent?: string;
  model?: string;
  reasoningEffort?: string | null;
  [key: string]: unknown;
}

interface AgentModelPresets {
  default?: string;
  fast?: string;
  cheap?: string;
  [key: string]: string | undefined;
}

interface RosterConfig {
  roles?: Record<string, RoleConfig>;
  models?: Record<string, AgentModelPresets>;
  recommendations?: Record<string, { note?: string; models?: string[] }>;
}

interface RosterChange {
  role: string;
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
}

const REASONING_TITLES: Record<string, string> = {
  effort: 'Reasoning Effort',
  thinking: 'Thinking Budget',
  'model-swap': 'Thinking Mode',
};

function buildRoleContextLines(
  rc: RoleConfig,
  rec: { note?: string; models?: string[] } | undefined,
): string[] {
  const currentAgent = rc.agent ?? 'claude';
  const currentModel = rc.model ?? '(agent default)';
  const rcModel = (rc.model ?? getActiveModel(currentAgent)) as string;
  const effDisplay = formatEffortDisplay(rcModel, rc.reasoningEffort ?? null) as string | null;
  const benchAnnotation = formatBenchmarkAnnotation(rcModel) as string | null;
  return [
    `Agent: ${currentAgent}`,
    `Model: ${currentModel}`,
    benchAnnotation != null && benchAnnotation !== '' ? `Benchmarks: ${benchAnnotation}` : null,
    effDisplay != null && effDisplay !== '' ? `Reasoning: ${effDisplay}` : null,
    rec?.note == null ? null : `Tip: ${rec.note}`,
  ].filter((x): x is string => x !== null);
}

function buildAgentChoices(
  physicalAgents: string[],
  currentAgent: string,
  rec: { note?: string; models?: string[] } | undefined,
  cfg: RosterConfig,
): { label: string; value: string; description: string }[] {
  return physicalAgents.map((a: string) => {
    const isCurrent = a === currentAgent;
    const isRecommended = rec?.models?.some((m: string) => {
      const agentModelPresets = cfg.models?.[a] ?? {};
      return (
        m === agentModelPresets.default ||
        m === agentModelPresets.fast ||
        m === agentModelPresets.cheap
      );
    });
    let desc = '';
    if (isCurrent) desc = '(current)';
    else if (isRecommended === true) desc = '(recommended)';
    return { label: a, value: a, description: desc };
  });
}

function buildModelChoices(
  rc: RoleConfig,
  agentModels: AgentModelPresets,
  rec: { note?: string; models?: string[] } | undefined,
): { label: string; value: string | null; description: string }[] {
  const modelChoices: { label: string; value: string | null; description: string }[] = [];
  const seen = new Set<string>();

  if (rec?.models != null) {
    for (const m of rec.models) {
      if (!seen.has(m)) {
        seen.add(m);
        const annotation = formatBenchmarkAnnotation(m, { includePrice: false }) as string | null;
        const desc =
          annotation != null && annotation !== '' ? `(recommended) ${annotation}` : '(recommended)';
        modelChoices.push({ label: m, value: m, description: desc });
      }
    }
  }

  for (const key of ['default', 'fast', 'cheap']) {
    const id = agentModels[key];
    if (id != null && !seen.has(id)) {
      seen.add(id);
      const annotation = formatBenchmarkAnnotation(id, { includePrice: false }) as string | null;
      const desc =
        annotation != null && annotation !== ''
          ? `(${key} preset) ${annotation}`
          : `(${key} preset)`;
      modelChoices.push({ label: id, value: id, description: desc });
    }
  }

  if (rc.model != null && !seen.has(rc.model)) {
    modelChoices.push({ label: rc.model, value: rc.model, description: '(current)' });
  }

  modelChoices.push({
    label: '(agent default)',
    value: null,
    description: "use the agent's default model",
  });

  return modelChoices;
}

async function pickReasoningForRole(
  rl: unknown,
  role: string,
  effectiveModel: string,
): Promise<string | null> {
  const effortOptions = getEffortOptionsForModel(effectiveModel) as Array<{
    label: string;
    id: string;
    hint?: string;
  }>;
  if (effortOptions.length === 0) return null;
  const caps = getModelReasoningCaps(effectiveModel) as { type: string };
  const effortChoices = effortOptions.map((opt) => ({
    label: opt.label,
    value: opt.id,
    description: opt.hint ?? '',
  }));
  const effortResult = await promptChoice(rl, {
    title: `${role}: ${REASONING_TITLES[caps.type] ?? 'Reasoning'}`,
    context: `Model: ${effectiveModel}`,
    choices: effortChoices,
  });
  return (effortResult as { value: string | null }).value;
}

function applyAndPrintChanges(changes: RosterChange[]): void {
  console.log('');
  console.log(pc.bold('  Changes to apply:'));
  for (const c of changes) {
    const eff = formatEffortDisplay(
      (c.model ?? getActiveModel(c.agent)) as string,
      c.reasoningEffort,
    ) as string | null;
    const effStr = eff != null && eff !== '' ? pc.yellow(` ${eff}`) : '';
    const modelStr =
      c.model != null && c.model !== '' ? pc.white(c.model) : pc.dim('(agent default)');
    console.log(`  ${pc.cyan(c.role.padEnd(16))} ${c.agent}  ${modelStr}${effStr}`);
  }
  console.log('');

  const saveCfg = loadHydraConfig() as unknown as RosterConfig;
  for (const c of changes) {
    saveCfg.roles ??= {};
    saveCfg.roles[c.role] = {
      agent: c.agent,
      model: c.model ?? undefined,
      reasoningEffort: c.reasoningEffort,
    };
  }
  saveHydraConfig(saveCfg as unknown as Parameters<typeof saveHydraConfig>[0]);
  console.log(
    `  ${pc.green('✓')} Saved ${String(changes.length)} role update${changes.length > 1 ? 's' : ''} to hydra.config.json`,
  );
  console.log('');
}

export async function runRosterEditor(rl: unknown): Promise<void> {
  const cfg = loadHydraConfig() as unknown as RosterConfig;
  const roles = cfg.roles ?? {};
  const recs = cfg.recommendations ?? {};
  const physicalAgents = getPhysicalAgentNames();
  const changes: RosterChange[] = [];

  console.log('');
  console.log(pc.bold('  Roster Editor'));
  console.log(pc.dim('  Walk through each role and adjust agent/model/reasoning settings.'));
  console.log(pc.dim('  Press Esc or Ctrl+C at any prompt to abort.'));
  console.log('');

  for (const [role, rc] of Object.entries(roles)) {
    const rec = recs[role] as { note?: string; models?: string[] } | undefined;
    const currentAgent = rc.agent ?? 'claude';
    const contextLines = buildRoleContextLines(rc, rec);

    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive role-by-role wizard; user must respond to each prompt before seeing the next role
    const actionResult = await promptChoice(rl, {
      title: `Role: ${role}`,
      context: contextLines.join('\n'),
      choices: [
        { label: 'Keep current', value: 'keep' },
        { label: 'Change', value: 'change' },
        { label: 'Skip to next', value: 'skip' },
      ],
    });

    if ((actionResult as { value?: string }).value === 'skip') continue;
    if ((actionResult as { value?: string }).value === 'keep') continue;

    const agentChoices = buildAgentChoices(physicalAgents, currentAgent, rec, cfg);
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive role-by-role wizard; agent selection follows the keep/change decision for the same role
    const agentResult = await promptChoice(rl, {
      title: `${role}: Select Agent`,
      context: rec?.models == null ? '' : `Recommended models: ${rec.models.join(', ')}`,
      choices: agentChoices,
    });
    const newAgent = (agentResult as { value: string }).value;

    const agentModels: AgentModelPresets = cfg.models?.[newAgent] ?? {};
    const modelChoices = buildModelChoices(rc, agentModels, rec);
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive role-by-role wizard; model selection follows agent selection for the same role
    const modelResult = await promptChoice(rl, {
      title: `${role}: Select Model`,
      context: `Agent: ${newAgent}`,
      choices: modelChoices,
      allowFreeform: true,
      freeformHint: 'Enter a model ID',
    } as Parameters<typeof promptChoice>[1]);
    const newModel = (modelResult as { value: string | null }).value;

    const effectiveModel = (newModel ?? getActiveModel(newAgent)) as string;
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: interactive role-by-role wizard; reasoning effort selection follows model selection for the same role
    const newEffort = await pickReasoningForRole(rl, role, effectiveModel);

    changes.push({ role, agent: newAgent, model: newModel, reasoningEffort: newEffort });
  }

  if (changes.length === 0) {
    console.log(pc.dim('  No changes made.'));
    console.log('');
    return;
  }

  applyAndPrintChanges(changes);
}
