# Concierge Sidecar During Dispatch/Council Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-route free-form user input to concierge while a blocking dispatch or council `await` is in flight, so users can ask questions without waiting for agents to finish.

**Architecture:** Two new local variables inside `interactiveLoop()` — `dispatchDepth` (counter, >0 when blocking) and `sidecaring` (bool, prevents stacking concurrent sidecar calls). Three long-running `await` sites are wrapped with `dispatchDepth++/finally--`. At the top of the `rl.on('line')` dispatch section, a new guard checks `dispatchDepth > 0` and routes non-command input to an inline `conciergeTurn()` call, rendering the response with the same `\r\x1b[2K` ANSI pattern already used by worker notifications.

**Tech Stack:** Node.js ESM, readline, picocolors (`pc`), existing `conciergeTurn()` / `isConciergeAvailable()` from `hydra-concierge.mjs`.

---

### Task 1: Add state variables and sidecar handler block

**Files:**
- Modify: `lib/hydra-operator.mjs`

These are the only two state variables needed. Add them directly after the existing `let conciergeActive` declaration (line ~1651), then insert the sidecar routing block right before the `let dispatchLine = line;` line (around line 4299 — the boundary between `:command` handlers and the concierge/dispatch section).

**Step 1: Add state variables after `let conciergeActive = false;`**

Find this exact block (lines ~1650-1651):
```js
  let mode = initialMode;
  let conciergeActive = false;
```

Add two lines immediately after:
```js
  let mode = initialMode;
  let conciergeActive = false;
  let dispatchDepth = 0;   // >0 while a blocking dispatch/council await is in flight
  let sidecaring = false;  // true while a sidecar conciergeTurn is in flight
```

**Step 2: Insert the sidecar routing block**

Find this exact comment line (around line 4299):
```js
      // ── Force-dispatch escape hatch (bypass concierge with ! prefix) ────
      let dispatchLine = line;
```

Insert a new block IMMEDIATELY BEFORE it:
```js
      // ── Sidecar: auto-route to concierge while dispatch/council is running ──
      if (dispatchDepth > 0 && !line.startsWith(':') && !isChoiceActive()) {
        if (sidecaring) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} still thinking\u2026`)}\n`);
          rl.prompt(true);
          return;
        }
        if (!isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} no concierge available while agents run`)}\n`);
          rl.prompt(true);
          return;
        }
        const sidecarModel = getConciergeModelLabel();
        const sidecarContext = {
          projectName: config.projectName,
          projectRoot: config.projectRoot,
          mode,
          sidecarNote: 'User is asking this while a dispatch/council is running in the background. Be brief. Ignore any [DISPATCH] intent.',
        };
        try {
          const activeWorkerNames = [];
          for (const [name, w] of workers) {
            if (w.status === 'running') activeWorkerNames.push(name);
          }
          if (activeWorkerNames.length > 0) sidecarContext.activeWorkers = activeWorkerNames;
        } catch { /* non-critical */ }
        try { sidecarContext.codebaseBaseline = getBaselineContext(); } catch { /* non-critical */ }
        sidecaring = true;
        try {
          const sidecarResult = await conciergeTurn(line, { context: sidecarContext });
          const sidecarText = sidecarResult.response || '';
          if (sidecarText) {
            process.stdout.write(`\r\x1b[2K  ${pc.blue('\u2B22')} ${DIM(sidecarModel)}\n  `);
            process.stdout.write(pc.blue(sidecarText));
            process.stdout.write('\n');
          }
        } catch (sidecarErr) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} concierge error: ${sidecarErr.message.slice(0, 60)}`)}\n`);
        } finally {
          sidecaring = false;
          rl.prompt(true);
        }
        return;
      }

      // ── Force-dispatch escape hatch (bypass concierge with ! prefix) ────
      let dispatchLine = line;
```

**Step 3: Verify the file parses (no syntax errors)**

```bash
node --input-type=module --eval "import './lib/hydra-operator.mjs'" 2>&1 | head -5
```

Expected: no output (silent success) or only non-error warnings.

**Step 4: Commit**

```bash
git add lib/hydra-operator.mjs
git commit -m "feat(operator): add sidecar state vars and routing block for concurrent concierge"
```

---

### Task 2: Wrap auto/smart dispatch await (Site 1)

**Files:**
- Modify: `lib/hydra-operator.mjs:4547-4568`

This wraps the `await dispatchFn(...)` call for auto and smart modes.

**Step 1: Find the existing inner try/catch around `dispatchFn`**

Locate this block (lines ~4547-4568):
```js
        let auto;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
```

**Step 2: Add `dispatchDepth` increment and hint before the inner try, add `finally` to the existing catch**

Replace:
```js
        let auto;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
            baseUrl,
            from,
            agents,
            promptText: dispatchLine,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview || dryRunMode,
            onProgress,
          });
          const succeedMsg = auto.mode === 'fast-path' ? `Fast-path dispatched to ${classification.suggestedAgent}`
            : auto.mode === 'tandem' ? `Tandem dispatched: ${auto.route}`
            : `${auto.mode} complete`;
          spinner.succeed(succeedMsg);
        } catch (e) {
          spinner.fail(e.message);
          clearDispatchContext();
          throw e;
        }
```

With:
```js
        let auto;
        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`);
          rl.prompt(true);
        }
        dispatchDepth++;
        try {
          const dispatchFn = mode === 'smart' ? runSmartPrompt : runAutoPrompt;
          auto = await dispatchFn({
            baseUrl,
            from,
            agents,
            promptText: dispatchLine,
            miniRounds: autoMiniRounds,
            councilRounds: autoCouncilRounds,
            preview: autoPreview || dryRunMode,
            onProgress,
          });
          const succeedMsg = auto.mode === 'fast-path' ? `Fast-path dispatched to ${classification.suggestedAgent}`
            : auto.mode === 'tandem' ? `Tandem dispatched: ${auto.route}`
            : `${auto.mode} complete`;
          spinner.succeed(succeedMsg);
        } catch (e) {
          spinner.fail(e.message);
          clearDispatchContext();
          throw e;
        } finally {
          dispatchDepth--;
        }
```

**Step 3: Verify parse**

```bash
node --input-type=module --eval "import './lib/hydra-operator.mjs'" 2>&1 | head -5
```

Expected: silent.

**Step 4: Commit**

```bash
git add lib/hydra-operator.mjs
git commit -m "feat(operator): wrap auto/smart dispatchFn await with dispatchDepth counter"
```

---

### Task 3: Wrap council-gate fallback await (Site 2) and council await (Site 3)

**Files:**
- Modify: `lib/hydra-operator.mjs` (around lines 4680-4732)

This covers the two awaits in the `mode === 'council'` branch: the gate fallback and the full council. They are mutually exclusive paths (gate picks one or the other).

**Step 1: Find the council-gate fallback `await runAutoPrompt` (Site 2)**

Locate (around line 4685-4707):
```js
            const autoResult = await runAutoPrompt({
              baseUrl,
              from,
              agents,
              promptText: dispatchLine,
              councilRounds: autoCouncilRounds,
              preview: false,
            });
```

**Step 2: Wrap Site 2**

Replace:
```js
            const autoResult = await runAutoPrompt({
              baseUrl,
              from,
              agents,
              promptText: dispatchLine,
              councilRounds: autoCouncilRounds,
              preview: false,
            });
```

With:
```js
            if (dispatchDepth === 0 && isConciergeAvailable()) {
              process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} agents running \u2014 you can ask concierge anything`)}\n`);
              rl.prompt(true);
            }
            dispatchDepth++;
            let autoResult;
            try {
              autoResult = await runAutoPrompt({
                baseUrl,
                from,
                agents,
                promptText: dispatchLine,
                councilRounds: autoCouncilRounds,
                preview: false,
              });
            } finally {
              dispatchDepth--;
            }
```

**Step 3: Find the full council `await runCouncilPrompt` (Site 3)**

Locate (around line 4719):
```js
        const council = await runCouncilPrompt({
          baseUrl,
          promptText: dispatchLine,
          rounds: councilRounds,
          preview: councilPreview,
          onProgress: (evt) => {
```

**Step 4: Wrap Site 3**

Replace:
```js
        const council = await runCouncilPrompt({
          baseUrl,
          promptText: dispatchLine,
          rounds: councilRounds,
          preview: councilPreview,
          onProgress: (evt) => {
            if (evt.action === 'start') {
              const narrative = phaseNarrative(evt.phase, evt.agent, councilTopic);
              councilSpinner.update(`Council: ${narrative} [${evt.step}/${evt.totalSteps}]`);
              setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
              drawStatusBar();
            }
          },
        });
```

With:
```js
        if (dispatchDepth === 0 && isConciergeAvailable()) {
          process.stdout.write(`\r\x1b[2K  ${DIM(`${pc.blue('\u2B22')} council running \u2014 you can ask concierge anything`)}\n`);
          rl.prompt(true);
        }
        dispatchDepth++;
        let council;
        try {
          council = await runCouncilPrompt({
            baseUrl,
            promptText: dispatchLine,
            rounds: councilRounds,
            preview: councilPreview,
            onProgress: (evt) => {
              if (evt.action === 'start') {
                const narrative = phaseNarrative(evt.phase, evt.agent, councilTopic);
                councilSpinner.update(`Council: ${narrative} [${evt.step}/${evt.totalSteps}]`);
                setAgentActivity(evt.agent, 'working', narrative, { phase: evt.phase, step: `${evt.step}/${evt.totalSteps}` });
                drawStatusBar();
              }
            },
          });
        } finally {
          dispatchDepth--;
        }
```

**Step 5: Verify parse**

```bash
node --input-type=module --eval "import './lib/hydra-operator.mjs'" 2>&1 | head -5
```

Expected: silent.

**Step 6: Commit**

```bash
git add lib/hydra-operator.mjs
git commit -m "feat(operator): wrap council-gate fallback and runCouncilPrompt awaits with dispatchDepth"
```

---

### Task 4: Smoke test and push

**Step 1: Run the focused council tests to verify no regressions**

```bash
node test/hydra-council.test.mjs
```

Expected: `# pass 14`, `# fail 0`.

**Step 2: Syntax check the operator**

```bash
node --input-type=module --eval "import './lib/hydra-operator.mjs'" 2>&1
```

Expected: silent or only known non-error output.

**Step 3: Manual smoke test — sidecar routing during preview dispatch**

```bash
npm run go -- mode=auto
```

In the REPL, submit a prompt that triggers dispatch (e.g. `implement a cache eviction algorithm`). While the spinner is running, type a question like `what is the current project?`. Verify:
- The concierge response prints inline with `⬢ [model]` prefix.
- The spinner continues uninterrupted.
- After dispatch completes, the REPL returns to normal.

**Step 4: Manual smoke test — command passthrough during dispatch**

While the spinner is running, type `:status`. Verify it does NOT route to sidecar (it executes as a normal command, printing the status table).

**Step 5: Manual smoke test — no concierge available fallback**

If no API keys are set, while dispatch runs, type a question. Verify the fallback message `⬢ no concierge available while agents run` prints and the prompt redraws.

**Step 6: Push to dev**

```bash
git push origin dev
```
