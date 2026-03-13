# Hydra — Dependency, Data-Flow & Component Diagrams

> Generated: 2026-03-13 | Branch: `copilot/audit-source-code-compliance`
> All diagrams use [Mermaid](https://mermaid.js.org/) syntax. Validate with `npm run lint:mermaid`.

---

## Table of Contents

1. [High-Level System Context](#1-high-level-system-context)
2. [Component Architecture](#2-component-architecture)
3. [Module Dependency Graph — Core Layer](#3-module-dependency-graph--core-layer)
4. [Module Dependency Graph — Full lib/](#4-module-dependency-graph--full-lib)
5. [Data-Flow: Prompt Dispatch](#5-data-flow-prompt-dispatch)
6. [Data-Flow: Council Deliberation](#6-data-flow-council-deliberation)
7. [Data-Flow: Autonomous Evolution](#7-data-flow-autonomous-evolution)
8. [Data-Flow: Nightly Batch Run](#8-data-flow-nightly-batch-run)
9. [Sequence: Task Claim → Execute → Result](#9-sequence-task-claim--execute--result)
10. [Sequence: Operator Console Interaction](#10-sequence-operator-console-interaction)
11. [State Machine: Daemon Task Lifecycle](#11-state-machine-daemon-task-lifecycle)
12. [Domain Cluster Map](#12-domain-cluster-map)
13. [Dependency Fan-In / Fan-Out Heat Map](#13-dependency-fan-in--fan-out-heat-map)
14. [Cyclic Dependency Graph](#14-cyclic-dependency-graph)

---

## 1. High-Level System Context

```mermaid
C4Context
  title System Context — Hydra Multi-Agent Orchestrator

  Person(operator, "Developer / Operator", "Uses the interactive REPL or CLI to dispatch tasks")
  System(hydra, "Hydra", "Multi-agent AI orchestration platform — routes tasks to Claude, Gemini, Codex, or Local agents; runs autonomous evolution and nightly batch processing")

  System_Ext(claude_api, "Anthropic API", "Claude models")
  System_Ext(openai_api, "OpenAI API", "GPT / Codex models")
  System_Ext(google_api, "Google AI API", "Gemini models")
  System_Ext(gh, "GitHub", "Issues, PRs, branch operations")
  System_Ext(mcp, "MCP Client", "IDE / tooling that calls Hydra's MCP server")
  System_Ext(otel, "OpenTelemetry Collector", "Optional traces / metrics sink")

  Rel(operator, hydra, "Sends prompts, reviews results", "stdin / HTTP / MCP")
  Rel(hydra, claude_api, "Claude CLI or API calls")
  Rel(hydra, openai_api, "OpenAI Responses API")
  Rel(hydra, google_api, "Gemini CLI or API calls")
  Rel(hydra, gh, "Read issues, post PRs, branch management", "REST / gh CLI")
  Rel(mcp, hydra, "Tool invocations", "MCP JSON-RPC")
  Rel(hydra, otel, "Spans & metrics", "OTLP")
```

---

## 2. Component Architecture

```mermaid
block-beta
  columns 3

  block:presentation["Presentation Layer"]:3
    operator["hydra-operator.ts\n(6,630 LOC — Operator Console)"]
    council["hydra-council.ts\n(2,321 LOC — Multi-round Deliberation)"]
    ui["hydra-ui.ts\n(1,561 LOC — Terminal UI)"]
  end

  block:domain["Domain / Orchestration Layer"]:3
    dispatch["hydra-dispatch.ts\n(Routing & Dispatch)"]
    tasks["hydra-tasks.ts\n(Task Queue Management)"]
    evolve["hydra-evolve.ts\n(3,657 LOC — Auto-evolution)"]
  end

  block:config["Configuration & Registry"]:3
    config["hydra-config.ts\n(1,067 LOC — Central Config Hub\n⚠ 23 fan-in dependents)"]
    agents["hydra-agents.ts\n(Agent Plugin Registry)"]
    types["types.ts\n(Shared Type Definitions)"]
  end

  block:infra["Infrastructure Layer"]:3
    executor["hydra-shared/agent-executor.ts\n(Core Execution Engine)"]
    worker["hydra-worker.ts\n(Background Workers)"]
    daemon["orchestrator-daemon.ts\n(HTTP API, port 4173)"]
  end

  block:providers["AI Provider Adapters"]:3
    anthropic["hydra-anthropic.ts"]
    openai["hydra-openai.ts"]
    google["hydra-google.ts"]
  end

  block:observability["Observability"]:3
    metrics["hydra-metrics.ts"]
    activity["hydra-activity.ts"]
    audit["hydra-audit.ts"]
  end

  presentation --> domain
  domain --> config
  domain --> infra
  infra --> providers
  infra --> observability
```

---

## 3. Module Dependency Graph — Core Layer

> Shows the most critical module relationships (high-coupling core only). Dashed arrows indicate indirect/optional dependencies.

```mermaid
graph TD
  subgraph Config["⚙ Configuration Core"]
    types["types.ts"]
    profiles["hydra-model-profiles.ts"]
    config["hydra-config.ts\n⚠ 23 fan-in"]
    constants["hydra-shared/constants.ts"]
    routing_const["hydra-routing-constants.ts"]
  end

  subgraph AgentReg["🤖 Agent Registry"]
    agents["hydra-agents.ts"]
    codex_helpers["hydra-shared/codex-helpers.ts"]
  end

  subgraph Execution["⚡ Execution Core"]
    executor["hydra-shared/agent-executor.ts\n⚠ 1,824 LOC, 5 dependents"]
    worker["hydra-worker.ts"]
    local["hydra-local.ts"]
    model_recovery["hydra-model-recovery.ts"]
  end

  subgraph Routing["🔀 Routing & Dispatch"]
    dispatch["hydra-dispatch.ts"]
    intent["hydra-intent-gate.ts"]
    persona["hydra-persona.ts"]
    context["hydra-context.ts"]
  end

  subgraph Observability["📊 Observability"]
    metrics["hydra-metrics.ts\n⚠ self-import"]
    usage["hydra-usage.ts"]
    activity["hydra-activity.ts"]
    statusbar["hydra-statusbar.ts"]
  end

  types --> config
  profiles --> config
  config --> agents
  routing_const --> agents
  codex_helpers --> agents
  agents --> executor
  config --> executor
  local --> executor
  metrics --> executor
  executor --> worker
  config --> worker
  model_recovery --> worker
  agents --> dispatch
  config --> dispatch
  intent --> dispatch
  persona --> dispatch
  context --> dispatch
  executor --> dispatch
  usage --> dispatch
  config --> usage
  agents --> usage
  metrics --> usage
  config --> intent
  config --> persona
  agents --> context
  config --> context
  agents --> model_recovery
  config --> model_recovery
  profiles --> model_recovery
  config --> metrics
  metrics --> activity
  config --> activity
  metrics --> statusbar
  config --> statusbar
  usage --> statusbar
```

---

## 4. Module Dependency Graph — Full lib/

> Full picture of all `lib/` module relationships. Clusters represent logical domains.

```mermaid
graph LR
  subgraph Foundation["🧱 Foundation"]
    T[types.ts]
    CFG[hydra-config.ts]
    P[hydra-model-profiles.ts]
    C[hydra-shared/constants.ts]
    RC[hydra-routing-constants.ts]
    ENV[hydra-env.ts]
    VER[hydra-version.ts]
  end

  subgraph Agents["🤖 Agents"]
    AG[hydra-agents.ts]
    AW[hydra-agents-wizard.ts]
    AF[hydra-agent-forge.ts]
    SA[hydra-sub-agents.ts]
    CH[hydra-shared/codex-helpers.ts]
  end

  subgraph Execution["⚡ Execution"]
    EX[agent-executor.ts]
    WK[hydra-worker.ts]
    LO[hydra-local.ts]
    MR[hydra-model-recovery.ts]
    GD[hydra-guardrails-shared]
  end

  subgraph Routing["🔀 Routing"]
    DP[hydra-dispatch.ts]
    IG[hydra-intent-gate.ts]
    PE[hydra-persona.ts]
    CT[hydra-context.ts]
    CLI[hydra-cli-detect.ts]
  end

  subgraph Providers["🌐 AI Providers"]
    AN[hydra-anthropic.ts]
    OA[hydra-openai.ts]
    GG[hydra-google.ts]
    CI[hydra-concierge.ts]
    CP[hydra-concierge-providers.ts]
    RL[hydra-rate-limits.ts]
    SM[hydra-streaming-middleware.ts]
    PU[hydra-provider-usage.ts]
  end

  subgraph Daemon["🔧 Daemon & HTTP"]
    OD[orchestrator-daemon.ts]
    RR[daemon/read-routes.ts]
    WR[daemon/write-routes.ts]
    HUB[hydra-hub.ts]
    WT[hydra-worktree.ts]
  end

  subgraph Presentation["🖥 Presentation"]
    OP[hydra-operator.ts]
    CO[hydra-council.ts]
    UI[hydra-ui.ts]
    PC[hydra-prompt-choice.ts]
    SB[hydra-statusbar.ts]
    AP[hydra-action-pipeline.ts]
  end

  subgraph Observability["📊 Observability"]
    ME[hydra-metrics.ts]
    AC[hydra-activity.ts]
    AU[hydra-audit.ts]
    TE[hydra-telemetry.ts]
    US[hydra-usage.ts]
  end

  subgraph Evolution["🔄 Evolution Engine"]
    EV[hydra-evolve.ts]
    EG[hydra-evolve-guardrails.ts]
    EI[hydra-evolve-investigator.ts]
    EK[hydra-evolve-knowledge.ts]
    ES[hydra-evolve-suggestions.ts]
    ER[hydra-evolve-review.ts]
  end

  subgraph Tasks["📋 Task Management"]
    TK[hydra-tasks.ts]
    TS[hydra-tasks-scanner.ts]
    TR[hydra-tasks-review.ts]
  end

  subgraph Nightly["🌙 Nightly Batch"]
    NY[hydra-nightly.ts]
    ND[hydra-nightly-discovery.ts]
    NR[hydra-nightly-review.ts]
  end

  subgraph Integration["🔗 Integration"]
    GH[hydra-github.ts]
    MCP[hydra-mcp-server.ts]
    SE[hydra-self.ts]
    SI[hydra-self-index.ts]
  end

  subgraph Utilities["🛠 Utilities"]
    UT[hydra-utils.ts]
    PR[hydra-proc.ts]
    CA[hydra-cache.ts]
    SY[hydra-sync-md.ts]
    UP[hydra-updater.ts]
    BT[hydra-shared/budget-tracker.ts]
    GO[hydra-shared/git-ops.ts]
    SH[hydra-setup.ts]
    KN[hydra-knowledge.ts]
    RE[hydra-resume-scanner.ts]
    CC[hydra-codebase-context.ts]
  end

  %% Foundation relationships
  T --> CFG
  P --> CFG
  CFG --> AG

  %% Agent relationships
  AG --> EX
  CH --> AG
  RC --> AG
  AG --> AW
  AG --> SA
  AG --> AF

  %% Execution relationships
  EX --> WK
  CFG --> WK
  MR --> WK
  LO -.-> EX
  CFG --> MR
  AG --> MR
  P --> MR

  %% Routing relationships
  AG --> DP
  CFG --> DP
  EX --> DP
  IG --> DP
  PE --> DP
  CT --> DP
  CLI --> DP
  CFG --> IG
  CFG --> PE
  AG --> CT
  CFG --> CT

  %% Providers
  SM --> AN
  SM --> OA
  SM --> GG
  CP --> CI
  CFG --> CI
  PE --> CI
  RL --> CP
  CFG --> CP
  AG --> CP
  CFG --> RL
  P --> RL
  SM --> RL
  CFG --> SM
  MR --> SM
  PU --> SM
  RL --> SM
  CFG --> PU
  P --> PU
  RL --> PU
  CFG --> TE
  TE --> SM

  %% Daemon
  RR --> OD
  WR --> OD
  AG --> OD
  CFG --> OD
  ME --> OD
  US --> OD
  HUB --> WR
  WT --> WR
  SE --> RR

  %% Presentation
  AG --> OP
  CFG --> OP
  ME --> OP
  EX --> OP
  CI --> OP
  CP --> OP
  SB --> OP
  UI --> OP
  AC --> OP
  GH --> OP
  SE --> OP
  AF --> OP
  SA --> OP
  AG --> CO
  CFG --> CO
  EX --> CO
  UI --> CO
  ME --> SB
  CFG --> SB
  US --> SB
  UI --> SB
  P --> UI
  VER --> UI
  UI --> PC
  UI --> AP

  %% Observability
  CFG --> ME
  ME --> AC
  CFG --> AC
  AG --> AC
  PE --> AC
  ME --> US
  CFG --> US
  AG --> US
  AG --> AU
  CFG --> AU
  EX --> AU
  CFG --> TE

  %% Evolution
  AG --> EV
  CFG --> EV
  EX --> EV
  EG --> EV
  EI --> EV
  EK --> EV
  ES --> EV
  MR --> EV
  CFG --> EG
  ME --> EG
  US --> EG
  CFG --> EI
  CFG --> ER
  GH --> ER
  ES --> ER

  %% Tasks
  AG --> TK
  CFG --> TK
  EX --> TK
  TS --> TK
  US --> TK
  AG --> TS
  CFG --> TS
  GH --> TS
  CFG --> TR
  GH --> TR

  %% Nightly
  AG --> NY
  CFG --> NY
  EX --> NY
  ND --> NY
  NR --> NY
  AG --> ND
  CFG --> ND
  EX --> ND
  TS --> ND
  CFG --> NR
  GH --> NR

  %% Integration
  CFG --> GH
  GO --> GH
  AG --> MCP
  CFG --> MCP
  EX --> MCP
  ME --> MCP
  AF --> MCP
  AG --> SE
  CFG --> SE
  ME --> SE

  %% Utilities
  AG --> UT
  PR --> UT
  EX --> UT
  UT --> PR
  CFG --> SH
  CLI --> SH
  KN --> EK
  GH --> GO
  GO --> SH
```

---

## 5. Data-Flow: Prompt Dispatch

> Traces a user prompt from the operator console through routing, execution, and back.

```mermaid
flowchart TD
  User(["👤 Operator\nREPL or CLI"])
  OP["hydra-operator.ts\nCommand parsing\n+ input buffering"]
  IG["hydra-intent-gate.ts\nPrompt pre-screening\n(confidence threshold)"]
  DP["hydra-dispatch.ts\nRoute selection\n(economy|balanced|performance)"]

  subgraph Routing["Routing Decision"]
    R_LOCAL["Local agent\n(API-backed)"]
    R_CLAUDE["claude CLI"]
    R_GEMINI["gemini CLI"]
    R_CODEX["codex CLI + --model"]
    R_CUSTOM["custom agent\n(CLI or API)"]
  end

  EX["hydra-shared/agent-executor.ts\nSpawn + stream\noutput parsing"]
  MR["hydra-model-recovery.ts\nRetry + fallback\non quota/error"]
  ME["hydra-metrics.ts\nToken accounting\nlatency recording"]
  US["hydra-usage.ts\nBudget gate check\n(daily/weekly limits)"]
  OUT(["📤 Streamed\nResponse"])

  User -->|"raw prompt"| OP
  OP -->|"classified prompt"| IG
  IG -->|"pass / block"| DP
  DP -->|"agent selector"| Routing
  Routing --> EX
  EX <-->|"quota exceeded"| MR
  MR -->|"alternate model"| EX
  EX -->|"token counts"| ME
  DP -->|"pre-flight check"| US
  US -->|"budget ok/reject"| DP
  EX -->|"streamed tokens"| OUT
  OUT -->|"rendered"| OP
```

---

## 6. Data-Flow: Council Deliberation

> Multi-round consensus pipeline across Claude → Gemini → Claude → Codex.

```mermaid
sequenceDiagram
  participant OP as hydra-operator.ts
  participant CO as hydra-council.ts
  participant CTX as hydra-context.ts
  participant PE as hydra-persona.ts
  participant EX as agent-executor.ts
  participant DR as hydra-doctor.ts
  participant MR as hydra-model-recovery.ts

  OP->>CO: runCouncil(prompt, opts)
  CO->>CTX: buildAgentContext(agent, {promptText})
  CO->>PE: getPersonaPrompt(agent)

  loop Round 1 — Claude (Architect)
    CO->>EX: executeAgent("claude", enrichedPrompt)
    EX-->>CO: round1Output
  end

  loop Round 2 — Gemini (Analyst) with Round 1 context
    CO->>EX: executeAgent("gemini", prompt+round1)
    alt quota error
      EX->>MR: handleQuotaError()
      MR-->>EX: fallbackModel
    end
    EX-->>CO: round2Output
  end

  loop Round 3 — Claude Synthesis
    CO->>EX: executeAgent("claude", allRounds)
    EX-->>CO: synthesisOutput
  end

  opt Codex Validation (if enabled)
    CO->>EX: executeAgent("codex", synthesisOutput)
    EX-->>CO: validatedOutput
  end

  CO->>DR: diagnoseIfError(outputs)
  DR-->>CO: diagnosedResult
  CO-->>OP: CouncilResult{outputs, consensus}
```

---

## 7. Data-Flow: Autonomous Evolution

> The `hydra-evolve.ts` self-improvement pipeline — 7-phase cycle.

```mermaid
flowchart LR
  subgraph Phase1["Phase 1: Discover"]
    P1A["hydra-evolve-investigator.ts\nOpenAI issue analysis"]
    P1B["hydra-evolve-knowledge.ts\nKnowledge graph read"]
    P1C["hydra-evolve-suggestions.ts\nSuggestion backlog"]
  end

  subgraph Phase2["Phase 2: Gate"]
    P2["hydra-evolve-guardrails.ts\nBudget & safety check\n(daily token limits)"]
  end

  subgraph Phase3["Phase 3: Plan"]
    P3["hydra-evolve.ts\nCouncil deliberation\n(Claude architect round)"]
  end

  subgraph Phase4["Phase 4: Implement"]
    P4["agent-executor.ts\nCodex implementation\nrun in git worktree"]
  end

  subgraph Phase5["Phase 5: Test"]
    P5A["hydra-shared/git-ops.ts\ngit diff + test run"]
    P5B["hydra-verification.ts\nVerification commands"]
  end

  subgraph Phase6["Phase 6: Review"]
    P6["hydra-evolve-review.ts\nGemini review\n+ guardrails re-check"]
  end

  subgraph Phase7["Phase 7: Decide"]
    P7["hydra-evolve.ts\nMerge / discard\ngit commit or reset"]
  end

  START(["⚡ npm run evolve"]) --> Phase1
  Phase1 --> Phase2
  Phase2 -->|"budget ok"| Phase3
  Phase2 -->|"budget exceeded"| STOP(["🛑 Aborted"])
  Phase3 --> Phase4
  Phase4 --> Phase5
  Phase5 -->|"tests pass"| Phase6
  Phase5 -->|"tests fail"| DISCARD(["🗑 Discard change"])
  Phase6 -->|"approved"| Phase7
  Phase6 -->|"rejected"| DISCARD
  Phase7 --> DONE(["✅ Committed or reset"])
```

---

## 8. Data-Flow: Nightly Batch Run

```mermaid
flowchart TD
  START(["⏰ npm run nightly\nor scheduled cron"])
  NY["hydra-nightly.ts\nOrchestrator"]

  subgraph Discovery["Discovery Phase"]
    ND["hydra-nightly-discovery.ts\nScan issues + TODO/FIXME"]
    TS["hydra-tasks-scanner.ts\nFile-level TODO mining"]
    GH1["hydra-github.ts\nFetch open issues"]
  end

  subgraph Execution["Batch Execution"]
    BT["hydra-shared/budget-tracker.ts\nPer-agent token budgets"]
    GU["hydra-shared/guardrails.ts\nSafety gate"]
    EX["agent-executor.ts\nAgent runs (parallelised)"]
    SM["hydra-sync-md.ts\nMD file sync"]
  end

  subgraph Review["Review Phase"]
    NR["hydra-nightly-review.ts\nGemini review of changes"]
    GH2["hydra-github.ts\nCreate PRs + comments"]
  end

  subgraph Verification["Verification"]
    VF["hydra-verification.ts\nRun verify commands"]
    ME["hydra-metrics.ts\nRecord run stats"]
  end

  START --> NY
  NY --> Discovery
  ND --> GH1
  ND --> TS
  Discovery --> Execution
  BT --> EX
  GU --> EX
  EX --> SM
  Execution --> Review
  NR --> GH2
  Review --> Verification
  VF --> ME
  Verification --> DONE(["📊 Nightly report written\nto hydra-metrics"])
```

---

## 9. Sequence: Task Claim → Execute → Result

> HTTP daemon task lifecycle viewed from a worker's perspective.

```mermaid
sequenceDiagram
  participant CLI as hydra-dispatch.ts\n(client)
  participant HTTP as orchestrator-daemon.ts\n(HTTP :4173)
  participant WR as daemon/write-routes.ts
  participant RR as daemon/read-routes.ts
  participant WT as hydra-worktree.ts
  participant HUB as hydra-hub.ts
  participant WK as hydra-worker.ts
  participant EX as agent-executor.ts

  CLI->>HTTP: POST /task/add {prompt, agent?}
  HTTP->>WR: handleAdd()
  WR->>HUB: enqueue(task)
  WR-->>CLI: {id, status:"queued"}

  WK->>HTTP: POST /task/claim {agent}
  HTTP->>WR: handleClaim()
  WR->>HUB: dequeue()
  opt worktreeIsolation enabled
    WR->>WT: createWorktree(taskId)
  end
  WR-->>WK: {task}

  WK->>EX: executeAgent(agent, task.prompt)
  EX-->>WK: {output, tokens}

  WK->>HTTP: POST /task/result {id, output}
  HTTP->>WR: handleResult()
  opt worktreeIsolation enabled
    WR->>WT: mergeAndCleanWorktree(taskId)
  end
  WR->>HUB: markComplete(id, output)

  CLI->>HTTP: GET /task/status/{id}
  HTTP->>RR: handleStatus()
  RR->>HUB: getTask(id)
  RR-->>CLI: {status:"complete", output}
```

---

## 10. Sequence: Operator Console Interaction

```mermaid
sequenceDiagram
  participant U as User (terminal)
  participant OP as hydra-operator.ts
  participant SB as hydra-statusbar.ts
  participant CI as hydra-concierge.ts
  participant DP as hydra-dispatch.ts
  participant ME as hydra-metrics.ts
  participant AC as hydra-activity.ts

  U->>OP: Start (npm run go)
  OP->>SB: startStatusBar()
  OP->>CI: initConcierge() [optional stream]

  loop Interactive REPL
    U->>OP: Type prompt + Enter
    OP->>OP: parseCommand(input)

    alt Special command (:council, :evolve, :tasks, ...)
      OP->>OP: dispatchSpecialCommand()
    else Regular prompt
      OP->>CI: streamConciergeResponse(prompt)
      CI-->>OP: streaming tokens
      OP->>DP: dispatchToAgent(classified prompt)
      DP-->>OP: agent output
    end

    OP->>ME: recordInteraction(tokens, latency)
    OP->>AC: logActivity(prompt, response)
    OP-->>U: Rendered output
  end

  U->>OP: :exit or Ctrl+C
  OP->>SB: stopStatusBar()
  OP->>ME: flushMetrics()
```

---

## 11. State Machine: Daemon Task Lifecycle

```mermaid
stateDiagram-v2
  [*] --> queued: POST /task/add

  queued --> claimed: POST /task/claim\n(agent picks up task)
  queued --> cancelled: DELETE /task/{id}

  claimed --> running: agent-executor.ts\nspawns agent process
  claimed --> queued: claim timeout\n(worker died)

  running --> complete: POST /task/result\n(success)
  running --> failed: POST /task/result\n(error output)
  running --> running: heartbeat\nPOST /task/heartbeat

  complete --> [*]
  failed --> queued: auto-retry\n(if retries remain)
  failed --> [*]: max retries exceeded

  cancelled --> [*]
```

---

## 12. Domain Cluster Map

> Shows which modules belong to each logical domain and their inter-domain coupling.

```mermaid
graph TB
  subgraph Foundation["🧱 Foundation (no deps on other lib/)"]
    T[types.ts]
    P[hydra-model-profiles.ts]
    C[hydra-shared/constants.ts]
    ENV[hydra-env.ts]
    VER[hydra-version.ts]
    RC[hydra-routing-constants.ts]
    CFG["hydra-config.ts\n⚠ Hub — 23 fan-in"]
  end

  subgraph AgentCore["🤖 Agent Core"]
    AG[hydra-agents.ts]
    CH[codex-helpers.ts]
    AW[agents-wizard.ts]
    AF[agent-forge.ts]
    SA[sub-agents.ts]
    CD[cli-detect.ts]
    SH[hydra-setup.ts]
  end

  subgraph ExecInfra["⚡ Execution Infrastructure"]
    EX["agent-executor.ts\n⚠ 1,824 LOC"]
    WK[hydra-worker.ts]
    LO[hydra-local.ts]
    MR[hydra-model-recovery.ts]
    PR[hydra-proc.ts]
  end

  subgraph RoutingLayer["🔀 Routing"]
    DP[hydra-dispatch.ts]
    IG[hydra-intent-gate.ts]
    PE[hydra-persona.ts]
    CT[hydra-context.ts]
  end

  subgraph ProviderAdapters["🌐 AI Provider Adapters"]
    AN[hydra-anthropic.ts]
    OA[hydra-openai.ts]
    GG[hydra-google.ts]
    CI[hydra-concierge.ts]
    CP[hydra-concierge-providers.ts]
    RL[hydra-rate-limits.ts]
    SM[hydra-streaming-middleware.ts]
    PU[hydra-provider-usage.ts]
    TE[hydra-telemetry.ts]
  end

  subgraph DaemonHTTP["🔧 HTTP Daemon"]
    OD[orchestrator-daemon.ts]
    RR[daemon/read-routes.ts]
    WR[daemon/write-routes.ts]
    HUB[hydra-hub.ts]
    WT[hydra-worktree.ts]
  end

  subgraph PresentationLayer["🖥 Presentation"]
    OP["hydra-operator.ts\n⚠ 6,630 LOC"]
    CO[hydra-council.ts]
    UI[hydra-ui.ts]
    PC[hydra-prompt-choice.ts]
    SB[hydra-statusbar.ts]
    AP[hydra-action-pipeline.ts]
  end

  subgraph ObservabilityLayer["📊 Observability"]
    ME["hydra-metrics.ts\n⚠ self-import"]
    AC[hydra-activity.ts]
    AU[hydra-audit.ts]
    US[hydra-usage.ts]
  end

  subgraph EvolutionEngine["🔄 Evolution Engine"]
    EV["hydra-evolve.ts\n3,657 LOC"]
    EG[evolve-guardrails.ts]
    EI[evolve-investigator.ts]
    EK[evolve-knowledge.ts]
    ES[evolve-suggestions.ts]
    ER[evolve-review.ts]
  end

  subgraph TaskMgmt["📋 Task Management"]
    TK[hydra-tasks.ts]
    TS[tasks-scanner.ts]
    TR[tasks-review.ts]
  end

  subgraph NightlyBatch["🌙 Nightly Batch"]
    NY[hydra-nightly.ts]
    ND[nightly-discovery.ts]
    NR[nightly-review.ts]
  end

  subgraph Integration["🔗 External Integration"]
    GH[hydra-github.ts]
    MCP[hydra-mcp-server.ts]
    SE[hydra-self.ts]
    SI[hydra-self-index.ts]
  end

  subgraph Utilities["🛠 Utilities"]
    UT[hydra-utils.ts]
    CA[hydra-cache.ts]
    SY[hydra-sync-md.ts]
    UP[hydra-updater.ts]
    BT[budget-tracker.ts]
    GO[git-ops.ts]
    KN[hydra-knowledge.ts]
    RE[resume-scanner.ts]
    CC[codebase-context.ts]
  end

  Foundation -->|"config"| AgentCore
  Foundation -->|"config"| ExecInfra
  Foundation -->|"config"| RoutingLayer
  AgentCore --> ExecInfra
  ExecInfra --> RoutingLayer
  RoutingLayer --> ProviderAdapters
  RoutingLayer --> DaemonHTTP
  ProviderAdapters --> DaemonHTTP
  ExecInfra --> PresentationLayer
  AgentCore --> PresentationLayer
  RoutingLayer --> PresentationLayer
  ObservabilityLayer --> PresentationLayer
  ExecInfra --> ObservabilityLayer
  Foundation -->|"config"| ObservabilityLayer
  ExecInfra --> EvolutionEngine
  ExecInfra --> TaskMgmt
  ExecInfra --> NightlyBatch
  Integration --> TaskMgmt
  Integration --> NightlyBatch
  Integration --> EvolutionEngine
  Utilities --> ExecInfra
  Utilities --> TaskMgmt
  Utilities --> NightlyBatch
  Utilities --> EvolutionEngine
```

---

## 13. Dependency Fan-In / Fan-Out Heat Map

> Fan-in = number of files that import this module. Fan-out = number of lib/ files this module imports.
> Modules with high fan-in are fragile (many dependents). High fan-out modules are hard to test in isolation.

```mermaid
quadrantChart
  title Module Coupling Heat Map (fan-in vs fan-out)
  x-axis "Low Fan-Out" --> "High Fan-Out (hard to test)"
  y-axis "Low Fan-In" --> "High Fan-In (fragile / bottleneck)"

  quadrant-1 "Refactor Priority: Split or Extract Interface"
  quadrant-2 "Stable Core: Protect with strong tests"
  quadrant-3 "Low Risk: Leaf modules"
  quadrant-4 "God Objects: Break down urgently"

  hydra-config.ts: [0.05, 0.95]
  hydra-agents.ts: [0.15, 0.85]
  hydra-metrics.ts: [0.05, 0.80]
  hydra-usage.ts: [0.20, 0.65]
  hydra-shared/agent-executor.ts: [0.15, 0.60]
  hydra-utils.ts: [0.15, 0.50]
  hydra-model-profiles.ts: [0.05, 0.45]
  hydra-operator.ts: [0.90, 0.10]
  hydra-evolve.ts: [0.75, 0.10]
  hydra-nightly.ts: [0.70, 0.10]
  hydra-actualize.ts: [0.72, 0.08]
  hydra-council.ts: [0.55, 0.25]
  orchestrator-daemon.ts: [0.60, 0.15]
  hydra-tasks.ts: [0.65, 0.12]
  hydra-dispatch.ts: [0.50, 0.35]
  hydra-concierge.ts: [0.30, 0.30]
  hydra-ui.ts: [0.12, 0.55]
  hydra-streaming-middleware.ts: [0.35, 0.25]
  hydra-model-recovery.ts: [0.25, 0.45]
  hydra-github.ts: [0.20, 0.40]
  types.ts: [0.02, 0.70]
  hydra-env.ts: [0.02, 0.20]
  hydra-proc.ts: [0.05, 0.30]
  hydra-local.ts: [0.05, 0.20]
```

---

## 14. Cyclic Dependency Graph

> Three detected cyclic import chains — each breaks tree-shaking, complicates testing, and can cause runtime `undefined` module errors.

```mermaid
graph LR
  subgraph Cycle1["⚠ Cycle 1: Activity ↔ Statusbar"]
    AC1["hydra-activity.ts"] -->|"imports statusbar"| SB1["hydra-statusbar.ts"]
    SB1 -->|"imports usage\n(imports activity indirectly)"| US1["hydra-usage.ts"]
    US1 -->|"self-import via metrics"| ME1["hydra-metrics.ts"]
    ME1 -->|"config only"| CFG1["hydra-config.ts"]
  end

  subgraph Cycle2["⚠ Cycle 2: Rate-limits ↔ Streaming"]
    RL2["hydra-rate-limits.ts"] -->|"imports streaming"| SM2["hydra-streaming-middleware.ts"]
    SM2 -->|"imports rate-limits"| RL2
  end

  subgraph Cycle3["⚠ Cycle 3: Metrics self-import"]
    ME3["hydra-metrics.ts"] -->|"self-import (line ~1)"| ME3
  end

  style Cycle1 fill:#fff3cd,stroke:#ffc107
  style Cycle2 fill:#f8d7da,stroke:#dc3545
  style Cycle3 fill:#f8d7da,stroke:#dc3545
```

---

## Appendix: Module Inventory

| Module                         | Lines | Fan-In | Fan-Out | Has Tests | Domain        |
| ------------------------------ | ----: | -----: | ------: | :-------: | ------------- |
| hydra-operator.ts              | 6,630 |      0 |      29 |    ❌     | Presentation  |
| hydra-evolve.ts                | 3,657 |      1 |      11 |    ❌     | Evolution     |
| hydra-council.ts               | 2,321 |      2 |      11 |    ✅     | Presentation  |
| hydra-shared/agent-executor.ts | 1,824 |      5 |       4 |    ❌     | Execution     |
| orchestrator-daemon.ts         | 1,670 |      0 |      12 |    ❌     | Daemon        |
| hydra-ui.ts                    | 1,561 |      8 |       2 |    ✅     | Presentation  |
| hydra-agents.ts                | 1,496 |    15+ |       5 |    ✅     | Agent Core    |
| hydra-agent-forge.ts           | 1,247 |      2 |       6 |    ✅     | Agent Core    |
| hydra-nightly.ts               | 1,233 |      0 |      15 |    ❌     | Nightly Batch |
| hydra-model-profiles.ts        | 1,143 |      6 |       1 |    ✅     | Foundation    |
| hydra-audit.ts                 | 1,126 |      0 |       4 |    ❌     | Observability |
| hydra-config.ts                | 1,067 |     23 |       2 |    ❌     | Foundation    |
| hydra-mcp-server.ts            | 1,059 |      0 |       9 |    ❌     | Integration   |
| hydra-tasks.ts                 | 1,055 |      1 |      14 |    ❌     | Task Mgmt     |
| hydra-usage.ts                 | 1,051 |      6 |       5 |    ❌     | Observability |
| hydra-doctor.ts                | 1,037 |      1 |       2 |    ✅     | Presentation  |
| types.ts                       |   941 |    12+ |       0 |    ✅     | Foundation    |
| hydra-statusbar.ts             |   915 |      2 |       4 |    ❌     | Presentation  |
| hydra-activity.ts              |   897 |      3 |       6 |    ✅     | Observability |
| hydra-model-recovery.ts        |   865 |      5 |       3 |    ✅     | Execution     |
| hydra-actualize.ts             |  ~800 |      0 |      16 |    ❌     | Task Mgmt     |
| hydra-shared/git-ops.ts        |  ~750 |      8 |       0 |    ✅     | Utilities     |
| hydra-dispatch.ts              |  ~700 |      1 |      10 |    ✅     | Routing       |
| hydra-concierge.ts             |  ~650 |      2 |       7 |    ❌     | Providers     |
| hydra-streaming-middleware.ts  |  ~620 |      4 |       5 |    ✅     | Providers     |
| hydra-rate-limits.ts           |  ~580 |      4 |       3 |    ✅     | Providers     |
| hydra-metrics.ts               |  ~560 |    10+ |       1 |    ✅     | Observability |
| hydra-knowledge.ts             |  ~520 |      2 |       1 |    ❌     | Utilities     |
| hydra-setup.ts                 |  ~500 |      3 |       2 |    ✅     | Utilities     |
| hydra-intent-gate.ts           |  ~480 |      1 |       2 |    ✅     | Routing       |
| hydra-worker.ts                |  ~460 |      1 |       5 |    ❌     | Execution     |
| hydra-context.ts               |  ~440 |      3 |       3 |    ✅     | Routing       |
| hydra-hub.ts                   |  ~420 |      2 |       0 |    ✅     | Daemon        |
| hydra-provider-usage.ts        |  ~400 |      3 |       3 |    ❌     | Providers     |
| hydra-github.ts                |  ~390 |      6 |       3 |    ✅     | Integration   |
| hydra-self.ts                  |  ~380 |      3 |       4 |    ✅     | Integration   |
| hydra-codebase-context.ts      |  ~360 |      1 |       1 |    ✅     | Utilities     |
| hydra-sync-md.ts               |  ~350 |      5 |       0 |    ✅     | Utilities     |
| hydra-sub-agents.ts            |  ~340 |      2 |       3 |    ❌     | Agent Core    |
| hydra-nightly-discovery.ts     |  ~320 |      1 |       7 |    ❌     | Nightly Batch |
| hydra-tasks-scanner.ts         |  ~310 |      3 |       4 |    ❌     | Task Mgmt     |
| hydra-verification.ts          |  ~300 |      4 |       2 |    ✅     | Utilities     |
| hydra-persona.ts               |  ~280 |      4 |       1 |    ❌     | Routing       |
| hydra-cli-detect.ts            |  ~260 |      2 |       0 |    ✅     | Utilities     |
| hydra-agents-wizard.ts         |  ~250 |      1 |       2 |    ✅     | Agent Core    |
| hydra-telemetry.ts             |  ~240 |      1 |       1 |    ✅     | Providers     |
| hydra-proc.ts                  |  ~230 |      3 |       0 |    ✅     | Utilities     |
| hydra-openai.ts                |  ~220 |      2 |       1 |    ❌     | Providers     |
| hydra-anthropic.ts             |  ~210 |      1 |       1 |    ❌     | Providers     |
| hydra-google.ts                |  ~200 |      1 |       1 |    ❌     | Providers     |
| hydra-env.ts                   |  ~190 |      3 |       0 |    ❌     | Foundation    |
| hydra-evolve-review.ts         |  ~180 |      1 |       8 |    ❌     | Evolution     |
| hydra-evolve-guardrails.ts     |  ~170 |      2 |       5 |    ❌     | Evolution     |
| hydra-concierge-providers.ts   |  ~160 |      3 |       3 |    ✅     | Providers     |
| hydra-worktree.ts              |  ~155 |      1 |       0 |    ✅     | Daemon        |
| hydra-local.ts                 |  ~150 |      1 |       0 |    ✅     | Execution     |
| hydra-nightly-review.ts        |  ~145 |      1 |       7 |    ❌     | Nightly Batch |
| hydra-tasks-review.ts          |  ~140 |      0 |       7 |    ❌     | Task Mgmt     |
| hydra-models.ts                |  ~140 |      0 |       2 |    ❌     | Providers     |
| hydra-evolve-investigator.ts   |  ~130 |      1 |       2 |    ❌     | Evolution     |
| hydra-prompt-choice.ts         |  ~125 |      2 |       1 |    ✅     | Presentation  |
| hydra-models-select.ts         |  ~120 |      0 |       0 |    ❌     | Providers     |
| hydra-action-pipeline.ts       |  ~115 |      0 |       2 |    ✅     | Presentation  |
| hydra-evolve-suggestions.ts    |  ~110 |      2 |       1 |    ✅     | Evolution     |
| hydra-evolve-knowledge.ts      |  ~105 |      1 |       1 |    ❌     | Evolution     |
| hydra-routing-constants.ts     |  ~100 |      2 |       0 |    ❌     | Foundation    |
| hydra-shared/budget-tracker.ts |   ~95 |      3 |       0 |    ✅     | Utilities     |
| hydra-shared/guardrails.ts     |   ~90 |      4 |       0 |    ✅     | Utilities     |
| hydra-shared/review-common.ts  |   ~85 |      3 |       0 |    ❌     | Utilities     |
| hydra-shared/index.ts          |   ~80 |      2 |       0 |    ❌     | Utilities     |
| hydra-version.ts               |   ~75 |      1 |       0 |    ✅     | Foundation    |
| hydra-resume-scanner.ts        |   ~70 |      1 |       0 |    ❌     | Utilities     |
| hydra-self-index.ts            |   ~65 |      2 |       0 |    ❌     | Integration   |
| hydra-updater.ts               |   ~60 |      1 |       0 |    ❌     | Utilities     |
| hydra-cache.ts                 |   ~55 |      1 |       0 |    ✅     | Utilities     |
| hydra-mcp.ts                   |   ~50 |      0 |       0 |    ✅     | Integration   |
| hydra-mermaid-lint.ts          |   ~45 |      0 |       0 |    ✅     | Utilities     |
| hydra-output-history.ts        |   ~40 |      0 |       0 |    ❌     | Utilities     |
| hydra-exec.ts                  |   ~35 |      1 |       0 |    ❌     | Utilities     |
| hydra-cleanup.ts               |   ~30 |      0 |       0 |    ❌     | Utilities     |
| hydra-shared/codex-helpers.ts  |   ~25 |      1 |       0 |    ❌     | Utilities     |
| daemon/read-routes.ts          |  ~220 |      1 |       2 |    ❌     | Daemon        |
| daemon/write-routes.ts         |  ~380 |      1 |       3 |    ❌     | Daemon        |
