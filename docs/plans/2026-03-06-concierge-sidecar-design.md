# Concierge Sidecar During Dispatch/Council

**Date:** 2026-03-06
**Status:** Approved

## Problem

When council deliberates or a dispatch pipeline runs, the operator REPL's `rl.on('line')` handler is suspended at an `await`. Readline itself stays active — new input fires new handler invocations concurrently — but there is no safe routing for that input. Users are left staring at a spinner with no way to ask questions.

## Goal

Auto-route free-form input to concierge while a blocking dispatch or council is in flight. Commands (`:foo`) still execute normally. The concierge response prints inline without disturbing the spinner or status bar, using the same ANSI pattern already established by worker notifications.

## Scope

One file changed: `lib/hydra-operator.mjs`. ~30 lines net. No new modules, no new config keys, no new exports.

## Design

### State

Two new local variables inside `interactiveLoop()`:

```js
let dispatchDepth = 0;  // >0 means a blocking dispatch/council is in flight
let sidecaring    = false; // prevents stacking concurrent sidecar conciergeTurn calls
```

`dispatchDepth` is incremented before and decremented in `finally` around every blocking long-running `await`:

| Site | Line (approx) | Why |
|------|---------------|-----|
| `await runAutoPrompt(...)` (auto/smart) | ~4550 | Spawns agent child processes |
| `await runCouncilPrompt(...)` (council mode) | ~4719 | Spawns multi-agent council child |
| `await runAutoPrompt(...)` (council-gate fallback) | ~4710 | Same as auto dispatch |

Not wrapped: `promptChoice()` (guarded by `isChoiceActive()`), command-recovery `conciergeTurn`, one-shot non-interactive paths.

### Input Routing

At the top of `rl.on('line')`, before all existing dispatch routing:

```js
if (dispatchDepth > 0 && !line.startsWith(':') && !isChoiceActive()) {
  // sidecar path — handled below, then return
}
```

- `:commands` bypass and execute normally.
- `promptChoice()` dialogs: `isChoiceActive()` returns true → sidecar skipped, input goes to the choice dialog as before.
- `conciergeActive` chat mode: dispatch never runs inside it, so `dispatchDepth` is always 0 there; no interaction.

### Sidecar Handler (three cases)

1. **`sidecaring === true`** — a sidecar call is already in flight. Print `⬢ still thinking…` inline and return. Drops the input rather than stacking.
2. **`!isConciergeAvailable()`** — no API keys configured. Print `⬢ no concierge available while council runs` and return.
3. **Normal** — set `sidecaring = true`, call `await conciergeTurn(line, { context })`, print response inline, set `sidecaring = false` in `finally`.

### Response Rendering

Reuses the worker-notification ANSI pattern exactly:

```
\r\x1b[2K          ← erase prompt line
⬢ [model]  <response text>
            ← rl.prompt(true) to redraw prompt below
```

### Entry Hint

When `dispatchDepth` transitions 0→1, print a single dim one-liner:

```
⬢ council running — you can ask concierge anything
```

No explicit teardown needed — it's a one-shot print, not a persistent UI element.

## Edge Cases

| Case | Handling |
|------|----------|
| Dispatch errors/throws | `finally` always decrements `dispatchDepth` |
| Sidecar `conciergeTurn` errors | Print error inline, `sidecaring = false` in `finally` |
| User types faster than sidecar responds | Second input sees `sidecaring === true`, prints "still thinking" |
| Worker events arrive mid-sidecar | Existing `isChoiceActive()` guards unaffected; workers print inline independently |
| No concierge keys configured | Graceful inline message, no crash |
| Council `[DISPATCH]` intent from sidecar | Intentionally ignored — sidecar is for questions, not new dispatches |

## What Is Not Changed

- Worker architecture (already non-blocking)
- Status bar, spinner, or progress rendering
- `conciergeActive` chat mode
- `promptChoice()` interactive dialogs
- One-shot (non-interactive) operator mode
