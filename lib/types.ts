/**
 * Hydra — canonical shared type definitions.
 *
 * Derived from actual runtime shapes in:
 *   lib/hydra-agents.mjs, lib/hydra-config.mjs, lib/hydra-model-profiles.mjs,
 *   lib/orchestrator-daemon.mjs, lib/hydra-shared/agent-executor.mjs
 *
 * No logic — types only.
 */

// ── Agent system ──────────────────────────────────────────────────────────────

/** Runtime agent name: 'claude' | 'gemini' | 'codex' | 'local' | custom */
export type AgentName = string;

/** Physical = CLI-backed execution backend; virtual = specialized role inheriting from physical */
export type AgentType = 'physical' | 'virtual';

/** How the agent is invoked: spawn = CLI subprocess, api = OpenAI-compat HTTP */
export type ExecuteMode = 'spawn' | 'api';

export type PermissionMode = 'plan' | 'auto-edit' | 'full-auto';

export interface AgentFeatures {
  executeMode: ExecuteMode;
  jsonOutput: boolean;
  stdinPrompt: boolean;
  reasoningEffort: boolean;
  streaming?: boolean;
}

/**
 * Options passed into invoke.headless() / invoke.nonInteractive().
 * Also used by executeAgent() opts — a superset lives there but these
 * are the fields the invoke builders actually consume.
 */
export interface HeadlessOpts {
  model?: string;
  maxTokens?: number;
  systemPrompt?: string;
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: PermissionMode;
  /** Whether to pipe prompt via stdin (from agent features.stdinPrompt) */
  stdinPrompt?: boolean;
  /** Write output to file path instead of stdout (Codex nonInteractive) */
  outputPath?: string;
  /** Request JSON-formatted output from the agent CLI */
  jsonOutput?: boolean;
}

/** All three methods exist on the invoke object; any may be null for agents that don't support it */
export interface AgentInvoke {
  nonInteractive: ((prompt: string, opts?: HeadlessOpts) => [string, string[]]) | null;
  interactive: ((prompt: string) => [string, string[]]) | null;
  headless: ((prompt: string, opts?: HeadlessOpts) => [string, string[]]) | null;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Claude: tokens written to the prompt cache */
  cacheCreationTokens?: number;
  /** Claude: tokens read from the prompt cache */
  cacheReadTokens?: number;
  /** Copilot: premium API calls consumed */
  premiumRequests?: number;
}

export interface AgentResult {
  output: string;
  tokenUsage: TokenUsage | null;
  costUsd: number | null;
  exitCode?: number;
  error?: string;
}

/** Named error-pattern keys matching actual agent plugin definitions */
export type ErrorPatternKey =
  | 'authRequired'
  | 'rateLimited'
  | 'quotaExhausted'
  | 'networkError'
  | 'subscriptionRequired';

export type ErrorPatterns = Partial<Record<ErrorPatternKey, RegExp>>;

/**
 * Return value of quotaVerify().
 * `verified`: true = quota exhausted, false = quota OK, 'unknown' = could not determine.
 * `status`: HTTP status code when available.
 */
export interface QuotaStatus {
  verified: boolean | 'unknown';
  status?: number;
  reason?: string;
}

export interface ParseOutputOpts {
  model?: string;
  agent?: AgentName;
  jsonOutput?: boolean;
}

export interface AgentDef {
  name: AgentName;
  label: string;
  type: AgentType;
  /** Binary name for detectInstalledCLIs; null for local/virtual agents */
  cli?: string | null;
  enabled: boolean;
  features: AgentFeatures;
  /** null for virtual agents; physical agents always have an invoke object */
  invoke: AgentInvoke | null;
  parseOutput: (stdout: string, opts?: ParseOutputOpts) => AgentResult;
  taskAffinity: Partial<Record<TaskType, number>>;
  errorPatterns: ErrorPatterns;
  modelBelongsTo: (modelId: string) => boolean;
  /** Takes optional API key + hint args; returns null when verification is not applicable */
  quotaVerify: (...args: unknown[]) => Promise<QuotaStatus | null>;
  /** Returns the economy/fallback model ID, or null if the agent has no economy tier */
  economyModel: (...args: unknown[]) => string | null;
  /** Returns file-reading instructions; takes a file path argument */
  readInstructions: ((f: string) => string) | null;
  taskRules: string[];
  /** Optional label injected into dispatch prompt builders */
  rolePrompt?: string;
  // Extended fields present on registered entries (set by registerAgent)
  displayName?: string;
  customType?: string | null;
  baseAgent?: string | null;
  contextBudget?: number | null;
  contextTier?: string | null;
  strengths?: string[];
  weaknesses?: string[];
  councilRole?: string | null;
  timeout?: number | null;
  tags?: string[];
}

// ── Task system ───────────────────────────────────────────────────────────────

/** Task types from TASK_TYPES constant in hydra-agents.mjs */
export type TaskType =
  | 'planning'
  | 'architecture'
  | 'review'
  | 'refactor'
  | 'implementation'
  | 'analysis'
  | 'testing'
  | 'research'
  | 'documentation'
  | 'security';

/** Task lifecycle status values from STATUS_VALUES in orchestrator-daemon.mjs */
export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';

/** Shape of a task record as stored in daemon state.tasks[] */
export interface TaskState {
  id: string;
  title: string;
  owner: string;
  status: TaskStatus;
  type: string;
  files: string[];
  notes: string;
  blockedBy: string[];
  updatedAt: string;
  /** Set when worktree isolation is enabled */
  worktreePath?: string;
  worktreeBranch?: string;
}

/** Result of prompt classification / routing logic */
export interface RoutingDecision {
  agent: AgentName;
  taskType: TaskType;
  confidence: number;
  reason?: string;
  mode?: RoutingMode;
}

// ── Config types ──────────────────────────────────────────────────────────────

/**
 * Top-level Hydra mode — controls which model tier tier is active.
 * Maps to keys in config.modeTiers (from getModeTiers()).
 */
export type HydraMode = 'performance' | 'balanced' | 'economy' | 'custom';

/** Routing mode: shifts agent affinity toward local/cheap vs flagship models */
export type RoutingMode = 'economy' | 'balanced' | 'performance';

/** Per-agent model tier configuration stored in config.models[agent] */
export interface ModelConfig {
  default: string;
  fast: string;
  cheap: string;
  active: string;
}

/** Role-specific agent+model assignment from config.roles[roleName] */
export interface RoleConfig {
  agent: AgentName;
  model: string | null;
  reasoningEffort: string | null;
}

export interface IntentGateConfig {
  enabled: boolean;
  confidenceThreshold: number;
}

export interface WorktreeIsolationConfig {
  enabled: boolean;
  cleanupOnSuccess?: boolean;
  worktreeDir?: string;
}

export interface RoutingConfig {
  mode: RoutingMode;
  useLegacyTriage?: boolean;
  councilGate?: boolean;
  tandemEnabled?: boolean;
  councilMode?: string;
  councilTimeoutMs?: number;
  intentGate: IntentGateConfig;
  worktreeIsolation: WorktreeIsolationConfig;
}

/** Entry from config.agents.customAgents[] — built by buildCustomAgentEntry() */
export interface CustomAgentDef {
  name: AgentName;
  /** 'cli' = spawns a local binary, 'api' = OpenAI-compat HTTP endpoint */
  type: 'cli' | 'api';
  displayName?: string;
  contextBudget?: number;
  councilRole?: string | null;
  taskAffinity?: Partial<Record<TaskType, number>>;
  enabled?: boolean;
  // CLI-type fields
  invoke?: {
    nonInteractive?: { cmd: string; args: string[] };
    headless?: { cmd: string; args: string[] };
  };
  responseParser?: string;
  // API-type fields
  baseUrl?: string;
  model?: string;
}

export interface AgentsConfig {
  subAgents?: {
    enabled: boolean;
    builtIns: string[];
  };
  custom?: Record<string, unknown>;
  customAgents: CustomAgentDef[];
  affinityLearning?: {
    enabled: boolean;
    decayFactor: number;
    minSampleSize: number;
  };
}

export interface UsageConfig {
  warningThresholdPercent?: number;
  criticalThresholdPercent?: number;
  claudeStatsPath?: string;
  dailyTokenBudget?: Record<string, number>;
  weeklyTokenBudget?: Record<string, number>;
  plan?: string;
  windowHours?: number;
  windowTokenBudget?: Record<string, number>;
  sessionBudget?: number;
  perTaskBudget?: number;
  perAgentBudget?: Record<AgentName, number>;
}

export interface ContextConfig {
  hierarchical: {
    enabled: boolean;
    maxFiles?: number;
  };
}

export interface LocalConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  fastModel?: string;
  budgetGate?: {
    dailyPct: number;
    weeklyPct: number;
  };
}

/** Top-level Hydra config object (hydra.config.json after mergeWithDefaults) */
export interface HydraConfig {
  version?: number;
  mode: HydraMode;
  models: Record<AgentName, ModelConfig>;
  aliases?: Record<AgentName, Record<string, string>>;
  modeTiers?: Record<string, Record<AgentName, string>>;
  usage: UsageConfig;
  roles: Record<string, RoleConfig>;
  recommendations?: Record<string, unknown>;
  agents: AgentsConfig;
  routing: RoutingConfig;
  local: LocalConfig;
  context: ContextConfig;
  // Remaining top-level sections typed loosely — narrow as needed
  verification?: Record<string, unknown>;
  concierge?: Record<string, unknown>;
  selfAwareness?: Record<string, unknown>;
  evolve?: Record<string, unknown>;
  tasks?: Record<string, unknown>;
  nightly?: Record<string, unknown>;
  workers?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  doctor?: Record<string, unknown>;
  modelRecovery?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  daemon?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  github?: Record<string, unknown>;
  forge?: Record<string, unknown>;
  audit?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  confirm?: Record<string, unknown>;
  eval?: Record<string, unknown>;
  persona?: Record<string, unknown>;
  telemetry?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  activity?: Record<string, unknown>;
}

// ── Model profiles ────────────────────────────────────────────────────────────

/** Model tier as stored in MODEL_PROFILES[id].tier */
export type ModelTier = 'flagship' | 'mid' | 'economy';

/** Shape of an entry in MODEL_PROFILES from hydra-model-profiles.mjs */
export interface ModelProfile {
  id: string;
  provider: string;
  agent: AgentName;
  displayName: string;
  shortName?: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutput?: number;
  pricePer1M?: { input: number; output: number };
  costPer1K?: { input: number; output: number };
  tokPerSec?: number;
  ttft?: number;
  reasoning?: {
    type: string;
    levels: string[];
    budgets?: Record<string, number>;
    default: string;
  };
  benchmarks?: Record<string, number>;
  qualityScore: number;
  valueScore?: number;
  speedScore?: number;
  strengths?: string[];
  bestFor?: string[];
  rateLimits?: Record<string | number, { rpm: number; itpm: number; otpm: number }>;
  /** CLI-specific model ID override (e.g. for Copilot agent where CLI name differs from API ID) */
  cliModelId?: string;
}

// ── Copilot integration (planned) ─────────────────────────────────────────────

export type CopilotEventType =
  | 'assistant.message'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'thinking';

export interface CopilotEventData {
  content?: string;
  toolRequests?: unknown[];
  [key: string]: unknown;
}

export interface CopilotJsonlEvent {
  type: CopilotEventType;
  data: CopilotEventData;
}
