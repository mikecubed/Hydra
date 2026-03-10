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
import { loadHydraConfig, saveHydraConfig } from './hydra-config.mjs';
import {
  getActiveModel,
  getPhysicalAgentNames,
  getEffortOptionsForModel,
  getModelReasoningCaps,
  formatEffortDisplay,
} from './hydra-agents.mjs';
import { promptChoice } from './hydra-prompt-choice.mjs';
import { formatBenchmarkAnnotation } from './hydra-model-profiles.mjs';

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

export async function runRosterEditor(rl: unknown): Promise<void> {
  const cfg = loadHydraConfig() as RosterConfig;
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
    const currentModel = rc.model ?? '(agent default)';
    const currentEffort = rc.reasoningEffort ?? null;
    const rcModel = (rc.model ?? getActiveModel(currentAgent)) as string;
    const effDisplay = formatEffortDisplay(rcModel, currentEffort) as string | null;

    // Step 1: Show current + ask keep/change/skip
    const benchAnnotation = formatBenchmarkAnnotation(rcModel) as string | null;
    const contextLines = [
      `Agent: ${currentAgent}`,
      `Model: ${currentModel}`,
      benchAnnotation ? `Benchmarks: ${benchAnnotation}` : null,
      effDisplay ? `Reasoning: ${effDisplay}` : null,
      rec?.note != null ? `Tip: ${rec.note}` : null,
    ].filter((x): x is string => x !== null);

    const actionResult = await promptChoice(rl, {
      title: `Role: ${role}`,
      context: contextLines.join('\n') as unknown as object,
      choices: [
        { label: 'Keep current', value: 'keep' },
        { label: 'Change', value: 'change' },
        { label: 'Skip to next', value: 'skip' },
      ],
    });

    if ((actionResult as { value?: string }).value === 'skip') continue;
    if ((actionResult as { value?: string }).value === 'keep') continue;

    // Step 2: Pick agent
    const agentChoices = physicalAgents.map((a: string) => {
      const isCurrent = a === currentAgent;
      const isRecommended = rec?.models?.some((m: string) => {
        const agentModelPresets = cfg.models?.[a] ?? {};
        return m === agentModelPresets.default || m === agentModelPresets.fast || m === agentModelPresets.cheap;
      });
      let desc = '';
      if (isCurrent) desc = '(current)';
      else if (isRecommended) desc = '(recommended)';
      return { label: a, value: a, description: desc };
    });

    const agentResult = await promptChoice(rl, {
      title: `${role}: Select Agent`,
      context: (rec?.models != null ? `Recommended models: ${rec.models.join(', ')}` : '') as unknown as object,
      choices: agentChoices,
    });

    // agentResult always defined by promptChoice
    const newAgent = (agentResult as { value: string }).value;

    // Step 3: Pick model
    const agentModels: AgentModelPresets = cfg.models?.[newAgent] ?? {};
    const modelChoices: { label: string; value: string | null; description: string }[] = [];

    // Add recommended models first
    const seen = new Set<string>();
    if (rec?.models != null) {
      for (const m of rec.models) {
        if (!seen.has(m)) {
          seen.add(m);
          const annotation = formatBenchmarkAnnotation(m, { includePrice: false }) as string | null;
          const desc = annotation ? `(recommended) ${annotation}` : '(recommended)';
          modelChoices.push({ label: m, value: m, description: desc });
        }
      }
    }

    // Add agent presets
    for (const key of ['default', 'fast', 'cheap']) {
      const id = agentModels[key];
      if (id != null && !seen.has(id)) {
        seen.add(id);
        const annotation = formatBenchmarkAnnotation(id, { includePrice: false }) as string | null;
        const desc = annotation ? `(${key} preset) ${annotation}` : `(${key} preset)`;
        modelChoices.push({ label: id, value: id, description: desc });
      }
    }

    // Add current if not already listed
    if (rc.model != null && !seen.has(rc.model)) {
      modelChoices.push({ label: rc.model, value: rc.model, description: '(current)' });
    }

    // Add "agent default" option
    modelChoices.push({
      label: '(agent default)',
      value: null,
      description: "use the agent's default model",
    });

    const modelResult = await promptChoice(rl, {
      title: `${role}: Select Model`,
      context: `Agent: ${newAgent}` as unknown as object,
      choices: modelChoices,
      allowFreeform: true,
      freeformHint: 'Enter a model ID',
    } as Parameters<typeof promptChoice>[1]);

    // modelResult always defined by promptChoice
    const newModel = (modelResult as { value: string | null }).value;

    // Step 4: Pick reasoning/thinking (if supported)
    const effectiveModel = (newModel ?? getActiveModel(newAgent)) as string;
    const effortOptions = getEffortOptionsForModel(effectiveModel) as Array<{ label: string; id: string; hint?: string }>;
    let newEffort: string | null = null;

    if (effortOptions.length > 0) {
      const caps = getModelReasoningCaps(effectiveModel) as { type: string };
      const effortChoices = effortOptions.map((opt) => ({
        label: opt.label,
        value: opt.id,
        description: opt.hint ?? '',
      }));

      const effortResult = await promptChoice(rl, {
        title: `${role}: ${REASONING_TITLES[caps.type] ?? 'Reasoning'}`,
        context: `Model: ${effectiveModel}` as unknown as object,
        choices: effortChoices,
      });

      newEffort = (effortResult as { value: string | null }).value;
    }

    // Record change
    changes.push({ role, agent: newAgent, model: newModel, reasoningEffort: newEffort });
  }

  // Apply changes
  if (changes.length === 0) {
    console.log(pc.dim('  No changes made.'));
    console.log('');
    return;
  }

  // Summary
  console.log('');
  console.log(pc.bold('  Changes to apply:'));
  for (const c of changes) {
    const eff = formatEffortDisplay((c.model ?? getActiveModel(c.agent)) as string, c.reasoningEffort) as string | null;
    const effStr = eff ? pc.yellow(` ${eff}`) : '';
    const modelStr = c.model ? pc.white(c.model) : pc.dim('(agent default)');
    console.log(`  ${pc.cyan(c.role.padEnd(16))} ${c.agent}  ${modelStr}${effStr}`);
  }
  console.log('');

  // Persist
  const saveCfg = loadHydraConfig() as RosterConfig;
  for (const c of changes) {
    saveCfg.roles ??= {};
    saveCfg.roles[c.role] = {
      agent: c.agent,
      model: c.model ?? undefined,
      reasoningEffort: c.reasoningEffort,
    };
  }
  saveHydraConfig(saveCfg);
  console.log(
    `  ${pc.green('✓')} Saved ${String(changes.length)} role update${changes.length > 1 ? 's' : ''} to hydra.config.json`,
  );
  console.log('');
}
