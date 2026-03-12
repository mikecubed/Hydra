/**
 * Hydra Agent Registry
 *
 * Dynamic agent registry with support for physical agents (CLI-backed)
 * and virtual sub-agents (specialized roles running on a physical agent's CLI).
 *
 * Physical agents: claude, gemini, codex, local, copilot — the CLI execution backends.
 * Virtual agents: specialized roles (e.g. security-reviewer, test-writer)
 * that inherit CLI/invoke from a base physical agent but carry their own
 * prompts, affinities, and tags.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentDef,
  AgentInvoke,
  HeadlessOpts,
  AgentResult,
  TaskType,
  ModelConfig,
} from './types.ts';
import {
  loadHydraConfig,
  saveHydraConfig,
  invalidateConfigCache,
  HYDRA_ROOT,
} from './hydra-config.ts';
import {
  getReasoningCapsMap as _getReasoningCapsMap,
  resolveCliModelId,
} from './hydra-model-profiles.ts';
import { extractCodexText, extractCodexUsage } from './hydra-shared/codex-helpers.ts';
import { DISPATCH_PREFERENCE_ORDER } from './hydra-routing-constants.ts';

// ── Agent Type Enum ──────────────────────────────────────────────────────────

export const AGENT_TYPE = { PHYSICAL: 'physical', VIRTUAL: 'virtual' };

// ── Private Registry ─────────────────────────────────────────────────────────

const _registry = new Map<string, AgentDef>();

// ── Physical Agent Definitions ───────────────────────────────────────────────

const PHYSICAL_AGENTS: Record<string, Partial<AgentDef>> = {
  claude: {
    name: 'claude',
    type: 'physical',
    displayName: 'Claude Code',
    label: 'Claude Code (Opus 4.6)',
    cli: 'claude',
    invoke: {
      nonInteractive: (prompt: string): [string, string[]] => [
        'claude',
        ['-p', prompt, '--output-format', 'json', '--permission-mode', 'plan'],
      ],
      interactive: (prompt: string): [string, string[]] => ['claude', [prompt]],
      headless: (prompt: string, opts: HeadlessOpts = {}): [string, string[]] => {
        const PERM: Record<string, string> = {
          'auto-edit': 'acceptEdits',
          plan: 'plan',
          'full-auto': 'bypassPermissions',
        };
        const perm =
          (opts.permissionMode ? PERM[opts.permissionMode] : undefined) ??
          opts.permissionMode ??
          'acceptEdits';
        const args = ['--output-format', 'json', '--permission-mode', perm];
        if (!opts.stdinPrompt) {
          args.unshift('-p', prompt);
        }
        if (opts.model) args.push('--model', opts.model);
        return ['claude', args];
      },
    },
    contextBudget: 180_000,
    contextTier: 'medium',
    strengths: [
      'architecture',
      'planning',
      'complex-reasoning',
      'code-review',
      'safety',
      'ambiguity-resolution',
    ],
    weaknesses: ['speed-on-simple-tasks'],
    councilRole: 'architect',
    taskAffinity: {
      planning: 0.95,
      architecture: 0.95,
      review: 0.85,
      refactor: 0.8,
      implementation: 0.6,
      analysis: 0.75,
      testing: 0.5,
      research: 0.7,
      documentation: 0.8,
      security: 0.7,
    },
    rolePrompt: `You are the lead architect. Your responsibilities:

1. **Architectural Decisions**: Select patterns and make trade-off decisions (consistency vs flexibility, performance vs readability). Document your reasoning.
2. **Task Decomposition**: Break ambiguous requirements into concrete, actionable tasks with clear boundaries. Each task should have a single owner and a verifiable definition of done.
3. **Delegation Strategy**: Sequence work across agents — analyst first for review, implementer for coding, yourself for planning. Avoid bottlenecks.
4. **Verification**: Always read relevant code before delegating. Verify assumptions against the actual codebase — never delegate based on guesses.

Output structure: Plan → Task breakdown → Dependency graph → Risk assessment.`,
    timeout: 7 * 60 * 1000,
    tags: ['architecture', 'planning', 'delegation'],
    enabled: true,
    features: { executeMode: 'spawn', jsonOutput: true, stdinPrompt: true, reasoningEffort: false },
    parseOutput(stdout: string): AgentResult {
      try {
        const parsed = JSON.parse(stdout) as {
          type?: string;
          result?: string;
          content?: string;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          };
          cost_usd?: number | null;
        };
        if (parsed.type === 'result') {
          const u = parsed.usage ?? {};
          return {
            output: parsed.result ?? parsed.content ?? stdout,
            tokenUsage: {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadTokens: u.cache_read_input_tokens ?? 0,
              totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            },
            costUsd: parsed.cost_usd ?? null,
          };
        }
      } catch { /* ignored */ }
      return { output: stdout, tokenUsage: null, costUsd: null };
    },
    errorPatterns: {
      authRequired: /authentication.*required|invalid.*api.*key|unauthorized/i,
      rateLimited: /rate.*limit|too many requests/i,
      quotaExhausted: /spending_limit|credit_balance|usage_limit/i,
      networkError: /ECONNREFUSED|ENOTFOUND|network error/i,
    },
    modelBelongsTo: (id: string) => id.toLowerCase().startsWith('claude-'),
    async quotaVerify(apiKey?: string) {
      if (!apiKey)
        return {
          verified: 'unknown',
          reason: 'OAuth CLI auth — set ANTHROPIC_API_KEY to enable verification',
        };
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 402 || res.status === 529)
        return { verified: true, status: res.status, reason: 'billing' };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        return { verified: /spending_limit|credit_balance|usage_limit/i.test(body), status: 429 };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${String(res.status)}` };
    },
    economyModel: () => 'claude-sonnet-4-5-20250929',
    readInstructions: (f: string) =>
      `Read these files first:\n1) ${f}\n2) docs/QUICK_REFERENCE.md\n3) docs/coordination/AI_SYNC_STATE.json\n4) docs/coordination/AI_SYNC_LOG.md`,
    taskRules: [
      '- Create detailed task specs for Codex (file paths, signatures, DoD) in your handoffs.',
    ],
  },
  gemini: {
    name: 'gemini',
    type: 'physical',
    displayName: 'Gemini',
    label: 'Gemini 3 Pro',
    cli: 'gemini',
    invoke: {
      nonInteractive: (prompt: string): [string, string[]] => [
        'gemini',
        ['-p', prompt, '--approval-mode', 'plan', '-o', 'json'],
      ],
      interactive: (prompt: string): [string, string[]] => [
        'gemini',
        ['--prompt-interactive', prompt],
      ],
      headless: (prompt: string, opts: HeadlessOpts = {}): [string, string[]] => [
        'gemini',
        ['-p', prompt, '--approval-mode', opts.permissionMode ?? 'auto-edit', '-o', 'json'],
      ],
    },
    contextBudget: 2_000_000,
    contextTier: 'large',
    strengths: [
      'large-context-analysis',
      'pattern-recognition',
      'inconsistency-detection',
      'speed',
      'critique',
    ],
    weaknesses: ['structured-output-reliability', 'hallucination-risk', 'complex-multi-step'],
    councilRole: 'analyst',
    taskAffinity: {
      planning: 0.7,
      architecture: 0.75,
      review: 0.95,
      refactor: 0.65,
      implementation: 0.6,
      analysis: 0.98,
      testing: 0.65,
      research: 0.9,
      documentation: 0.5,
      security: 0.85,
    },
    rolePrompt: `You are the analyst and critic. Your responsibilities:

1. **Structured Review**: Evaluate code across categories — correctness, performance, security, maintainability. Rate severity for each finding.
2. **Large-Context Analysis**: Leverage your context window to review cross-file consistency, detect pattern violations, and spot regressions across the codebase.
3. **Specific Citations**: Always cite file paths and line numbers. Never give vague feedback — point to exact code.
4. **Checklist Coverage**: Check for common issues — unhandled errors, race conditions, missing validation, inconsistent naming, dead code, missing tests.

Output structure: Findings by severity → Code citations → Suggested fixes.`,
    timeout: 5 * 60 * 1000,
    tags: ['analysis', 'review', 'critique'],
    enabled: true,
    features: {
      executeMode: 'spawn',
      jsonOutput: true,
      stdinPrompt: false,
      reasoningEffort: false,
    },
    parseOutput(stdout: string): AgentResult {
      try {
        const parsed = JSON.parse(stdout) as { response?: string; text?: string };
        return {
          output: parsed.response ?? parsed.text ?? stdout,
          tokenUsage: null,
          costUsd: null,
        };
      } catch { /* ignored */ }
      return { output: stdout, tokenUsage: null, costUsd: null };
    },
    errorPatterns: {
      authRequired: /authentication required|invalid.*key|API_KEY_INVALID/i,
      rateLimited: /RATE_LIMIT_EXCEEDED|too many requests/i,
      quotaExhausted: /QUOTA_EXHAUSTED.*(?:day|month)|daily.*quota|monthly.*quota/i,
      networkError: /ECONNREFUSED|ENOTFOUND/i,
    },
    modelBelongsTo: (id: string) => id.toLowerCase().startsWith('gemini-'),
    async quotaVerify(apiKey?: string) {
      if (!apiKey)
        return {
          verified: 'unknown',
          reason: 'OAuth CLI auth — set GEMINI_API_KEY to enable verification',
        };
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1`,
        { signal: AbortSignal.timeout(6000) },
      );
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        return {
          verified: /QUOTA_EXHAUSTED.*(?:day|month)|daily.*quota|monthly.*quota/i.test(body),
          status: 429,
        };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${String(res.status)}` };
    },
    economyModel: () => 'gemini-3-flash-preview',
    readInstructions: (f: string) =>
      `Read broadly: ${f}, QUICK_REFERENCE.md, AI_SYNC_STATE.json, AI_SYNC_LOG.md, and all files in your task scope.`,
    taskRules: ['- Cite specific file paths and line numbers in all findings.'],
  },
  codex: {
    name: 'codex',
    type: 'physical',
    displayName: 'Codex',
    label: 'GPT-5.4',
    cli: 'codex',
    invoke: {
      nonInteractive: (prompt: string, opts: HeadlessOpts = {}): [string, string[]] => {
        if (!opts.cwd) {
          throw new Error('Codex invoke requires opts.cwd (project root path)');
        }
        return [
          'codex',
          [
            'exec',
            prompt,
            '-s',
            'read-only',
            ...(opts.outputPath ? ['-o', opts.outputPath] : []),
            '-C',
            opts.cwd,
          ],
        ];
      },
      interactive: (prompt: string): [string, string[]] => ['codex', [prompt]],
      headless: (_prompt: string, opts: HeadlessOpts = {}): [string, string[]] => {
        const args = ['exec', '-'];
        if (opts.permissionMode === 'full-auto') {
          console.warn(
            '[SECURITY WARNING] Codex running with --dangerously-bypass-approvals-and-sandbox. Code execution is unrestricted.',
          );
          args.push('--dangerously-bypass-approvals-and-sandbox');
        } else {
          args.push('--full-auto');
        }
        if (opts.jsonOutput) args.push('--json');
        const model = opts.model ?? getActiveModel('codex');
        if (model) args.push('--model', model);
        if (opts.cwd) args.push('-C', opts.cwd);
        return ['codex', args];
      },
    },
    contextBudget: 120_000,
    contextTier: 'minimal',
    strengths: [
      'fast-implementation',
      'instruction-following',
      'focused-coding',
      'test-writing',
      'sandboxed-safety',
    ],
    weaknesses: ['no-network', 'ambiguity-handling', 'architecture', 'planning'],
    councilRole: 'implementer',
    taskAffinity: {
      planning: 0.2,
      architecture: 0.15,
      review: 0.4,
      refactor: 0.7,
      implementation: 0.95,
      analysis: 0.3,
      testing: 0.85,
      research: 0.25,
      documentation: 0.4,
      security: 0.35,
    },
    rolePrompt: `You are the implementation specialist. Your responsibilities:

1. **Precise Execution**: You receive task specs with exact file paths, function signatures, and definitions of done. Follow the spec — do not redesign.
2. **Conventions**: ESM only, picocolors for colors, Node.js built-ins only (no external deps). Match existing code style.
3. **Change Reporting**: Report exactly what you changed — files modified, functions added/changed, tests affected. Use a structured format.
4. **Edge Cases**: Handle error paths and edge cases. Validate inputs at system boundaries. Add tests for non-obvious behavior.

Sandbox-aware: no network access, file-system focused. Work within your sandbox constraints.`,
    timeout: 7 * 60 * 1000,
    tags: ['implementation', 'coding', 'testing'],
    enabled: true,
    features: { executeMode: 'spawn', jsonOutput: true, stdinPrompt: true, reasoningEffort: true },
    parseOutput(stdout: string): AgentResult {
      return {
        output: extractCodexText(stdout) ?? stdout,
        tokenUsage: extractCodexUsage(stdout),
        costUsd: null,
      };
    },
    errorPatterns: {
      authRequired: /invalid.*api.*key|unauthorized|authentication/i,
      rateLimited: /rate.*limit|too many requests/i,
      quotaExhausted: /usage_limit|spending_limit|hard_limit|insufficient_quota/i,
      networkError: /ECONNREFUSED|ENOTFOUND/i,
    },
    modelBelongsTo: (id: string) => {
      const l = id.toLowerCase();
      return (
        l.startsWith('gpt-') ||
        l.startsWith('o1') ||
        l.startsWith('o3') ||
        l.startsWith('o4') ||
        l.startsWith('o5') ||
        l.startsWith('codex')
      );
    },
    async quotaVerify(apiKey?: string, { hintText }: { hintText?: string } = {}) {
      if (hintText && /chatgpt\.com\/codex/i.test(hintText)) {
        return {
          verified: 'unknown',
          reason: 'Codex CLI ChatGPT quota — not verifiable via OPENAI_API_KEY',
        };
      }
      if (!apiKey) return { verified: 'unknown', reason: 'no OPENAI_API_KEY' };
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) return { verified: false, status: res.status };
      if (res.status === 402) return { verified: true, status: 402, reason: 'billing' };
      if (res.status === 429) {
        const body = await res.text().catch(() => '');
        const isQuota = /usage_limit|spending_limit|hard_limit|insufficient_quota/i.test(body);
        return { verified: isQuota, status: 429, reason: isQuota ? 'quota' : 'rate-limit' };
      }
      return { verified: 'unknown', status: res.status, reason: `HTTP ${String(res.status)}` };
    },
    economyModel: (budgetCfg?: { handoffModel?: string }) => budgetCfg?.handoffModel ?? 'o4-mini',
    readInstructions: (f: string) =>
      `Read ${f} for conventions, then read task-specific files listed in your assigned task.`,
    taskRules: ['- Do not redesign — follow the spec. Report exactly what you changed.'],
  },
  local: {
    name: 'local',
    type: 'physical',
    displayName: 'Local',
    label: 'Local LLM (OpenAI-compat)',
    cli: null,
    invoke: {
      nonInteractive: null,
      interactive: null,
      headless: null,
    },
    contextBudget: 32_000,
    strengths: ['implementation', 'refactor', 'testing', 'low-latency', 'cost-zero'],
    weaknesses: ['planning', 'reasoning', 'research'],
    councilRole: null,
    taskAffinity: {
      planning: 0.25,
      architecture: 0.2,
      review: 0.45,
      refactor: 0.8,
      implementation: 0.82,
      analysis: 0.4,
      testing: 0.7,
      security: 0.3,
      research: 0.0,
      documentation: 0.5,
    },
    rolePrompt: 'You are a local AI assistant. Be concise and implementation-focused.',
    timeout: 3 * 60 * 1000,
    tags: ['local', 'free', 'offline'],
    enabled: true,
    features: { executeMode: 'api', jsonOutput: false, stdinPrompt: false, reasoningEffort: false },
    parseOutput: (stdout: string): AgentResult => ({
      output: stdout,
      tokenUsage: null,
      costUsd: null,
    }),
    errorPatterns: { networkError: /ECONNREFUSED|ENOTFOUND|connection refused/i },
    modelBelongsTo: (id: string) => {
      const cfg = loadHydraConfig();
      const localModel = cfg.local.model;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- localModel may be absent at runtime
      return id.toLowerCase() === localModel?.toLowerCase();
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- async required by plugin interface
    quotaVerify: async () => null,
    economyModel: () => null,
    readInstructions: (f: string) => `Read ${f} first.`,
    taskRules: [],
  },
  copilot: {
    name: 'copilot',
    type: 'physical',
    displayName: 'Copilot',
    label: 'GitHub Copilot CLI',
    cli: 'copilot',
    invoke: {
      // nonInteractive: plan-mode approval (no --allow flags); callers must not expect
      // file-modification side-effects from nonInteractive calls.
      nonInteractive: (prompt: string, opts: HeadlessOpts = {}): [string, string[]] => {
        const args = ['-p', prompt];
        if (opts.model) args.push('--model', resolveCliModelId(opts.model));
        return ['copilot', args];
      },
      interactive: (prompt: string): [string, string[]] => ['copilot', [prompt]],
      headless: (prompt: string, opts: HeadlessOpts = {}): [string, string[]] => {
        const args = ['-p', prompt, '--silent'];
        if (opts.model) args.push('--model', resolveCliModelId(opts.model));
        // JSON output — enabled by default (features.jsonOutput: true)
        if (opts.jsonOutput !== false) args.push('--output-format', 'json');
        // Disable ask_user so agent does not stall waiting for input in headless mode
        args.push('--no-ask-user');
        if (opts.permissionMode === 'full-auto') {
          args.push('--allow-all-tools');
        } else if (opts.permissionMode === 'auto-edit') {
          args.push('--allow-tool', 'shell(git:*)', '--allow-tool', 'write');
        }
        // Default (plan): no --allow flags
        return ['copilot', args];
      },
    },
    contextBudget: 128_000,
    contextTier: 'medium',

    features: {
      executeMode: 'spawn',
      jsonOutput: true, // --output-format json is live; output is JSONL event stream
      stdinPrompt: false, // uses -p flag, not stdin
      reasoningEffort: false,
    },

    parseOutput(stdout: string, opts?: { jsonOutput?: boolean }): AgentResult {
      if (opts?.jsonOutput) {
        try {
          const lines = stdout.split(/\r?\n/).filter(Boolean);

          // Parse JSONL line-by-line — skip non-JSON lines (warnings, prompts, etc.)
          const events: Record<string, unknown>[] = [];
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line) as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                events.push(parsed as Record<string, unknown>);
              }
            } catch {
              // Skip lines that are not valid JSON
            }
          }

          // Find the last assistant.message that is a final text response
          // (toolRequests is empty, meaning it is the final answer turn)
          const messages = events.filter((e) => {
            if (e['type'] !== 'assistant.message') return false;
            const data = e['data'];
            if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
            const toolRequests = (data as Record<string, unknown>)['toolRequests'];
            return Array.isArray(toolRequests) && toolRequests.length === 0;
          });
          const lastMsg = messages.at(-1);
          const lastMsgData =
            lastMsg?.['data'] &&
            typeof lastMsg['data'] === 'object' &&
            !Array.isArray(lastMsg['data'])
              ? (lastMsg['data'] as Record<string, unknown>)
              : undefined;
          const content = lastMsgData?.['content'];
          const output = typeof content === 'string' ? content : stdout;

          // Extract usage from the final result event
          const resultEvent = [...events].reverse().find((e) => e['type'] === 'result');
          let premiumRequests: number | null = null;
          if (resultEvent) {
            const usage = resultEvent['usage'];
            if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
              const pr = (usage as Record<string, unknown>)['premiumRequests'];
              if (typeof pr === 'number') premiumRequests = pr;
            }
          }

          return {
            output,
            tokenUsage: premiumRequests !== null ? { premiumRequests } : null,
            costUsd: null,
          };
        } catch {
          // Fall through to plain text
        }
      }
      return { output: stdout, tokenUsage: null, costUsd: null };
    },

    errorPatterns: {
      authRequired: /not logged in|authentication required|copilot subscription|no copilot access/i,
      rateLimited: /rate limit|quota exceeded|too many requests/i,
      quotaExhausted: /premium request.*limit|monthly.*quota.*exceeded/i,
      networkError: /network error|connection refused|ECONNREFUSED|ENOTFOUND/i,
      subscriptionRequired: /copilot plan required|upgrade your plan/i,
    },

    modelBelongsTo: (id: string) => id.toLowerCase().startsWith('copilot-'),

    // Optimistic auth — no proactive check. Browser-based device flow means there is
    // no env var or status command to verify. Auth failures surface at task-execution time.
    quotaVerify: () => Promise.resolve(null),

    economyModel: () => 'copilot-claude-sonnet-4-6',

    readInstructions: (f: string) =>
      `Read ${f} and any relevant GitHub context (issues, PRs) before responding.`,

    taskRules: ['- Cross-reference with open issues and CI history when reviewing code.'],

    strengths: [
      'github-integration',
      'issue-pr-awareness',
      'ci-workflow',
      'code-suggestion',
      'real-time-assist',
      'mcp-native',
      'multi-model',
    ],
    weaknesses: ['subscription-required', 'github-account-auth', 'complex-architecture'],
    councilRole: 'advisor',
    taskAffinity: {
      planning: 0.65,
      architecture: 0.55,
      review: 0.8,
      refactor: 0.7,
      implementation: 0.75,
      analysis: 0.65,
      testing: 0.7,
      research: 0.6,
      documentation: 0.75,
      security: 0.7,
    },
    rolePrompt: `You are the GitHub integration advisor. Your responsibilities:

1. **GitHub Context**: Leverage your built-in access to GitHub issues, PRs, CI workflows, and repository context. Always use this context to inform your suggestions.
2. **Workflow Automation**: Identify opportunities to automate GitHub workflows — CI improvements, PR templates, issue triage, branch protection.
3. **Code Review Integration**: When reviewing code, cross-reference with open issues, related PRs, and CI failure patterns.
4. **Practical Suggestions**: Prioritize actionable changes over theoretical improvements. Provide \`git\`/\`gh\` CLI commands the team can run immediately.

Output structure: GitHub context summary → Actionable suggestions → Commands to run.`,
    timeout: 7 * 60 * 1000,
    tags: ['github', 'integration', 'copilot', 'advisory'],
    // Disabled by default — set copilot.enabled: true in hydra.config.json after installing the CLI.
    enabled: false,
  },
};

// ── Registry Operations ──────────────────────────────────────────────────────

/**
 * Validate and register an agent definition.
 * @param {string} name - Unique agent name (lowercase, no spaces)
 * @param {object} def - Agent definition object
 */
export function registerAgent(name: string, def: Partial<AgentDef>): AgentDef {
  if (!name || typeof name !== 'string') {
    throw new Error('Agent name must be a non-empty string');
  }
  const lower = name.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(lower)) {
    throw new Error(`Invalid agent name "${name}": must be lowercase alphanumeric with hyphens`);
  }
  const type = (def.type ?? AGENT_TYPE.PHYSICAL) as AgentDef['type'];
  if (type === AGENT_TYPE.VIRTUAL && !def.baseAgent) {
    throw new Error(`Virtual agent "${name}" must specify a baseAgent`);
  }
  if (type === AGENT_TYPE.VIRTUAL && !_registry.has(def.baseAgent!)) {
    throw new Error(`Virtual agent "${name}" references unknown baseAgent "${def.baseAgent ?? ''}"`);
  }

  const _defaultExecuteMode = def.customType === 'api' ? ('api' as const) : ('spawn' as const);

  let _cliValue: string | null;
  if (type === AGENT_TYPE.PHYSICAL) {
    _cliValue = def.cli === undefined ? lower : (def.cli ?? null);
  } else {
    _cliValue = null;
  }

  const entry: AgentDef = {
    name: lower,
    type,
    customType: def.customType ?? null,
    baseAgent: def.baseAgent ?? null,
    displayName: def.displayName ?? name,
    label: def.label ?? def.displayName ?? name,
    cli: _cliValue,
    invoke: type === AGENT_TYPE.PHYSICAL ? (def.invoke ?? null) : null,
    contextBudget: def.contextBudget ?? (type === AGENT_TYPE.VIRTUAL ? null : 120_000),
    contextTier: def.contextTier ?? null,
    strengths: def.strengths ?? [],
    weaknesses: def.weaknesses ?? [],
    councilRole: def.councilRole ?? null,
    taskAffinity: def.taskAffinity ?? {},
    rolePrompt: def.rolePrompt ?? '',
    timeout: def.timeout ?? null,
    tags: def.tags ?? [],
    enabled: def.enabled !== false,
    // Plugin interface defaults — applied to all agents, including custom
    features: {
      executeMode: _defaultExecuteMode,
      jsonOutput: false,
      stdinPrompt: false,
      reasoningEffort: false,
      ...(def.features ?? {}),
    },
    parseOutput:
      def.parseOutput ??
      ((stdout: string): AgentResult => ({ output: stdout, tokenUsage: null, costUsd: null })),
    errorPatterns: def.errorPatterns ?? {},
    modelBelongsTo: def.modelBelongsTo ?? (() => false),
    // eslint-disable-next-line @typescript-eslint/require-await -- async required by plugin interface
    quotaVerify: def.quotaVerify ?? (async () => null),
    economyModel: def.economyModel ?? (() => null),
    readInstructions: def.readInstructions ?? ((f: string) => `Read ${f} first.`),
    taskRules: def.taskRules ?? [],
  };

  _registry.set(lower, entry);
  return entry;
}

/**
 * Unregister a custom/virtual agent. Cannot unregister built-in physical agents.
 */
export function unregisterAgent(name: string): boolean {
  const lower = name.toLowerCase();
  const entry = _registry.get(lower);
  if (!entry) return false;
  if (entry.type === AGENT_TYPE.PHYSICAL && (PHYSICAL_AGENTS as Record<string, unknown>)[lower]) {
    throw new Error(`Cannot unregister built-in physical agent "${lower}"`);
  }
  _registry.delete(lower);
  return true;
}

/**
 * Apply config-driven enabled overrides to a registry entry without mutating it.
 * Agents like `copilot` are disabled in PHYSICAL_AGENTS and activated via config.
 * This is evaluated on every getAgent/listAgents call so _setTestConfig works in tests
 * without needing _resetRegistry.
 */
function _resolveEnabled(entry: AgentDef): boolean {
  if (entry.name === 'copilot') {
    try {
      const cfg = loadHydraConfig();
      return cfg.copilot.enabled;
    } catch {
      return false;
    }
  }
  return entry.enabled;
}

/**
 * Get an agent definition by name. Returns null if not found.
 */
export function getAgent(name: string | null | undefined): AgentDef | null {
  if (!name) return null;
  const entry = _registry.get(name.toLowerCase());
  if (!entry) return null;
  return { ...entry, enabled: _resolveEnabled(entry) };
}

/**
 * Enable or disable an agent by name. Updates the live registry entry in-place.
 * Returns true if the agent was found and updated, false otherwise.
 */
export function setAgentEnabled(name: string, enabled: boolean): boolean {
  const lower = name.toLowerCase();
  const entry = _registry.get(lower);
  if (!entry) return false;
  entry.enabled = enabled;
  return true;
}

/**
 * Resolve a virtual agent to its underlying physical agent.
 * For physical agents, returns the agent itself.
 * Follows the baseAgent chain for virtual agents.
 */
export function resolvePhysicalAgent(name: string | null | undefined): AgentDef | null {
  if (!name) return null;
  let agent = _registry.get(name.toLowerCase());
  if (!agent) return null;
  // Follow baseAgent chain (max 5 hops to prevent infinite loops)
  let hops = 0;
  while (agent.type === AGENT_TYPE.VIRTUAL && agent.baseAgent && hops < 5) {
    agent = _registry.get(agent.baseAgent);
    if (!agent) return null;
    hops++;
  }
  return agent.type === AGENT_TYPE.PHYSICAL ? agent : null;
}

/**
 * List registered agents with optional filtering.
 * @param {object} [opts]
 * @param {'physical'|'virtual'} [opts.type] - Filter by agent type
 * @param {boolean} [opts.enabled] - Filter by enabled status
 * @returns {object[]} Array of agent definitions
 */
interface ListAgentsOpts {
  type?: 'physical' | 'virtual';
  enabled?: boolean;
}

export function listAgents(opts: ListAgentsOpts = {}): AgentDef[] {
  const results: AgentDef[] = [];
  for (const agent of _registry.values()) {
    if (opts.type && agent.type !== opts.type) continue;
    const enabled = _resolveEnabled(agent);
    if (opts.enabled !== undefined && enabled !== opts.enabled) continue;
    results.push({ ...agent, enabled });
  }
  return results;
}

// ── Backward-Compatible Exports ──────────────────────────────────────────────

/**
 * AGENTS — backward-compatible object accessor.
 * Returns physical agents by default (existing code works unchanged).
 */
export const AGENTS: Record<string, AgentDef | undefined> = new Proxy(
  {} as Record<string, AgentDef | undefined>,
  {
    get(_, prop) {
      if (typeof prop === 'symbol') return;
      // Support Object.keys(), for-in, JSON.stringify
      if (prop === 'toJSON') {
        return () => {
          const obj: Record<string, AgentDef> = {};
          for (const [k, v] of _registry) {
            if (v.type === AGENT_TYPE.PHYSICAL) obj[k] = { ...v, enabled: _resolveEnabled(v) };
          }
          return obj;
        };
      }
      const entry = _registry.get(prop);
      return entry ? { ...entry, enabled: _resolveEnabled(entry) } : undefined;
    },
    has(_, prop) {
      return _registry.has(String(prop));
    },
    ownKeys() {
      return [..._registry.entries()]
        .filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL)
        .map(([k]) => k);
    },
    getOwnPropertyDescriptor(_, prop) {
      const val = _registry.get(String(prop));
      if (val?.type === AGENT_TYPE.PHYSICAL) {
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: { ...val, enabled: _resolveEnabled(val) },
        };
      }
      // eslint-disable-next-line unicorn/no-useless-undefined -- Proxy handler must explicitly return undefined for unknown properties
      return undefined;
    },
  },
);

/** Physical agent names only — backward-compatible default */
export const AGENT_NAMES: string[] = new Proxy([] as string[], {
  get(_, prop) {
    const physicalNames = [..._registry.entries()]
      .filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL)
      .map(([k]) => k);
    if (prop === Symbol.iterator) return physicalNames[Symbol.iterator].bind(physicalNames);
    if (prop === 'length') return physicalNames.length;
    if (prop === 'sort') return physicalNames.sort.bind(physicalNames);
    if (prop === 'filter') return physicalNames.filter.bind(physicalNames);
    if (prop === 'map') return physicalNames.map.bind(physicalNames);
    if (prop === 'forEach') return physicalNames.forEach.bind(physicalNames);
    if (prop === 'includes') return physicalNames.includes.bind(physicalNames);
    if (prop === 'indexOf') return physicalNames.indexOf.bind(physicalNames);
    if (prop === 'join') return physicalNames.join.bind(physicalNames);
    if (prop === 'reduce') return physicalNames.reduce.bind(physicalNames);
    if (prop === 'some') return physicalNames.some.bind(physicalNames);
    if (prop === 'every') return physicalNames.every.bind(physicalNames);
    if (prop === 'find') return physicalNames.find.bind(physicalNames);
    if (prop === 'slice') return physicalNames.slice.bind(physicalNames);
    if (prop === 'concat') return physicalNames.concat.bind(physicalNames);
    if (prop === 'flat') return physicalNames.flat.bind(physicalNames);
    if (prop === 'flatMap') return physicalNames.flatMap.bind(physicalNames);
    if (prop === 'entries') return physicalNames.entries.bind(physicalNames);
    if (prop === 'keys') return physicalNames.keys.bind(physicalNames);
    if (prop === 'values') return physicalNames.values.bind(physicalNames);
    if (typeof prop === 'string' && /^\d+$/.test(prop)) return physicalNames[Number(prop)];
    return (physicalNames as unknown as Record<string | symbol, unknown>)[prop];
  },
});

/** Always the 3 CLI-executable physical agents */
export function getPhysicalAgentNames(): string[] {
  return [..._registry.entries()].filter(([, v]) => v.type === AGENT_TYPE.PHYSICAL).map(([k]) => k);
}

/** All registered agent names (physical + virtual) */
export function getAllAgentNames(): string[] {
  return [..._registry.keys()];
}

export const AGENT_DISPLAY_ORDER = ['gemini', 'codex', 'claude'];

/** Dynamic KNOWN_OWNERS — derives from registry + human + unassigned */
export const KNOWN_OWNERS: Set<string> = new Proxy(new Set<string>(), {
  get(target, prop) {
    const names = new Set([..._registry.keys(), 'human', 'unassigned']);
    if (prop === 'has') return names.has.bind(names);
    if (prop === 'size') return names.size;
    if (prop === Symbol.iterator) return names[Symbol.iterator].bind(names);
    if (prop === 'forEach') return names.forEach.bind(names);
    if (prop === 'values') return names.values.bind(names);
    if (prop === 'keys') return names.keys.bind(names);
    if (prop === 'entries') return names.entries.bind(names);
    return (target as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// ── Task Classification ──────────────────────────────────────────────────────

export const TASK_TYPES = [
  'planning',
  'architecture',
  'review',
  'refactor',
  'implementation',
  'analysis',
  'testing',
  'research',
  'documentation',
  'security',
];

// ── Affinity Learning ─────────────────────────────────────────────────────────

const AFFINITY_FILE = path.join(HYDRA_ROOT, 'docs', 'coordination', 'agent-affinities.json');

type AffinityEntry = { adjustment: number; sampleCount: number; successCount: number };

let _affinityOverrides: Record<string, AffinityEntry> | null = null; // lazy-loaded cache

function loadAffinityOverrides(): Record<string, AffinityEntry> {
  if (_affinityOverrides) return _affinityOverrides;
  try {
    const raw = fs.readFileSync(AFFINITY_FILE, 'utf8');
    const data = JSON.parse(raw) as { overrides?: Record<string, AffinityEntry> };
    _affinityOverrides = data.overrides ?? {};
  } catch {
    _affinityOverrides = {};
  }
  return _affinityOverrides;
}

function saveAffinityOverrides() {
  if (!_affinityOverrides) return;
  const dir = path.dirname(AFFINITY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = { version: 1, updatedAt: new Date().toISOString(), overrides: _affinityOverrides };
  fs.writeFileSync(AFFINITY_FILE, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Record task outcome for adaptive routing.
 * Tracks success/failure per agent+taskType and adjusts affinity scores.
 *
 * @param {string} agent - Agent name
 * @param {string} taskType - Task type (from TASK_TYPES)
 * @param {'success'|'partial'|'failed'|'rejected'} outcome
 */
export function recordTaskOutcome(
  agent: string,
  taskType: string,
  outcome: 'success' | 'partial' | 'failed' | 'rejected',
): void {
  const cfg = loadHydraConfig();
  const learning = cfg.agents.affinityLearning;
  if (!learning?.enabled) return;

  const overrides = loadAffinityOverrides();
  const key = `${agent}:${taskType}`;

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime JSON may lack key
  if (!overrides[key]) {
    overrides[key] = { adjustment: 0, sampleCount: 0, successCount: 0 };
  }

  const entry = overrides[key];
  entry.sampleCount += 1;
  if (outcome === 'success' || outcome === 'partial') {
    entry.successCount += 1;
  }

  const minSamples = learning.minSampleSize || 5;
  if (entry.sampleCount >= minSamples) {
    const successRate = entry.successCount / entry.sampleCount;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config value may be absent at runtime
    const decayFactor = learning.decayFactor ?? 0.9;
    // Center around 0.75 baseline — agents scoring above that get positive adjustment
    const raw = (successRate - 0.75) * 0.2 * decayFactor;
    entry.adjustment = Math.max(-0.2, Math.min(0.2, raw));
  }

  saveAffinityOverrides();
}

/** Invalidate affinity cache (for testing or config reload). */
export function invalidateAffinityCache(): void {
  _affinityOverrides = null;
}

interface BestAgentOpts {
  includeVirtual?: boolean;
  mode?: string;
  budgetState?: {
    daily?: { percentUsed?: number };
    weekly?: { percentUsed?: number; percent?: number };
    percent?: number;
  } | null;
  /** When provided, CLI agents (executeMode:'spawn') with a `false` entry are skipped. */
  installedCLIs?: Record<string, boolean | undefined> | null;
}

export function bestAgentFor(taskType: string, opts: BestAgentOpts = {}): string {
  const includeVirtual = opts.includeVirtual ?? false;
  const mode = opts.mode ?? 'balanced';
  const budgetState = opts.budgetState ?? null;
  const installedCLIs = opts.installedCLIs ?? null;
  const cfg = loadHydraConfig();
  const learningEnabled = cfg.agents.affinityLearning?.enabled;
  const overrides = learningEnabled ? loadAffinityOverrides() : {};

  // Budget gate: auto-boost local when cloud usage exceeds thresholds
  const localGate = cfg.local.budgetGate ?? { dailyPct: 80, weeklyPct: 75 };
  const dailyPct = budgetState?.daily?.percentUsed ?? budgetState?.percent;
  const weeklyPct = budgetState?.weekly?.percentUsed ?? budgetState?.weekly?.percent;
  const budgetTriggered =
    (dailyPct ?? 0) > localGate.dailyPct || (weeklyPct ?? 0) > localGate.weeklyPct;

  const localBoost = mode === 'economy' || budgetTriggered;
  const localPenalty = mode === 'performance';

  const candidates: Array<{ name: string; score: number }> = [];
  for (const [name, agent] of _registry) {
    if (!_resolveEnabled(agent)) continue;
    if (name === 'local' && !cfg.local.enabled) continue;
    if (!includeVirtual && agent.type === AGENT_TYPE.VIRTUAL) continue;
    // Skip CLI agents explicitly marked as not installed
    if (installedCLIs && agent.features.executeMode === 'spawn' && installedCLIs[name] === false) {
      continue;
    }
    let score = (agent.taskAffinity as Record<string, number>)[taskType] ?? 0;
    const key = `${name}:${taskType}`;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime key may not exist in overrides
    if (overrides[key]?.adjustment) {
      score += overrides[key].adjustment;
    }
    if (name === 'local') {
      if (localBoost) score *= 1.5;
      if (localPenalty) score *= 0.5;
    }
    candidates.push({ name, score });
  }
  if (candidates.length === 0) {
    if (installedCLIs) {
      for (const name of DISPATCH_PREFERENCE_ORDER) {
        const agentDef = _registry.get(name);
        if (!agentDef || !_resolveEnabled(agentDef)) continue;
        if (!includeVirtual && agentDef.type === AGENT_TYPE.VIRTUAL) continue;
        if (name === 'local' && !cfg.local.enabled) continue;
        if (installedCLIs[name] === false) continue;
        return name;
      }
      // Secondary: any installed CLI backed by a registered, enabled agent
      const registryBackedFallback = Object.entries(installedCLIs).find(([cliName, v]) => {
        if (!v) return false;
        const agentDef = _registry.get(cliName);
        if (!agentDef || !_resolveEnabled(agentDef)) return false;
        if (!includeVirtual && agentDef.type === AGENT_TYPE.VIRTUAL) return false;
        return true;
      });
      if (registryBackedFallback) return registryBackedFallback[0];
      throw new Error(
        'Hydra routing error: no enabled agents available. All installedCLIs entries are false' +
          ' and the local agent is disabled by configuration.',
      );
    }
    return 'claude';
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].name;
}

export function classifyTask(title: string, notes = ''): TaskType {
  const text = `${title} ${notes}`.toLowerCase();
  if (/security|vulnerab|owasp|cve|auth.?audit|pentest|sanitiz/.test(text)) return 'security';
  if (/research|explore|investigate|understand|discover|map|survey/.test(text)) return 'research';
  if (/document|readme|jsdoc|api.?doc|comment|explain/.test(text)) return 'documentation';
  if (/plan|design|architect|break.?down|decide|strategy/.test(text)) return 'planning';
  if (/review|audit|check|verify|validate|inspect/.test(text)) return 'review';
  if (/refactor|rename|extract|consolidate|reorganize/.test(text)) return 'refactor';
  if (/test|spec|coverage|assert/.test(text)) return 'testing';
  if (/analyze|find|search|identify|scan/.test(text)) return 'analysis';
  if (/architect|schema|migration|structure/.test(text)) return 'architecture';
  return 'implementation';
}

/**
 * Get the default verification partner for an agent.
 */
export function getVerifier(producerAgent: string): string {
  const cfg = loadHydraConfig();
  const pairings = cfg.crossModelVerification?.pairings as Record<string, string> | undefined;
  if (pairings?.[producerAgent]) {
    return pairings[producerAgent];
  }
  const defaults: Record<string, string> = { gemini: 'claude', codex: 'claude', claude: 'gemini' };
  return defaults[producerAgent] ?? 'claude';
}

// ── Registry Initialization ──────────────────────────────────────────────────

let _initialized = false;

/**
 * Initialize the agent registry. Called at startup.
 * Registers physical agents, then loads built-in sub-agents and custom agents from config.
 */
export function initAgentRegistry(): void {
  if (_initialized) return;

  // 1. Register the 3 physical agents
  for (const [name, def] of Object.entries(PHYSICAL_AGENTS)) {
    registerAgent(name, def);
  }

  // 2. Load built-in sub-agents (lazy import to avoid circular deps)
  try {
    // Dynamic import would be async; we use a sync registration pattern.
    // Built-in sub-agents are registered via registerBuiltInSubAgents() called separately.
  } catch {
    /* sub-agents module optional */
  }

  // 3. Load custom agents from config
  try {
    const cfg = loadHydraConfig();
    const agentsCfg = cfg.agents;

    // Disable built-ins that are not in the enabled list
    if (agentsCfg.subAgents && Array.isArray(agentsCfg.subAgents.builtIns)) {
      // This will be checked when sub-agents register themselves
    }

    // Register custom user-defined virtual agents
    if (agentsCfg.custom && typeof agentsCfg.custom === 'object') {
      for (const [name, def] of Object.entries(agentsCfg.custom)) {
        const d = def as Record<string, unknown>;
        if (d['baseAgent']) {
          try {
            registerAgent(name, {
              ...(d as Partial<AgentDef>),
              type: AGENT_TYPE.VIRTUAL as AgentDef['type'],
            });
          } catch {
            /* skip invalid custom agents */
          }
        }
      }
    }

    // Register custom physical agents (CLI and API types from agents.customAgents[])
    if (Array.isArray(agentsCfg.customAgents)) {
      for (const def of agentsCfg.customAgents) {
        if (!def.name || !['cli', 'api'].includes(def.type)) continue;
        try {
          registerAgent(def.name, {
            ...(def as unknown as Partial<AgentDef>),
            type: AGENT_TYPE.PHYSICAL as AgentDef['type'],
            customType: def.type,
            cli: def.type === 'cli' ? (def.invoke?.headless?.cmd ?? def.name) : null,
            invoke: def.invoke as unknown as AgentInvoke | undefined,
          });
        } catch {
          /* skip invalid custom agents silently */
        }
      }
    }
  } catch {
    /* config load failure is non-fatal */
  }

  _initialized = true;
}

/**
 * Check if the registry has been initialized.
 */
export function isRegistryInitialized(): boolean {
  return _initialized;
}

export function _resetRegistry(): void {
  _registry.clear();
  _initialized = false;
}

// ── Auto-initialize on import ────────────────────────────────────────────────
// Register physical agents immediately so existing code works without explicit init.
initAgentRegistry();

// ── Model Reasoning Capabilities ─────────────────────────────────────────────
// Maps model prefixes to their reasoning/thinking capabilities.
// Used to show model-accurate effort pickers and display labels.

// Derived from hydra-model-profiles.mjs — single source of truth for model capabilities.
export const MODEL_REASONING_CAPS = _getReasoningCapsMap();

/**
 * Longest-prefix match against MODEL_REASONING_CAPS.
 * @param {string} modelId - Model identifier
 * @returns {{ type: string, levels?: string[], budgets?: object, variants?: object, default?: string }}
 */
type ReasoningCapsEntry = ReturnType<typeof _getReasoningCapsMap>[string];

export function getModelReasoningCaps(modelId: string): ReasoningCapsEntry {
  if (!modelId) return { type: 'none' };
  let bestKey = '';
  for (const prefix of Object.keys(MODEL_REASONING_CAPS)) {
    if (modelId.startsWith(prefix) && prefix.length > bestKey.length) {
      bestKey = prefix;
    }
  }
  return bestKey ? MODEL_REASONING_CAPS[bestKey] : { type: 'none' };
}

export function getEffortOptionsForModel(
  modelId: string,
): Array<{ id: string | null; label: string; hint: string }> {
  const caps = getModelReasoningCaps(modelId);

  if (caps.type === 'effort') {
    return [
      { id: null, label: 'default', hint: `model default (${caps.default ?? ''})` },
      ...(caps.levels ?? []).map((l) => ({ id: l, label: l, hint: '' })),
    ];
  }

  if (caps.type === 'thinking') {
    return (caps.levels ?? []).map((l) => {
      const budget = caps.budgets?.[l];
      const hint = budget ? `${String(Math.round(budget / 1024))}K tokens` : '';
      return { id: l, label: l, hint };
    });
  }

  if (caps.type === 'model-swap') {
    const variants = caps.variants ?? {};
    return Object.keys(variants).map((k) => ({
      id: k,
      label: k,
      hint: typeof variants[k] === 'string' ? variants[k] : '',
    }));
  }

  return []; // type === 'none'
}

/**
 * Human-readable display string for a model's reasoning/thinking setting.
 * @param {string} modelId
 * @param {string|null} effortValue
 * @returns {string}
 */
export function formatEffortDisplay(
  modelId: string,
  effortValue: string | null | undefined,
): string {
  if (!effortValue) return '';
  const caps = getModelReasoningCaps(modelId);

  if (caps.type === 'effort') {
    return effortValue; // 'low' / 'medium' / 'high' — native OpenAI terms
  }

  if (caps.type === 'thinking') {
    if (effortValue === 'off') return '';
    return `think:${effortValue}`;
  }

  if (caps.type === 'model-swap') {
    if (effortValue === 'standard') return ''; // default — no badge
    return effortValue; // 'deep' → show 'deep'
  }

  return ''; // unsupported model — hide badge
}

// ── Reasoning Effort ─────────────────────────────────────────────────────────

export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export function getReasoningEffort(agentName: string): string | null {
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  return cfg.models[agentName]?.reasoningEffort ?? null;
}

export function setReasoningEffort(agentName: string, level: string | null): string | null {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  if (!cfg.models[agentName]) cfg.models[agentName] = {} as ModelConfig;
  cfg.models[agentName].reasoningEffort = level ?? undefined;
  saveHydraConfig(cfg);
  return level;
}

// ── Model Management ─────────────────────────────────────────────────────────

function normalizeLegacyModelId(
  agentName: string,
  modelId: string | null | undefined,
): string | null | undefined {
  if (!modelId) return modelId;
  const value = modelId;
  const lower = value.toLowerCase();
  if (
    agentName === 'codex' &&
    (lower === 'codex-5.2' || lower === 'codex-5.3' || lower === 'gpt-5.3')
  ) {
    return 'gpt-5.2-codex';
  }
  return modelId;
}

export function resolveModelId(
  agentName: string,
  shorthand: string | null | undefined,
): string | null {
  if (!shorthand) return null;
  const normalized = normalizeLegacyModelId(agentName, shorthand);
  const lower = String(normalized).toLowerCase();
  const cfg = loadHydraConfig();

  const aliases = cfg.aliases?.[agentName];
  if (aliases?.[lower]) return aliases[lower];

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  const agentModels = cfg.models?.[agentName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  if (agentModels && (agentModels as Record<string, unknown>)[lower]) {
    return (agentModels as Record<string, string>)[lower];
  }

  return normalized ?? null;
}

export function getMode(): string {
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config value may be absent at runtime
  return cfg.mode ?? 'performance';
}

export function setMode(modeName: string): string {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  const tiers = cfg.modeTiers ?? {};
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- validates runtime config key
  if (!tiers[modeName]) {
    throw new Error(`Unknown mode "${modeName}". Available: ${Object.keys(tiers).join(', ')}`);
  }
  cfg.mode = modeName as typeof cfg.mode;
  for (const agent of getPhysicalAgentNames()) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
    if (cfg.models[agent]) {
      cfg.models[agent].active = 'default';
    }
  }
  saveHydraConfig(cfg);
  return modeName;
}

export function resetAgentModel(agentName: string): string | null {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  if (cfg.models[agentName]) {
    cfg.models[agentName].active = 'default';
    saveHydraConfig(cfg);
  }
  return getActiveModel(agentName);
}

export function getActiveModel(agentName: string): string | null {
  const envKey = `HYDRA_${agentName.toUpperCase()}_MODEL`;
  const envVal = process.env[envKey];
  if (envVal) return resolveModelId(agentName, envVal) ?? envVal;

  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  const agentModels = cfg.models?.[agentName];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  if (!agentModels) return null;

  const activeKey = agentModels.active || 'default';
  const normalize = (modelId: string | null | undefined): string | null => {
    if (!modelId) return null;
    const legacyNormalized = normalizeLegacyModelId(agentName, modelId);
    return resolveModelId(agentName, legacyNormalized) ?? legacyNormalized ?? null;
  };

  // If reasoning effort is high and it's gemini, prefer the 'thinking' alias if it exists
  const effort = getReasoningEffort(agentName);
  if (
    agentName === 'gemini' &&
    activeKey === 'default' &&
    (effort === 'high' || effort === 'xhigh')
  ) {
    const thinkingModel = resolveModelId('gemini', 'thinking');
    if (thinkingModel && thinkingModel !== 'thinking') return thinkingModel;
  }

  if (activeKey !== 'default') {
    const selected = (agentModels as Record<string, string>)[activeKey] ?? activeKey;
    return normalize(selected) ?? normalize(agentModels.default);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config value may be absent at runtime
  const mode = cfg.mode ?? 'performance';
  const tierPreset = cfg.modeTiers?.[mode]?.[agentName];
  if (tierPreset && (agentModels as Record<string, string>)[tierPreset]) {
    return normalize((agentModels as Record<string, string>)[tierPreset]);
  }

  return normalize(agentModels.default);
}

export function setActiveModel(agentName: string, modelKeyOrId: string): string | null {
  invalidateConfigCache();
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  if (!cfg.models[agentName]) {
    cfg.models[agentName] = {} as ModelConfig;
  }

  const agentModels = cfg.models[agentName];
  if (
    ['default', 'fast', 'cheap'].includes(modelKeyOrId) &&
    (agentModels as Record<string, unknown>)[modelKeyOrId]
  ) {
    agentModels.active = modelKeyOrId;
  } else {
    const resolved = resolveModelId(agentName, modelKeyOrId) ?? modelKeyOrId;
    agentModels.active = resolved;
  }

  saveHydraConfig(cfg);
  return getActiveModel(agentName);
}

export function getModelFlags(agentName: string): string[] {
  const flags: string[] = [];
  const modelId = getActiveModel(agentName);
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent at runtime
  const defaultId = cfg.models?.[agentName]?.default;

  if (modelId && (modelId !== defaultId || agentName === 'codex')) {
    flags.push('--model', modelId);
  }

  const effort = getReasoningEffort(agentName);
  if (effort) {
    const caps = getModelReasoningCaps(modelId ?? '');

    if (caps.type === 'effort' && agentName === 'codex') {
      // OpenAI o-series: --reasoning-effort low/medium/high
      flags.push('--reasoning-effort', effort);
    }
    // Note: Claude thinking budget is API-only (handled in hydra-anthropic.mjs)
    // — the Claude CLI does not support --thinking-budget
    // model-swap: no flags — handled by getActiveModel()
  }

  return flags;
}

export function getModelSummary(): Record<string, unknown> {
  const cfg = loadHydraConfig();
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config value may be absent at runtime
  const mode = cfg.mode ?? 'performance';
  const summary: Record<string, unknown> = {};
  const physicalNames = getPhysicalAgentNames();
  const orderedAgents = [
    ...AGENT_DISPLAY_ORDER.filter((agent) => physicalNames.includes(agent)),
    ...physicalNames.filter((agent) => !AGENT_DISPLAY_ORDER.includes(agent)),
  ];
  for (const agent of orderedAgents) {
    const activeModel = getActiveModel(agent);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config entry may be absent for non-standard agents
    const agentModels = (cfg.models?.[agent] ?? {}) as ModelConfig & Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- config value may be absent at runtime
    const activeKey = agentModels.active ?? 'default';
    const isOverride = activeKey !== 'default';
    const tierPreset = cfg.modeTiers?.[mode]?.[agent] ?? 'default';

    summary[agent] = {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- agentModels may be empty object at runtime
      active: activeModel ?? agentModels.default ?? 'unknown',
      isDefault: !isOverride && activeModel === agentModels.default,
      isOverride,
      tierSource: isOverride ? 'override' : `${mode} → ${tierPreset}`,
      reasoningEffort: agentModels.reasoningEffort ?? null,
      presets: Object.fromEntries(
        Object.entries(agentModels)
          .filter(([k]) => !['active', 'reasoningEffort'].includes(k))
          .map(([k, v]) => [k, resolveModelId(agent, String(v)) ?? v]),
      ),
    };
  }
  summary['_mode'] = mode;
  return summary;
}
