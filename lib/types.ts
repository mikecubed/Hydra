import type { IncomingMessage, ServerResponse, Server } from 'node:http';

/**
 * Hydra — canonical shared type definitions.
 *
 * Derived from actual runtime shapes in:
 *   lib/hydra-agents.ts, lib/hydra-config.ts, lib/hydra-model-profiles.mjs,
 *   lib/orchestrator-daemon.mjs, lib/hydra-shared/agent-executor.ts
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
  /** Reasoning effort level for models that support it */
  reasoningEffort?: string | null;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quotaVerify: (...args: any[]) => Promise<QuotaStatus | null>;
  /** Returns the economy/fallback model ID, or null if the agent has no economy tier */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  economyModel: (...args: any[]) => string | null;
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

/** Task types from TASK_TYPES constant in hydra-agents.ts */
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
  /** Optional reasoning effort tier (e.g. 'high', 'medium', 'low') */
  reasoningEffort?: string;
  [key: string]: unknown;
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

// ── Named config section interfaces (replace Record<string, unknown> in HydraConfig) ──

export interface VerificationConfig {
  onTaskDone?: boolean;
  command?: string;
  timeoutMs?: number;
  secretsScan?: boolean;
  maxDiffLines?: number;
  [key: string]: unknown;
}

export interface ConciergeConfig {
  enabled?: boolean;
  model?: string;
  reasoningEffort?: string;
  maxHistoryMessages?: number;
  autoActivate?: boolean;
  showProviderInPrompt?: boolean;
  welcomeMessage?: boolean;
  summarizeOnTrim?: boolean;
  fallbackChain?: unknown[];
  [key: string]: unknown;
}

export interface SelfAwarenessConfig {
  enabled?: boolean;
  injectIntoConcierge?: boolean;
  includeSnapshot?: boolean;
  includeIndex?: boolean;
  snapshotMaxLines?: number;
  indexMaxChars?: number;
  indexRefreshMs?: number;
  [key: string]: unknown;
}

export interface EvolveConfig {
  enabled?: boolean;
  maxRounds?: number;
  maxHours?: number;
  baseBranch?: string;
  focusAreas?: string[];
  budget?: {
    softLimit?: number;
    hardLimit?: number;
    perRoundEstimate?: number;
    warnThreshold?: number;
    reduceScopeThreshold?: number;
    softStopThreshold?: number;
    hardStopThreshold?: number;
    [key: string]: unknown;
  };
  phases?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  suggestions?: {
    enabled?: boolean;
    autoPopulateFromRejected?: boolean;
    autoPopulateFromDeferred?: boolean;
    maxPendingSuggestions?: number;
    maxAttemptsPerSuggestion?: number;
    [key: string]: unknown;
  };
  investigator?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TasksConfig {
  baseBranch?: string;
  maxTasks?: number;
  maxHours?: number;
  perTaskTimeoutMs?: number;
  sources?: Record<string, boolean>;
  budget?: {
    defaultPreset?: string;
    perTaskEstimate?: number;
    softLimit?: number;
    hardLimit?: number;
    [key: string]: unknown;
  };
  councilLite?: Record<string, unknown>;
  investigator?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface NightlyConfig {
  enabled?: boolean;
  baseBranch?: string;
  branchPrefix?: string;
  maxTasks?: number;
  maxHours?: number;
  perTaskTimeoutMs?: number;
  sources?: Record<string, unknown>;
  aiDiscovery?: {
    agent?: string;
    maxSuggestions?: number;
    focus?: string[];
    timeoutMs?: number;
    [key: string]: unknown;
  };
  budget?: {
    softLimit?: number;
    hardLimit?: number;
    perTaskEstimate?: number;
    handoffThreshold?: number;
    handoffAgent?: string;
    handoffModel?: string;
    [key: string]: unknown;
  };
  tasks?: unknown[];
  investigator?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkersConfig {
  permissionMode?: string;
  autoStart?: boolean;
  pollIntervalMs?: number;
  maxOutputBufferKB?: number;
  autoChain?: boolean;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  retry?: Record<string, unknown>;
  deadLetter?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ProvidersConfig {
  openai?: Record<string, unknown>;
  anthropic?: Record<string, unknown>;
  google?: Record<string, unknown>;
  rateLimit?: Record<string, unknown>;
  presets?: Array<Record<string, string>>;
  [key: string]: unknown;
}

export interface DoctorConfig {
  enabled?: boolean;
  autoCreateTasks?: boolean;
  autoCreateSuggestions?: boolean;
  addToKnowledgeBase?: boolean;
  recurringThreshold?: number;
  recurringWindowDays?: number;
  [key: string]: unknown;
}

export interface GithubConfig {
  enabled?: boolean;
  defaultBase?: string;
  draft?: boolean;
  labels?: string[];
  reviewers?: string[];
  prBodyFooter?: string;
  requiredChecks?: string[];
  autolabel?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ForgeConfig {
  enabled?: boolean;
  autoTest?: boolean;
  phaseTimeoutMs?: number;
  storageDir?: string;
  [key: string]: unknown;
}

export interface AuditConfig {
  maxFiles?: number;
  categories?: string[];
  reportDir?: string;
  timeout?: number;
  economy?: boolean;
  [key: string]: unknown;
}

export interface DispatchConfig {
  dryRun?: boolean;
  [key: string]: unknown;
}

export interface EvalConfig {
  corpusPaths?: string[];
  [key: string]: unknown;
}

export interface PersonaConfig {
  enabled?: boolean;
  name?: string;
  tone?: string;
  verbosity?: string;
  formality?: string;
  humor?: boolean;
  voice?: string;
  identity?: string;
  presets?: Record<string, unknown>;
  agentFraming?: Record<string, string>;
  processLabels?: Record<string, string>;
  [key: string]: unknown;
}

export interface TelemetryConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface StatsConfig {
  retentionDays?: number;
  [key: string]: unknown;
}

export interface ActivityConfig {
  summarizeOnShutdown?: boolean;
  [key: string]: unknown;
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
  verification?: VerificationConfig;
  concierge?: ConciergeConfig;
  selfAwareness?: SelfAwarenessConfig;
  evolve?: EvolveConfig;
  tasks?: TasksConfig;
  nightly?: NightlyConfig;
  workers?: WorkersConfig;
  providers?: ProvidersConfig;
  doctor?: DoctorConfig;
  modelRecovery?: Record<string, unknown>;
  rateLimits?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  daemon?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  github?: GithubConfig;
  forge?: ForgeConfig;
  audit?: AuditConfig;
  dispatch?: DispatchConfig;
  confirm?: Record<string, unknown>;
  eval?: EvalConfig;
  persona?: PersonaConfig;
  telemetry?: TelemetryConfig;
  stats?: StatsConfig;
  activity?: ActivityConfig;
  // Additional runtime properties that may appear on the config object
  crossModelVerification?: {
    enabled?: boolean;
    pairings?: Record<string, unknown>;
    [key: string]: unknown;
  };
  worktrees?: Record<string, unknown>;
  [key: string]: unknown;
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
  tokPerSec?: number | null;
  ttft?: number | null;
  reasoning?: {
    type: string;
    levels?: string[];
    budgets?: Record<string, number>;
    variants?: Record<string, string>;
    default?: string;
  };
  benchmarks?: Record<string, number>;
  qualityScore: number;
  valueScore?: number;
  speedScore?: number;
  strengths?: string[];
  bestFor?: string[];
  rateLimits?: Record<
    string | number,
    { rpm: number; tpm?: number; itpm?: number; otpm?: number; rpd?: number }
  >;
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

// ── Daemon state types ───────────────────────────────────────────────────────

/** Checkpoint record stored in TaskState.checkpoints[] */
export interface CheckpointEntry {
  note: string;
  at: string;
  [key: string]: unknown;
}

/** Extended task with runtime fields */
export interface TaskEntry extends TaskState {
  checkpoints?: CheckpointEntry[];
  stale?: boolean;
  staleSince?: string;
  [key: string]: unknown;
}

/** Handoff record in daemon state.handoffs[] */
export interface HandoffEntry {
  id: string;
  from: string;
  to: string;
  summary: string;
  nextStep?: string;
  tasks?: string[];
  acknowledgedAt?: string | null;
  acknowledgedBy?: string;
  createdAt: string;
  [key: string]: unknown;
}

/** Blocker record in daemon state.blockers[] */
export interface BlockerEntry {
  id: string;
  title: string;
  owner: string;
  status: string;
  nextStep?: string;
  createdAt: string;
  resolvedAt?: string;
  [key: string]: unknown;
}

/** Decision record in daemon state.decisions[] */
export interface DecisionEntry {
  id: string;
  title: string;
  owner: string;
  rationale?: string;
  impact?: string;
  createdAt: string;
  [key: string]: unknown;
}

/** Active session in daemon state.activeSession */
export interface ActiveSessionEntry {
  id: string;
  focus: string;
  owner: string;
  branch?: string;
  participants?: string[];
  status: string;
  type?: string;
  children?: string[];
  startedAt: string;
  updatedAt: string;
  pauseReason?: string;
  pausedAt?: string;
  [key: string]: unknown;
}

/** Child/fork session record */
export interface ChildSessionEntry {
  id: string;
  type: string;
  parentId: string;
  focus: string;
  owner: string;
  status: string;
  children?: string[];
  [key: string]: unknown;
}

/** Full daemon state shape */
export interface HydraStateShape {
  schemaVersion?: number;
  project?: string;
  updatedAt?: string;
  activeSession?: ActiveSessionEntry | null;
  childSessions?: ChildSessionEntry[];
  tasks: TaskEntry[];
  handoffs: HandoffEntry[];
  blockers: BlockerEntry[];
  decisions: DecisionEntry[];
  agents?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Archive state shape */
export interface ArchiveState {
  tasks: TaskEntry[];
  handoffs: HandoffEntry[];
  blockers: BlockerEntry[];
  archivedAt?: string;
  [key: string]: unknown;
}

/** Model summary info entry */
export interface ModelSummaryEntry {
  active: string;
  isDefault?: boolean;
  isOverride?: boolean;
  tierSource?: string;
  reasoningEffort?: string;
  [key: string]: unknown;
}

/** Usage check result */
export interface UsageCheckResult {
  level: string;
  percent?: number;
  todayTokens?: number;
  message?: string;
  confidence?: number;
  model?: string;
  budget?: number;
  used?: number;
  remaining?: number;
  resetAt?: string;
  resetInMs?: number;
  agents?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Context object passed to handleReadRoute */
export interface ReadRouteCtx {
  method: string;
  route: string;
  requestUrl: URL;
  req: IncomingMessage;
  res: ServerResponse;
  sendJson: (res: ServerResponse, status: number, data: unknown) => void;
  sendError: (res: ServerResponse, status: number, message: string, details?: unknown) => void;
  writeStatus: () => void;
  readStatus: () => Record<string, unknown>;
  checkUsage: () => UsageCheckResult;
  getModelSummary: () => Record<string, ModelSummaryEntry>;
  readState: () => HydraStateShape;
  getSummary: (state: HydraStateShape) => Record<string, unknown> | null;
  projectRoot?: string;
  projectName?: string;
  buildPrompt: (agent: string, state: HydraStateShape) => string;
  suggestNext: (
    state: HydraStateShape,
    agent: string,
  ) => {
    action: string;
    message?: string;
    task?: Record<string, unknown>;
    handoff?: Record<string, unknown>;
  };
  readEvents: (
    limit: number,
  ) => Array<{ seq: number; at: string; type: string; category?: string; payload?: unknown }>;
  replayEvents: (
    fromSeq: number,
  ) => Array<{ seq: number; at: string; type: string; category?: string; payload?: unknown }>;
  sseClients: Set<ServerResponse>;
  readArchive: () => ArchiveState;
  getMetricsSummary: () => Record<string, unknown>;
  getEventCount: () => number;
}

/** Context object passed to handleWriteRoute */
export interface WriteRouteCtx extends ReadRouteCtx {
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  enqueueMutation: <T>(
    label: string,
    mutator: (state: HydraStateShape) => T,
    detail?: Record<string, unknown>,
  ) => Promise<T>;
  ensureKnownAgent: (agent: string, strict?: boolean) => void;
  ensureKnownStatus: (status: string) => void;
  parseList: (val: unknown) => string[];
  getCurrentBranch: () => string;
  toSessionId: () => string;
  nowIso: () => string;
  classifyTask: (title: string, type?: string) => string;
  nextId: (prefix: string, items: unknown[]) => string;
  detectCycle: (tasks: TaskEntry[], targetId: string, proposedBlockedBy: string[]) => boolean;
  autoUnblock: (state: HydraStateShape, completedTaskId?: string) => void;
  AGENT_NAMES: string[];
  getAgent: (name: string) => AgentDef | undefined;
  listAgents: (...args: unknown[]) => AgentDef[];
  resolveVerificationPlan: (...args: unknown[]) => Record<string, unknown>;
  runVerification: (...args: unknown[]) => void;
  archiveState: (state: HydraStateShape) => number;
  truncateEventsFile: (maxLines?: number) => number;
  appendEvent: (type: string, payload?: unknown) => void;
  broadcastEvent: (event: unknown) => void;
  setIsShuttingDown: (value: boolean) => void;
  server: Server;
  createSnapshot: () => Record<string, unknown>;
  cleanOldSnapshots: () => void;
  checkIdempotency: ((key: string) => boolean) | null;
  createTaskWorktree: (taskId: string) => string | null;
  mergeTaskWorktree: (taskId: string) => Record<string, unknown>;
  cleanupTaskWorktree: (taskId: string) => void;
  writeStatus: (extra?: Record<string, unknown>) => void;
}

// ── Dispatch types ────────────────────────────────────────────────────────────

export interface DispatchOpts {
  agent?: string;
  mode?: 'auto' | 'smart' | 'council' | 'dispatch' | 'chat';
  prompt: string;
  timeout?: number;
  onChunk?: (chunk: string) => void;
}

export interface DispatchResult {
  output: string;
  agent: string;
  tokenUsage?: TokenUsage;
  costUsd?: number;
}

// ── Council types ─────────────────────────────────────────────────────────────

export interface CouncilProposal {
  agent: string;
  content: string;
  confidence?: number;
}

export interface CouncilRound {
  round: number;
  proposals: CouncilProposal[];
  synthesis?: string;
}

// ── Verification types ────────────────────────────────────────────────────────

export interface VerificationPlan {
  enabled: boolean;
  timeoutMs: number;
  command: string;
  source: 'config' | 'auto';
  reason: string;
}

// ── Hub types ─────────────────────────────────────────────────────────────────

export interface HubSession {
  id: string;
  agent: string;
  cwd: string;
  project: string;
  focus: string;
  files: string[];
  taskId?: string;
  status: string;
  registeredAt: string;
  updatedAt: string;
}

export interface ConflictResult {
  file: string;
  sessionId: string;
  agent: string;
  focus: string;
}

// ── Worker types ──────────────────────────────────────────────────────────────

export interface WorkerState {
  running: number;
  queued: number;
  max: number;
}

// ── MCP types ─────────────────────────────────────────────────────────────────

export interface MCPCallResult {
  ok: boolean;
  result: string;
  threadId?: string;
  viaMCP: boolean;
  error?: string;
}

// ── Concierge types ───────────────────────────────────────────────────────────

export interface ConciergeStats {
  turns: number;
  promptTokens: number;
  completionTokens: number;
}

export interface ActiveProvider {
  provider: string;
  model: string;
  isFallback: boolean;
}
