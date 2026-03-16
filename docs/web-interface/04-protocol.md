# Browser Protocol Requirements

## Why a New Protocol Layer Is Needed

The current daemon HTTP and SSE endpoints are useful, but they do not by themselves define a real
browser REPL. A rich chat workspace needs explicit conversation and streaming contracts.

## Core Protocol Objects

- **Conversation** — top-level workspace thread with metadata and routing context.
- **Turn** — one user input and the resulting assistant/system/agent activity.
- **StreamEvent** — incremental text, lifecycle update, approval request, checkpoint, warning,
  artifact notice, or failure.
- **ApprovalRequest** — a typed request for confirmation or additional input.
- **Artifact** — file, patch, plan, diff, log, or other result object.
- **SessionSnapshot** — resumable browser state for reconnect and history replay.

## Required Daemon Contract Families

The web REPL can only be as strong as the backend contracts behind it. The following families
should be treated as explicit design targets, even if they are introduced incrementally.

1. **Conversation messaging**
   - create/open/resume conversation;
   - submit a turn;
   - stream incremental output and typed lifecycle events.

2. **Command catalog and command execution**
   - discover supported Hydra commands and their argument shapes;
   - execute command-style workflows through typed backend contracts rather than browser-only hacks.

3. **Council and multi-agent eventing**
   - structured events for phase transitions, per-agent output, votes, reasoning, and decisions.

4. **Task live output**
   - stream task progress, checkpoints, and live stdout/stderr-equivalent output in browser-safe form.

5. **Config and controlled mutations**
   - read masked config;
   - write only allowlisted settings through audited, concurrency-safe endpoints.

6. **Operational intelligence**
   - agent availability/health;
   - budgets, usage, affinity, suggestions, and knowledge surfaces where Hydra already has or gains
     daemon-owned support.

## Required Flows

### Conversation bootstrap

- browser opens or creates a conversation;
- gateway returns authoritative snapshot data;
- browser establishes its live session transport and hydrates the workspace.

### Turn submission

- browser submits prompt or action command;
- daemon acknowledges acceptance and stream identity;
- browser uses optimistic state only when explicitly safe.

### Streaming execution

- text and structured events arrive incrementally;
- ordering is preserved;
- reconnect can resume from the last acknowledged event sequence;
- replay after refresh is supported.

### Approval and follow-up

- daemon emits a typed approval or follow-up request;
- browser renders a safe structured control rather than a fake terminal prompt;
- operator response goes back through the same conversation/session contract.

### Cancellation and retry

- cancel, retry, fork, and follow-up are typed commands;
- UI derives its state from authoritative events rather than local guesswork.

### Artifact retrieval

- artifacts are queryable by stable identifiers;
- large outputs should not require replaying the whole transcript;
- artifact types should be renderable in browser-appropriate ways.

## Transport Position

**WebSocket should be the canonical transport for the conversation stream.**

Use:

- **WebSocket** for bidirectional interactive streaming;
- **REST/JSON** for auth bootstrap, settings, uploads, and coarse-grained commands;
- **SSE** only where simple read-only streaming or legacy compatibility still makes sense.

The browser REPL should not be designed around a one-way stream pretending to be full interaction.

## Protocol Design Rules

- every request and event shape should be shared through `packages/web-contracts`;
- browser optimism must never become the source of truth for task or conversation state;
- reconnect and replay semantics should be designed up front, not left to ad hoc client behavior;
- command-like browser actions should map to typed backend contracts rather than stringly typed
  transport shortcuts;
- if the browser needs a new capability to feel like a real REPL, that capability should be named
  and specified explicitly instead of being smuggled into the gateway.
