/**
 * Hydra Agents Wizard — Interactive wizard for registering custom CLI and API agents.
 *
 * Exports: runAgentsWizard(rl), buildCustomAgentEntry(), parseArgsTemplate(), validateAgentName()
 * Called by hydra-operator.mjs via: :agents add
 */

import os from 'node:os';
import path from 'node:path';
import type { Interface as ReadlineInterface } from 'node:readline';
import { promptChoice } from './hydra-prompt-choice.ts';
import { loadHydraConfig, saveHydraConfig, AFFINITY_PRESETS } from './hydra-config.ts';
import { registerCustomAgentMcp, KNOWN_CLI_MCP_PATHS } from './hydra-setup.ts';
import type { CustomAgentDef } from './types.ts';

const RESERVED_NAMES = ['claude', 'gemini', 'codex', 'local'];

/** Fields collected by the wizard before building the agent entry. */
interface WizardFields {
  name: string;
  type: 'cli' | 'api';
  cmd?: string;
  argsTemplate?: string;
  responseParser?: string;
  baseUrl?: string;
  model?: string;
  contextBudget?: number;
  affinityPreset?: string;
  councilRole?: string | null;
  displayName?: string;
  enabled?: boolean;
}

/**
 * Validate a custom agent name.
 * Returns an error message, or null if valid.
 */
export function validateAgentName(name: string): string | null {
  if (name.length === 0 || !name.trim()) return 'Name cannot be empty';
  if (RESERVED_NAMES.includes(name.toLowerCase())) return `"${name}" is a reserved agent name`;
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    return 'Name must be lowercase alphanumeric with hyphens (e.g. copilot, my-agent)';
  return null;
}

/**
 * Split a space-separated args template string into an array.
 * e.g. "copilot suggest -p {prompt}" → ['copilot', 'suggest', '-p', '{prompt}']
 */
export function parseArgsTemplate(template: string): string[] {
  return template.trim().split(/\s+/).filter(Boolean);
}

/**
 * Build a customAgents[] entry from wizard field values.
 */
export function buildCustomAgentEntry(fields: WizardFields): CustomAgentDef {
  const { name, type, affinityPreset, councilRole, contextBudget, enabled } = fields;
  const taskAffinity =
    (
      AFFINITY_PRESETS as Record<
        string,
        (typeof AFFINITY_PRESETS)[keyof typeof AFFINITY_PRESETS] | undefined
      >
    )[affinityPreset ?? 'balanced'] ?? AFFINITY_PRESETS['balanced'];

  const base: CustomAgentDef = {
    name,
    type,
    displayName: fields.displayName ?? name,
    contextBudget: Number(contextBudget) || 32000,
    councilRole: councilRole ?? null,
    taskAffinity,
    enabled: enabled !== false,
  };

  if (type === 'cli') {
    const args = parseArgsTemplate(fields.argsTemplate ?? '{prompt}');
    const invokeEntry = { cmd: fields.cmd ?? '', args };
    return {
      ...base,
      invoke: { nonInteractive: invokeEntry, headless: invokeEntry },
      responseParser: fields.responseParser ?? 'plaintext',
    };
  }

  // API type
  return {
    ...base,
    baseUrl: fields.baseUrl ?? 'http://localhost:11434/v1',
    model: fields.model ?? 'default',
  };
}

/** Interactive wizard for adding a custom agent. */
export async function runAgentsWizard(rl: ReadlineInterface): Promise<void> {
  console.log('');
  console.log('  Custom Agent Setup Wizard');
  console.log('  ─────────────────────────');

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => {
      rl.question(`  ${question}: `, (ans) => {
        resolve(ans.trim());
      });
    });
  }

  // 1. Name
  let name!: string;
  let nameError!: string | null;
  do {
    // eslint-disable-next-line no-await-in-loop -- intentionally sequential: do-while retry loop for interactive user-input validation; each iteration depends on the previous answer
    name = await ask('Agent name (e.g. copilot, mixtral)');
    nameError = validateAgentName(name);
    if (nameError) console.log(`  ✗ ${nameError}`);
  } while (nameError !== null);

  // 2. Type
  const typeChoice = await promptChoice(rl, {
    title: 'Agent type',
    choices: [
      {
        value: 'cli',
        label: 'CLI agent',
        hint: 'Spawns a local CLI tool (e.g. gh copilot, aider)',
      },
      {
        value: 'api',
        label: 'API endpoint',
        hint: 'Calls an OpenAI-compatible HTTP API (e.g. Ollama, LM Studio)',
      },
    ],
  });
  const agentType = (typeChoice as { value: string }).value as 'cli' | 'api';

  const fields: WizardFields = { name, type: agentType };

  if (agentType === 'cli') {
    fields.cmd = await ask('CLI command (e.g. gh, aider, continue)');
    fields.argsTemplate = await ask('Args template (e.g. copilot suggest -p {prompt})');

    const parserChoice = await promptChoice(rl, {
      title: 'Response parser',
      choices: [
        { value: 'plaintext', label: 'Plaintext', hint: 'Capture stdout as-is' },
        {
          value: 'json',
          label: 'JSON',
          hint: 'Parse JSON stdout, extract .content/.text field',
        },
        { value: 'markdown', label: 'Markdown', hint: 'Capture markdown output as-is' },
      ],
      // autoAccept is not a formal promptChoice option — omitted
    });
    fields.responseParser = (parserChoice as { value: string }).value;
  } else {
    fields.baseUrl = await ask('Base URL (e.g. http://localhost:11434/v1)');
    fields.model = await ask('Model name (e.g. mixtral:8x7b, llama3.2)');
  }

  // Context budget
  const budgetRaw = await ask('Context budget in tokens (default: 32000)');
  fields.contextBudget = Number.parseInt(budgetRaw, 10) || 32000;

  // Task profile
  const profileChoice = await promptChoice(rl, {
    title: 'Task affinity profile',
    choices: [
      { value: 'balanced', label: 'Balanced', hint: 'Equal weight across all task types' },
      {
        value: 'code-focused',
        label: 'Code-focused',
        hint: 'High weight for implementation, refactor, testing',
      },
      {
        value: 'review-focused',
        label: 'Review-focused',
        hint: 'High weight for review, analysis, security',
      },
      {
        value: 'research-focused',
        label: 'Research-focused',
        hint: 'High weight for research, documentation, analysis',
      },
    ],
  });
  fields.affinityPreset = (profileChoice as { value: string }).value;

  // Council role
  const councilChoice = await promptChoice(rl, {
    title: 'Council role',
    choices: [
      { value: null, label: 'None', hint: 'Excluded from council deliberation' },
      { value: 'analyst', label: 'Analyst', hint: 'Critique and analysis role' },
      { value: 'architect', label: 'Architect', hint: 'Planning and architecture role' },
      { value: 'implementer', label: 'Implementer', hint: 'Implementation role' },
    ],
  });
  fields.councilRole = (councilChoice as { value: string | null }).value;

  // Build entry
  const entry = buildCustomAgentEntry(fields);

  // MCP setup (CLI agents only)
  let mcpConfig: { configPath: string | null; format: string } | null = null;
  if (agentType === 'cli') {
    const knownPath = fields.cmd
      ? (KNOWN_CLI_MCP_PATHS as Record<string, string | null | undefined>)[fields.cmd]
      : undefined;
    const mcpChoices = [
      {
        value: 'auto',
        label: 'Auto-detect',
        hint: knownPath ? `Try ${knownPath}` : 'Attempt auto-detection',
      },
      {
        value: 'manual-path',
        label: 'Enter config path',
        hint: "Provide the path to your agent's config file",
      },
      { value: 'skip', label: 'Skip', hint: 'Show manual instructions at the end' },
    ];
    const mcpChoice = await promptChoice(rl, { title: 'MCP registration', choices: mcpChoices });

    if ((mcpChoice as { value: string }).value === 'auto' && knownPath) {
      mcpConfig = { configPath: path.join(os.homedir(), knownPath), format: 'json' };
    } else if ((mcpChoice as { value: string }).value === 'manual-path') {
      const rawPath = await ask('Path to agent config file (absolute path)');
      const fmt = await ask('Config format (json / other)');
      mcpConfig = { configPath: rawPath, format: fmt };
    }
  }

  // Save to config
  const cfg = loadHydraConfig();
  const customAgents = [...cfg.agents.customAgents];
  const existing = customAgents.findIndex((a) => a.name === entry.name);
  if (existing >= 0) {
    customAgents[existing] = entry;
  } else {
    customAgents.push(entry);
  }
  saveHydraConfig({ agents: { ...cfg.agents, customAgents } });

  console.log(`\n  ✓ Agent "${entry.name}" saved to config`);

  // MCP registration
  if (mcpConfig) {
    const mcpResult = registerCustomAgentMcp(mcpConfig);
    if (mcpResult.status === 'added' || mcpResult.status === 'updated') {
      console.log(`  ✓ Hydra MCP server registered with ${entry.name}`);
    } else if (mcpResult.status === 'exists') {
      console.log(`  ✓ Hydra MCP already registered with ${entry.name}`);
    } else {
      console.log('\n  Manual MCP setup required:\n');
      console.log(
        mcpResult.instructions
          ?.split('\n')
          .map((l) => `    ${l}`)
          .join('\n'),
      );
    }
  } else if (agentType === 'cli') {
    const manualResult = registerCustomAgentMcp({ configPath: null });
    console.log('\n  MCP setup (manual):\n');
    console.log(
      manualResult.instructions
        ?.split('\n')
        .map((l) => `    ${l}`)
        .join('\n'),
    );
  }

  console.log(`\n  Restart the operator for "${entry.name}" to be available for dispatch.\n`);
}
