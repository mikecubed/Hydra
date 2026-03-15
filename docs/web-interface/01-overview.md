# Web Interface Overview

## Purpose

Hydra's terminal REPL remains the reference experience today, but the desired end state is a
browser-native Hydra workspace that is rich enough to act as a primary interface for many operator
workflows.

This is not a "small dashboard" project. The target is a **full REPL-grade web experience** with a
high-quality conversational interface and Hydra-specific operational visibility.

## What "Full REPL" Means

"Full REPL" does **not** mean embedding a raw terminal in the browser.

For Hydra, it means a browser user can complete the same categories of work they expect from the
terminal experience, but in a browser-native form optimized for streaming, history, approvals,
inspection, artifacts, and multi-panel context.

### Required experience characteristics

1. **Rich conversation workspace**
   - persistent conversations and resumable sessions;
   - streaming output and agent activity;
   - attachments, artifacts, and structured results;
   - retry, cancel, branch, and follow-up interactions.

2. **Hydra-native orchestration visibility**
   - active agent, selected model, routing mode, and council strategy are visible;
   - task status, checkpoints, queue state, budgets, and daemon health are inspectable;
   - council and multi-agent runs are understandable in the UI.

3. **Interactive flow support**
   - browser-safe confirmations and approvals;
   - resumable interrupted work;
   - explicit handling of long-running and background tasks.

4. **Operational observability**
   - clear connection, auth, daemon, and stream status;
   - inspectable events/history;
   - visible handling of reconnect and partial failure.

5. **No fake parity**
   - a one-shot `/task/add` plus timeline is not a full chat system;
   - if richer interactions are needed, they must exist as real backend contracts.

## Goals

- Deliver a browser-first Hydra workspace that can serve as a primary operator surface.
- Preserve Hydra's differentiators: routing, councils, task execution, approvals, checkpoints,
  budgets, and operational controls.
- Build the web experience in a way that is explicit, typed, testable, and suitable for
  agent-assisted implementation.
- Keep quality and security ahead of speed.

## Non-Goals

- pixel-perfect recreation of the terminal UI;
- forcing every workflow into the browser in phase one;
- public internet multi-tenant hosting as an initial target;
- letting the web gateway become a second orchestration engine;
- adding heavyweight web dependencies directly into Hydra's current core runtime.
