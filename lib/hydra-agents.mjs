#!/usr/bin/env node
/**
 * Hydra Agent Registry
 *
 * Single source of truth for agent metadata: CLI commands, flags, context limits,
 * strengths, roles, and task affinities. All other Hydra modules import from here.
 */

import os from 'os';
import path from 'path';
import { loadHydraConfig, saveHydraConfig, invalidateConfigCache } from './hydra-config.mjs';

export const AGENTS = {
  claude: {
    label: 'Claude Code (Opus 4.6)',
    cli: 'claude',
    invoke: {
      nonInteractive: (prompt) => ['claude', ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan']],
      interactive: (prompt) => ['claude', [prompt]],
      headless: (prompt, opts = {}) => ['claude', ['-p', prompt, '--output-format', 'json',
        '--permission-mode', opts.permissionMode || 'auto-edit']],
    },
    contextBudget: 180_000,
    contextTier: 'medium',
    strengths: ['architecture', 'planning', 'complex-reasoning', 'code-review', 'safety', 'ambiguity-resolution'],
    weaknesses: ['speed-on-simple-tasks'],
    councilRole: 'architect',
    taskAffinity: {
      planning: 0.95,
      architecture: 0.95,
      review: 0.85,
      refactor: 0.80,
      implementation: 0.60,
      analysis: 0.75,
      testing: 0.50,
    },
    rolePrompt:
      'You are the lead architect. Break down ambiguous requirements, design the approach, sequence work across agents, and make final decisions on trade-offs. You have full codebase access — use it to verify assumptions before delegating.',
    timeout: 7 * 60 * 1000,
  },
  gemini: {
    label: 'Gemini 2.5 Pro',
    cli: 'gemini',
    invoke: {
      nonInteractive: (prompt) => ['gemini', ['-p', prompt, '--approval-mode', 'plan', '-o', 'json']],
      interactive: (prompt) => ['gemini', ['--prompt-interactive', prompt]],
      headless: (prompt, opts = {}) => ['gemini', ['-p', prompt, '--approval-mode',
        opts.permissionMode || 'auto-edit', '-o', 'json']],
    },
    contextBudget: 900_000,
    contextTier: 'large',
    strengths: ['large-context-analysis', 'pattern-recognition', 'inconsistency-detection', 'speed', 'critique'],
    weaknesses: ['structured-output-reliability', 'hallucination-risk', 'complex-multi-step'],
    councilRole: 'analyst',
    taskAffinity: {
      planning: 0.50,
      architecture: 0.55,
      review: 0.90,
      refactor: 0.60,
      implementation: 0.55,
      analysis: 0.95,
      testing: 0.60,
    },
    rolePrompt:
      'You are the analyst and critic. Leverage your large context window to review broad swaths of code. Find inconsistencies, missed edge cases, regression risks, and pattern violations. Be specific — cite file paths and line numbers.',
    timeout: 5 * 60 * 1000,
  },
  codex: {
    label: 'Codex 5.3',
    cli: 'codex',
    invoke: {
      nonInteractive: (prompt, opts = {}) => {
        if (!opts.cwd) {
          throw new Error('Codex invoke requires opts.cwd (project root path)');
        }
        const outPath = opts.outputPath || path.join(os.tmpdir(), `hydra_codex_${Date.now()}.md`);
        return ['codex', ['exec', prompt, '-s', 'read-only', ...(outPath ? ['-o', outPath] : []), '-C', opts.cwd]];
      },
      interactive: (prompt) => ['codex', [prompt]],
      headless: (prompt, opts = {}) => {
        const sandbox = opts.permissionMode === 'full-auto' ? 'full-auto' : 'auto-edit';
        const args = ['exec', prompt, '-s', sandbox];
        if (opts.cwd) args.push('-C', opts.cwd);
        return ['codex', args];
      },
    },
    contextBudget: 120_000,
    contextTier: 'minimal',
    strengths: ['fast-implementation', 'instruction-following', 'focused-coding', 'test-writing', 'sandboxed-safety'],
    weaknesses: ['no-network', 'ambiguity-handling', 'architecture', 'planning'],
    councilRole: 'implementer',
    taskAffinity: {
      planning: 0.20,
      architecture: 0.15,
      review: 0.40,
      refactor: 0.70,
      implementation: 0.95,
      analysis: 0.30,
      testing: 0.85,
    },
    rolePrompt:
      'You are the implementation specialist. You receive precise task specs with exact file paths, function signatures, and definitions of done. Execute the implementation efficiently. Do not redesign — follow the spec. Report exactly what you changed.',
    timeout: 7 * 60 * 1000,
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);
export const AGENT_DISPLAY_ORDER = ['gemini', 'codex', 'claude'];
export const KNOWN_OWNERS = new Set([...AGENT_NAMES, 'human', 'unassigned']);
export const TASK_TYPES = ['planning', 'architecture', 'review', 'refactor', 'implementation', 'analysis', 'testing'];

export function getAgent(name) {
  return AGENTS[name] || null;
}

export function bestAgentFor(taskType) {
  return AGENT_NAMES.reduce((best, name) =>
    (AGENTS[name].taskAffinity[taskType] || 0) > (AGENTS[best].taskAffinity[taskType] || 0) ? name : best
  );
}

/**
 * Get the default verification partner for an agent.
 * Returns the configured pairing from config, or a sensible default.
 */
export function getVerifier(producerAgent) {
  const cfg = loadHydraConfig();
  const pairings = cfg.crossModelVerification?.pairings;
  if (pairings && pairings[producerAgent]) {
    return pairings[producerAgent];
  }
  // Default pairings
  const defaults = { gemini: 'claude', codex: 'claude', claude: 'gemini' };
  return defaults[producerAgent] || 'claude';
}

export function classifyTask(title, notes = '') {
  const text = `${title} ${notes}`.toLowerCase();
  if (/plan|design|architect|break.?down|decide|strategy/.test(text)) return 'planning';
  if (/review|audit|check|verify|validate|inspect/.test(text)) return 'review';
  if (/refactor|rename|extract|consolidate|reorganize/.test(text)) return 'refactor';
  if (/test|spec|coverage|assert/.test(text)) return 'testing';
  if (/analyze|investigate|find|search|identify|scan/.test(text)) return 'analysis';
  if (/architect|schema|migration|structure/.test(text)) return 'architecture';
  return 'implementation';
}

// ── Model Management ─────────────────────────────────────────────────────────

/**
 * Resolve shorthand like "sonnet" to full model ID for an agent.
 * Lookup chain: config aliases → config model presets → passthrough.
 */
export function resolveModelId(agentName, shorthand) {
  if (!shorthand) return null;
  const lower = String(shorthand).toLowerCase();
  const cfg = loadHydraConfig();

  // 1. Config aliases (single source of truth, replaces hardcoded MODEL_ALIASES)
  const aliases = cfg.aliases?.[agentName];
  if (aliases && aliases[lower]) return aliases[lower];

  // 2. Preset keys in models config (default/fast/cheap)
  const agentModels = cfg.models?.[agentName];
  if (agentModels && agentModels[lower]) return agentModels[lower];

  // 3. Assume it's already a full model ID
  return shorthand;
}

/**
 * Get the current global mode name.
 */
export function getMode() {
  const cfg = loadHydraConfig();
  return cfg.mode || 'performance';
}

/**
 * Set global mode. Validates against modeTiers. Resets all per-agent overrides.
 * @param {string} modeName - e.g. "performance", "balanced", "economy"
 */
export function setMode(modeName) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  const tiers = cfg.modeTiers || {};
  if (!tiers[modeName]) {
    throw new Error(`Unknown mode "${modeName}". Available: ${Object.keys(tiers).join(', ')}`);
  }
  cfg.mode = modeName;
  // Reset all per-agent overrides so they follow the new mode tier
  for (const agent of AGENT_NAMES) {
    if (cfg.models[agent]) {
      cfg.models[agent].active = 'default';
    }
  }
  saveHydraConfig(cfg);
  return modeName;
}

/**
 * Reset a single agent's model override so it follows the mode tier.
 */
export function resetAgentModel(agentName) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (cfg.models[agentName]) {
    cfg.models[agentName].active = 'default';
    saveHydraConfig(cfg);
  }
  return getActiveModel(agentName);
}

/**
 * Get the active model ID for an agent.
 * Priority: env var → per-agent override → mode tier → agent default
 */
export function getActiveModel(agentName) {
  // 1. Environment variable override
  const envKey = `HYDRA_${agentName.toUpperCase()}_MODEL`;
  const envVal = process.env[envKey];
  if (envVal) return resolveModelId(agentName, envVal) || envVal;

  // 2. Config file
  const cfg = loadHydraConfig();
  const agentModels = cfg.models?.[agentName];
  if (!agentModels) return null;

  const activeKey = agentModels.active || 'default';

  // 3. Per-agent override (active is NOT "default")
  if (activeKey !== 'default') {
    return agentModels[activeKey] || resolveModelId(agentName, activeKey) || agentModels.default || null;
  }

  // 4. Mode tier resolution
  const mode = cfg.mode || 'performance';
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName];
  if (tierPreset && agentModels[tierPreset]) {
    return agentModels[tierPreset];
  }

  // 5. Fallback to agent default
  return agentModels.default || null;
}

/**
 * Set the active model for an agent. Persists to hydra.config.json.
 * @param {string} agentName - gemini, codex, or claude
 * @param {string} modelKeyOrId - preset key (e.g. "fast", "sonnet") or full model ID
 */
export function setActiveModel(agentName, modelKeyOrId) {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  if (!cfg.models[agentName]) {
    cfg.models[agentName] = {};
  }

  // If it's a known preset key (default/fast/cheap), store as key
  const agentModels = cfg.models[agentName];
  if (['default', 'fast', 'cheap'].includes(modelKeyOrId) && agentModels[modelKeyOrId]) {
    agentModels.active = modelKeyOrId;
  } else {
    // Resolve to full ID and store
    const resolved = resolveModelId(agentName, modelKeyOrId) || modelKeyOrId;
    agentModels.active = resolved;
  }

  saveHydraConfig(cfg);
  return getActiveModel(agentName);
}

/**
 * Get CLI flags for the active model of an agent.
 * Returns array like ['--model', 'claude-sonnet-4-5-20250929'] or empty array if default.
 */
export function getModelFlags(agentName) {
  const modelId = getActiveModel(agentName);
  const cfg = loadHydraConfig();
  const defaultId = cfg.models?.[agentName]?.default;

  // If active model is the agent's default, no flags needed
  if (!modelId || modelId === defaultId) return [];

  return ['--model', modelId];
}

/**
 * Get a summary of all agent model configurations, including mode and tier source.
 */
export function getModelSummary() {
  const cfg = loadHydraConfig();
  const mode = cfg.mode || 'performance';
  const summary = {};
  const orderedAgents = [
    ...AGENT_DISPLAY_ORDER.filter((agent) => AGENT_NAMES.includes(agent)),
    ...AGENT_NAMES.filter((agent) => !AGENT_DISPLAY_ORDER.includes(agent)),
  ];
  for (const agent of orderedAgents) {
    const activeModel = getActiveModel(agent);
    const agentModels = cfg.models?.[agent] || {};
    const activeKey = agentModels.active || 'default';
    const isOverride = activeKey !== 'default';
    const tierPreset = cfg.modeTiers?.[mode]?.[agent] || 'default';

    summary[agent] = {
      active: activeModel || agentModels.default || 'unknown',
      isDefault: !isOverride && activeModel === agentModels.default,
      isOverride,
      tierSource: isOverride ? 'override' : `${mode} → ${tierPreset}`,
      presets: Object.fromEntries(
        Object.entries(agentModels).filter(([k]) => !['active'].includes(k))
      ),
    };
  }
  summary._mode = mode;
  return summary;
}
