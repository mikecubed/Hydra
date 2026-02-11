# Hydra Ecosystem Research: Frameworks, Gateways, Durability, Observability, MCP

**Date:** 2026-02-10
**Purpose:** Compare industry tools against Hydra's existing capabilities, identify gaps, and prioritize improvements.

---

## Executive Summary

We researched 20+ tools across 5 categories. Hydra already covers significant ground compared to industry frameworks, validating its architecture. The highest-impact improvements fall into 4 tiers:

### Tier 1 — High Impact, Low Effort (Do Now)
1. **OTel GenAI tracing** — Add standardized distributed tracing to `executeAgent()` and streaming clients
2. **Middleware-composable streaming clients** — Refactor rate limit/circuit breaker/retry into a composable pipeline
3. **PeakEWMA health scoring** — Upgrade `getHealthiestProvider()` with exponential moving average latency tracking
4. **MCP resource serving** — Expose Hydra's rich internal state (config, metrics, activity) as MCP resources

### Tier 2 — High Impact, Medium Effort (Do Soon)
5. **Lightweight durable execution** — Checkpoint-based crash recovery for agent calls (no Temporal dependency)
6. **MCP protocol upgrade** — Move from 2024-11-05 to 2025-11-25 spec, add Tasks primitive
7. **Provider budget enforcement** — Per-provider spend limits with time windows (from LiteLLM pattern)
8. **Parallel guardrails** — Run safety checks concurrently with agent execution (from OpenAI Agents SDK)

### Tier 3 — Medium Impact, Higher Effort (Plan For)
9. **Declarative dispatch config** — Portable JSON config per dispatch (from Portkey pattern)
10. **Typed event protocol** — Formalize daemon events with schemas (from AutoGen/LlamaIndex patterns)
11. **Multi-server MCP client** — Consume tools from external MCP servers
12. **Unified memory architecture** — Short-term/long-term/entity memory tiers (from CrewAI pattern)

### Tier 4 — Strategic / Future
13. **Streamable HTTP MCP transport** — Expose Hydra tools to remote agents
14. **A2A protocol monitoring** — Watch Google's agent-to-agent standard
15. **Full Temporal adoption** — If Hydra scales to multi-machine deployment

---

## Category 1: Agent Orchestration Frameworks

### What We Learned

| Framework | Key Pattern | Hydra Equivalent | Gap |
|-----------|------------|-----------------|-----|
| **LangGraph** | Graph + checkpointing per step | Event-sourced daemon | No per-step snapshots |
| **AutoGen** | Typed message protocol | String-based events | No typed events |
| **MAF** | MagenticOrchestration (dynamic task ledger) | Council deliberation | Rigid phase sequence |
| **Semantic Kernel** | Plugin system + filter middleware | MCP tools + executeAgentWithRecovery | No formal filter chain |
| **CrewAI** | Role personas + memory tiers | hydra-persona + hydra-knowledge | No unified memory arch |
| **PydanticAI** | Typed tool contracts + DI | MCP tool schemas | No dependency injection |
| **smolagents** | Code-as-action, minimal deps | Pure ESM, 2 deps | Already aligned |
| **LlamaIndex** | Event-driven steps + microservice deploy | Daemon + workers | Missing typed events |
| **OpenAI Agents SDK** | Handoff declarations + parallel guardrails | Tandem dispatch + sequential guards | Guards not parallel |

### Key Patterns to Adopt

**1. Parallel Guardrails (OpenAI Agents SDK)**
Run safety checks (secrets scanning, diff size, budget) concurrently with agent execution. Currently Hydra runs these sequentially in `executeAgentWithRecovery()`.

**2. Context Variables / Dependency Injection (OpenAI Agents SDK, PydanticAI)**
A formal context object carrying daemon URL, config, session state — injected into tools/agents but never sent to LLMs. Improves testability.

**3. Typed Event Protocol (AutoGen, LlamaIndex)**
Formalize daemon events with schemas. Currently events are untyped JSON objects with ad-hoc fields.

**4. Dynamic Task Ledger (MAF MagenticOrchestration)**
Instead of rigid council phases, a manager maintaining a living task breakdown. Could evolve council into a more adaptive pattern.

---

## Category 2: Model Gateways

### What We Learned

| Gateway | Key Strength | Hydra Equivalent | Gap |
|---------|-------------|-----------------|-----|
| **LiteLLM** | Provider budget routing with time windows | Provider usage tracking | No budget enforcement |
| **LiteLLM** | Cooldown per deployment | Circuit breaker per model | Less granular |
| **Portkey** | Declarative routing config per request | classifyPrompt() | Not portable/testable |
| **Portkey** | Conditional routing ($and/$or on metadata) | Route strategy enum | Less flexible |
| **Helicone** | PeakEWMA latency-based routing | Health scoring in getHealthiestProvider | Simpler algorithm |
| **Helicone** | Error rate auto-fallback at 10% threshold | Count-based circuit breaker | Missing rate-based |
| **Helicone** | Tower-style middleware composition | Separate rate limit/circuit/retry code | Not composable |

### Key Patterns to Adopt

**1. PeakEWMA Health Scoring (Helicone)**
Replace simple health scoring with exponentially weighted moving averages of latency. More responsive to recent performance changes.

```javascript
// Current: simple remaining capacity scoring
// Proposed: PeakEWMA tracking per provider
class PeakEWMA {
  constructor(decayNs = 10_000_000_000) { /* 10s decay */ }
  observe(latencyMs) { /* update weighted average */ }
  get() { /* return current estimate */ }
}
```

**2. Middleware-Composable Streaming Clients (Helicone Tower pattern)**
Refactor `hydra-openai.mjs`, `hydra-anthropic.mjs`, `hydra-google.mjs` to use composable middleware:
```
rateLimit(circuitBreak(retry(providerUsage(baseCall))))
```
Each layer independently testable.

**3. Provider Budget Enforcement (LiteLLM)**
Add per-provider spend limits with configurable time windows to `hydra-config.mjs`:
```json
{ "providers": { "openai": { "budgetLimit": 50, "budgetPeriod": "1d" } } }
```

**4. Error Rate Auto-Fallback (Helicone)**
Add rate-based (not just count-based) circuit breaking. If rolling error rate > 10%, trigger fallback.

---

## Category 3: Durable Execution

### What We Learned

| Tool | Architecture | Crash Recovery | Complexity | License |
|------|-------------|----------------|------------|---------|
| **Temporal** | Server + workers + DB | Full (event replay) | Very High | MIT |
| **Inngest** | Serverless + step functions | Full (step journaling) | Medium | SSPL |
| **Restate** | Reverse proxy + journal | Full (ctx.run journal) | Medium | BUSL |
| **DBOS** | Library + Postgres | Full (DB-backed steps) | Low | MIT |
| **LangGraph** | Checkpointer per node | Per-node checkpoints | Medium | MIT |

### The Critical Gap

Hydra's biggest durability gap: **mid-execution crash recovery**. If a worker dies during a 10-minute agent CLI call, all in-flight work is lost. The daemon detects the stale task eventually, but the task retries from scratch.

### Recommended Approach: Lightweight Durable Execution (Option 3 from research)

Don't adopt Temporal (too heavy). Instead, extend Hydra's existing event sourcing:

1. **Activity-level events**: Record `agent:call:start` and `agent:call:complete` events in the daemon
2. **Heartbeat reporting**: Workers send periodic heartbeats to daemon during agent execution
3. **Stale heartbeat detection**: Daemon requeues tasks with no heartbeat in N seconds
4. **Checkpoint-based partial recovery**: Store partial output at heartbeat intervals

This builds on Hydra's existing architecture (event sourcing, task checkpoints, dead-letter queue) without external dependencies.

---

## Category 4: Observability

### What We Learned

| Tool | Type | Hydra Fit | Self-Host | License |
|------|------|-----------|-----------|---------|
| **Langfuse** | Full LLM platform | High | Complex (4 systems) | MIT |
| **Helicone** | Gateway + logs | Medium (API-only) | Easy (1 container) | Apache 2.0 |
| **OTel GenAI** | Standard + any backend | Highest | Backend-dependent | Apache 2.0 |
| **Arize Phoenix** | OTel-native platform | Medium-High | Easy | BSD-3 |
| **LangSmith** | LangChain ecosystem | Low | No self-host | Proprietary |

### Recommended Approach: OTel GenAI Conventions

Emit standard OTel spans from Hydra's agent execution and streaming clients. This is the most flexible approach — traces flow to any OTLP-compatible backend (Jaeger, Grafana, Langfuse, Arize Phoenix).

**Why not Langfuse directly?** Langfuse requires Postgres + ClickHouse + Redis + S3 — too heavy. But Langfuse accepts OTLP, so we get compatibility for free by emitting OTel spans.

**Implementation**: Add `@opentelemetry/api` and `@opentelemetry/sdk-node` as optional peer dependencies. Instrument:
- `executeAgent()` → `invoke_agent` spans with `gen_ai.agent.name`
- `streamCompletion()` / `streamAnthropicCompletion()` / `streamGoogleCompletion()` → `chat` spans with token/cost attributes
- Council phases → nested spans
- Handoffs → span links

**Key OTel GenAI attributes to emit:**
```
gen_ai.system = "openai" | "anthropic" | "google"
gen_ai.request.model = model ID
gen_ai.usage.input_tokens = N
gen_ai.usage.output_tokens = N
gen_ai.agent.name = "claude" | "gemini" | "codex"
gen_ai.operation.name = "chat" | "invoke_agent"
```

---

## Category 5: MCP Ecosystem

### What We Learned

Hydra's MCP implementation is **two spec versions behind** (2024-11-05 vs current 2025-11-25). The spec has added:
- Structured content (typed tool outputs)
- Tasks primitive (async operations — maps directly to Hydra's task queue)
- Elicitation (human-in-the-loop)
- Extensions framework
- OAuth 2.1 authorization
- Streamable HTTP transport

### Key Gaps and Opportunities

| Capability | Current | Opportunity |
|-----------|---------|------------|
| Protocol version | 2024-11-05 | Upgrade to 2025-11-25 |
| Tools exposed | 10 | Add more (evolve, nightly, metrics, eval) |
| Resources | None | Expose config, metrics, activity, knowledge, agents |
| Prompts | None | Council, review, analyze templates |
| Tasks (async) | None | Map daemon tasks → MCP Tasks |
| Transport | stdio only | Add Streamable HTTP on daemon port |
| Client | Codex MCP only | Multi-server aggregation |
| Auth | None | At minimum API key, ideally OAuth 2.1 |
| SDK | Hand-rolled JSON-RPC | Consider official SDK (adds `zod` dep) |

### Decision: SDK vs Hand-Rolled

The official `@modelcontextprotocol/sdk` requires `zod` as a dependency. Hydra currently has only 2 deps (picocolors, cross-spawn). Options:

**A. Accept zod** — Justified by MCP's importance. Get automatic protocol negotiation, transport flexibility, resource/prompt/task support. (Recommended)

**B. Continue hand-rolled** — Implement spec-compliant handlers manually. More work, no new deps. Keep for now if dependency count is sacred.

**C. Hybrid** — Hand-roll core JSON-RPC, use zod only for schema validation in tool definitions. Partial benefit.

---

## Implementation Priority Matrix

| # | Improvement | Effort | Impact | Deps Added | Category |
|---|-----------|--------|--------|------------|----------|
| 1 | OTel GenAI tracing | Medium | High | @opentelemetry/api (optional) | Observability |
| 2 | Middleware streaming pipeline | Medium | High | None | Gateway |
| 3 | PeakEWMA health scoring | Low | Medium | None | Gateway |
| 4 | MCP resource serving | Low | High | None (or zod) | MCP |
| 5 | Heartbeat-based crash recovery | Medium | Very High | None | Durability |
| 6 | MCP protocol upgrade to 2025-11-25 | Medium | High | zod (if SDK) | MCP |
| 7 | Provider budget enforcement | Low | Medium | None | Gateway |
| 8 | Parallel guardrails | Low | Medium | None | Frameworks |
| 9 | Declarative dispatch config | Medium | Medium | None | Gateway |
| 10 | Typed event protocol | High | Medium | None | Frameworks |
| 11 | Multi-server MCP client | High | Medium | None | MCP |
| 12 | Unified memory architecture | High | Medium | None | Frameworks |

---

## Architecture Validation

Hydra's existing architecture aligns well with industry patterns:

| Hydra Component | Industry Equivalent |
|----------------|-------------------|
| HTTP daemon + workers | llama-deploy control plane + microservices |
| Council deliberation | AutoGen GroupChat / MAF GroupChatOrchestration |
| Tandem dispatch | MAF HandoffOrchestration / OpenAI Agents SDK handoffs |
| Event-sourced state | LangGraph checkpointing / Temporal event history |
| Role-based agents | CrewAI crew model |
| classifyPrompt() routing | LangGraph conditional edges / Portkey conditional routing |
| Minimal dependencies (2) | smolagents philosophy |
| Agent forge | CrewAI dynamic agent creation |
| hydra-persona | CrewAI role/goal/backstory |

**Bottom line**: Hydra is architecturally sound and competitive with major frameworks. The gaps are in standardization (OTel, MCP spec compliance), durability (crash recovery), and composability (middleware pattern).

---

## Sources

Full source lists included in individual research documents:
- `docs/research/frameworks.md` (65+ sources)
- `docs/research/gateways.md` (40+ sources)
- `docs/research/durability.md` (50+ sources)
- `docs/research/observability.md` (45+ sources)
- `docs/research/mcp-ecosystem.md` (40+ sources)
