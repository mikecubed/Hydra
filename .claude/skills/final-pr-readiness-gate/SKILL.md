---
description: "Run a final PR-readiness pass on a stable diff using clean-code-codex plus final GPT review."
---

## Purpose

Use this skill when the feature branch or PR diff is finally stable and you want one last
high-signal readiness pass before asking for human review or concluding a review-fix cycle.

This skill is the right place for **clean-code-codex** in Hydra's workflow:

1. after implementation tracks are merged;
2. after PR review fixes are integrated;
3. after the branch is pushed and the diff is stable enough to evaluate as a whole.

Do **not** use this skill inside every implementation track or every review-comment fix loop.
It is a **final integrated gate**, not an inline coding stage.

## Default Roles

- **clean-code-codex** — structured report-only enforcement on the stable diff
- **GPT-5.4** — final whole-PR substantive review and synthesis

Keep Codex in **report-only** mode. Do **not** use `--fix` in this workflow.

## Activation Triggers

Activate when the developer asks for things like:

- "run the final PR readiness pass"
- "check whether this PR is ready for review"
- "run codex and do a final review"
- "do the final integrated review pass"
- "run a final gate before human review"

Also activate when:

- implementation tracks have already merged into the feature branch;
- the feature branch already has a PR to `main`;
- review-fix cycles are complete and the PR needs one final readiness decision.

## Preconditions

Before invoking this skill, all of the following should already be true:

- the feature branch exists and is the branch under review;
- there are no unresolved track merges still in flight;
- the intended code changes are already integrated on the feature branch;
- the branch has been pushed, or can now be pushed, so the PR diff is stable;
- repo validation has already been run recently enough that the branch is not obviously stale.

If the diff is still moving significantly, stabilize it first and run this skill afterward.

## Workflow

### 1. Establish the stable review surface

Before running any final gate:

1. confirm the active branch and its PR target;
2. make sure the intended code changes are already integrated;
3. push the branch if needed so the remote PR diff matches local reality;
4. verify the branch tip includes all remote-only commits and any commits from other batch
   branches or worktrees that still need to be merged or cherry-picked onto this branch;
5. confirm any temporary worktrees used for the batch are either already retired or intentionally
   retained for a known reason;
6. identify the final review surface:
   - preferably the feature-branch diff against `main`;
   - otherwise the current stable branch diff when no PR exists yet.

This skill should evaluate the **integrated result**, not a partial local track diff.

### 2. Decide whether Codex applies

`clean-code-codex` is for code changes, not pure docs/config work.

If the stable diff is:

- **code-bearing** (`.ts`, `.js`, `.mjs`, `.py`, `.go`, `.rs`, etc.)  
  - run Codex;
- **docs-only or config-only**  
  - skip Codex and continue with the final GPT review/synthesis only.

Do not force Codex onto diffs it explicitly does not support.

### 3. Run clean-code-codex in report-only mode

When Codex applies:

1. invoke **clean-code-codex** on the stable integrated diff;
2. prefer:
   - an explicit scope derived from the stable PR diff file list
   - report-only mode
   - no `--fix`
   - no `--write`
3. treat Codex as a structured enforcement pass, not as the primary reviewer.

For a PR-backed feature branch, prefer scoping Codex to the files changed between `main` and the
feature branch. Use `--diff-only` only when the review surface is intentionally the current local
working-tree diff rather than the full integrated PR diff.

Focus on the value Codex adds most reliably at this stage:

- security issues;
- dead code / duplicate wiring;
- size/complexity drift;
- naming regressions;
- architecture boundary problems;
- observability/test-quality issues that show up on the final integrated diff.

### 4. Triage Codex findings

Classify Codex findings into:

- **blocker**
  - must be fixed before calling the PR ready;
- **fix-now**
  - should be resolved in the current cycle if practical;
- **follow-up**
  - valid but not required to unblock the current PR;
- **not-applicable / false positive**
  - does not match current repo reality or the actual diff.

Do not blindly obey Codex findings. Ground them in the real code and PR context.

### 5. Run final GPT-5.4 review on the whole diff

After Codex triage:

1. run a final **GPT-5.4** review over the entire stable PR diff;
2. provide:
   - the PR purpose;
   - the integrated diff or changed files;
   - any blocker/fix-now Codex findings;
   - instruction to report only substantive issues.

Ask GPT-5.4 to focus on:

- correctness regressions;
- cross-track or cross-fix interaction bugs;
- test sufficiency;
- contract drift;
- security issues missed by human loops;
- whether the PR is actually ready for human review.

### 6. Produce a readiness verdict

Every run must end with one of these explicit outcomes:

- **ready for review**
  - no blocking Codex or GPT findings remain;
- **ready with follow-ups**
  - non-blocking issues remain but the PR is acceptable for review;
- **not ready**
  - blocker issues remain and should be fixed before review;
- **stopped by user**
  - the developer chose not to continue the pass yet.

### 7. Report clearly

Summarize the final state in a form the developer can act on quickly:

- blockers;
- fix-now items;
- follow-ups;
- skipped Codex reason, if Codex did not apply;
- final readiness verdict.

The output should make it obvious whether to:

- open/request PR review now;
- do one more focused fix pass;
- or stop and reassess scope.

## Core Rules

### 1. Do not use Codex as an inline replacement for the main workflow

This skill complements the existing Hydra loop. It does **not** replace:

- Opus implementation tracks;
- GPT per-track review;
- repo validation commands;
- targeted review-fix cycles.

### 2. Never use `--fix` here

This is a decision gate, not an unattended remediation step.

If Codex finds issues:

- triage them;
- decide what matters;
- feed real issues into the next fix pass.

### 3. Run once per stable diff, not per micro-change

Use this skill:

- after a meaningful integration point;
- before human review;
- after a major review-fix batch if the PR changed substantially.

Do **not** run it after every tiny commit.

## Common Failure Modes

Watch for these repeatedly:

1. **Running too early**
   - the branch is still moving, so the final pass becomes noise.

2. **Using Codex as another per-track reviewer**
   - duplicates the implementation/review loop and adds latency.

3. **Treating every Codex finding as truth**
   - some findings will be false positives or poor fits for the current diff.

4. **Skipping the whole-diff human-style review**
   - Codex catches structured rule violations, not all product or integration bugs.

5. **Declaring readiness without a verdict**
   - the developer should not have to infer whether the PR is actually ready.

## Deliverable Expectations

A successful run of this skill should leave behind:

- a stable branch/PR diff evaluation;
- Codex findings, if applicable, triaged into blocker/fix-now/follow-up/not-applicable;
- a final GPT-5.4 whole-PR review;
- a clear readiness verdict;
- a concise summary of what still needs action, if anything.

## Final Guidance

Use this skill as the last serious machine review pass before human review.

Its value is:

- Codex for structured enforcement on the integrated diff;
- GPT-5.4 for final substantive judgment;
- one clear readiness decision instead of another open-ended loop.
