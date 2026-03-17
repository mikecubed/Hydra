---
description: "Resolve PR review comments with subagents, selective fixes, thread closure, and final validation."
---

## Purpose

Use this skill when a developer wants to work through pull request review comments in a disciplined,
multi-model loop.

This skill is for **review resolution**, not first-pass implementation. It assumes there is already
an open branch or PR and a set of review comments/threads to evaluate.

The workflow is:

1. collect review comments and threads;
2. decide which comments are legitimate and should be fixed;
3. implement accepted fixes with **Opus 4.6 subagents**;
4. review each fix with **GPT-5.4 subagents**;
5. reply to comments that will not be fixed, with clear reasoning;
6. resolve threads that are fixed or intentionally declined;
7. perform a final PR-wide regression review and quality validation;
8. push the branch updates;
9. report remaining issues so the developer can decide whether to continue or stop.

## Activation Triggers

Activate when the user asks for things like:

- "work through the PR review comments"
- "evaluate which comments we should actually fix"
- "use subagents to address PR feedback"
- "close the review threads after fixing"
- "reply to comments we are declining and resolve them"
- "do another full review after the review fixes"

## Model Roles

Default roles:

- **Opus 4.6 subagents** — implement fixes
- **GPT-5.4 subagents** — review each fix and do final regression review

Keep implementer and reviewer as different models.

## Core Rules

### 1. Do not assume every review comment is correct

Every comment must be triaged into one of these buckets:

- **fix**
  - the comment identifies a real issue and should be addressed;
- **decline**
  - the comment is outdated, incorrect, already addressed, outside scope, or intentionally deferred;
- **clarify first**
  - the comment is ambiguous enough that you cannot safely act on it yet.

Never churn the code just to satisfy a weak or incorrect comment.

### 2. Every accepted fix still follows TDD and design quality rules

For comments that become fixes:

1. add or adjust failing tests first when the issue is behavioral;
2. implement the fix;
3. keep tests green while refactoring.

Every fix must preserve:

- **TDD**
- **SOLID**
- **DRY**
- type safety
- repo lint/format/quality expectations

### 3. Close the loop on every thread

Do not stop with code changes only.

Every review thread must end in one of these states:

- fixed and resolved;
- declined with a clear rationale and resolved/closed if appropriate;
- explicitly left open only if genuinely blocked.

## Workflow

### 1. Gather review context

Before making changes:

1. collect:
   - open review threads;
   - general PR comments if relevant;
   - changed files;
   - latest branch diff;
   - CI/check status.
2. read the reviewed code paths and nearby tests before deciding anything.

Do not resolve comments from the comment text alone if the code has moved.

### 2. Triage comments

For each review item, classify:

- **real bug / correctness issue**
- **security issue**
- **missing test / weak test**
- **contract or API mismatch**
- **architecture / boundary concern**
- **style-only / non-actionable**
- **stale / already fixed**
- **out-of-scope but valid follow-up**

Then decide:

- fix now;
- decline with rationale;
- defer explicitly;
- ask for clarification if truly blocked.

If a comment is **clarify first**:

- reply with the specific clarification needed;
- leave the thread open;
- mark it as blocked pending reviewer or author response;
- do **not** force it into fix-or-decline until the missing information arrives.
- when clarification arrives, re-triage the comment and continue with fix or decline.

### 3. Batch independent fixes

When multiple comments are legitimate:

1. group independent comments into tracks when safe;
2. avoid parallelizing comments that touch the same files or public APIs;
3. use `parallel-implementation-loop` principles if several tracks are truly independent,
   including:
   - isolated worktrees;
   - per-track branches;
   - PRs back into the active feature branch instead of `main`.
4. when parallel tracks are used, the primary agent running this skill acts as the coordinator by
   default unless the developer explicitly assigns someone else.

If comments interact tightly, resolve serially instead.

When this skill uses parallel fix tracks, inherit the worktree lifecycle rules from
`parallel-implementation-loop`:

- track worktrees are temporary;
- the active PR branch is the integration branch;
- only batch-owned worktrees should be removed;
- dirty worktrees require explicit reconciliation or developer approval before force removal.

### 4. Implement each accepted fix with Opus 4.6 subagents

For every fix track:

1. launch an **Opus 4.6 subagent** and provide:
   - exact review comment(s);
   - intended resolution;
   - relevant files;
   - required tests;
   - repo quality constraints.
2. require:
   - failing test first where appropriate;
   - minimal, scoped fix;
   - no unrelated cleanup unless directly necessary.

### 5. Review each fix with GPT-5.4 subagents

After Opus implements a fix:

1. launch a **GPT-5.4 review subagent** on the resulting diff;
2. ask for only substantive issues:
   - correctness regressions;
   - missing edge-case tests;
   - contract drift;
   - security concerns;
   - SOLID/DRY regressions that materially matter.
3. if real issues remain, send them back for one more fix cycle.

Stop when the fix is sound, not when it is cosmetically perfect.

### 6. Resolve comment threads

After each fix or decline:

#### If fixed

- reply briefly with what changed;
- point to the relevant file/test if helpful;
- resolve/close the thread.

#### If declined

- reply with the concrete reason:
  - already fixed elsewhere;
  - comment is stale after rebases/other commits;
  - concern is valid but out of scope for this PR;
  - requested change would be incorrect or would regress current behavior;
  - deferred intentionally, with reason.
- then resolve/close the thread if appropriate.

Do not leave silent declines.

### 7. Final validation and readiness gate

After all comment threads are handled:

1. run the repo’s actual quality gates on the integrated branch;
2. ensure linting, formatting, type-checking, and tests pass;
3. push or prepare the branch so the integrated PR diff is stable;
4. invoke `final-pr-readiness-gate` on the stable PR diff;
5. use its Codex findings and final GPT review to decide whether one more targeted fix pass is
   needed.

Before calling the PR diff stable:

1. fetch and verify the active branch tip is not behind the remote branch tip or missing commits
   from other batch branches or worktrees that should have been merged;
2. reconcile any missing remote-only fix commits before the final gate;
3. verify any review-fix worktrees used during this loop are either:
   - already merged and clean, or
   - explicitly retained for a known reason.

### 8. Final push and report

Before concluding:

1. if the readiness gate or any final fix changed the branch again, rerun the repo quality gates;
2. verify any newly introduced behavior has appropriate tests;
3. push the updated working branch;
4. verify the PR reflects the latest comment-resolution work;
5. make sure thread replies and resolutions are not stranded locally in an unpushed state;
6. summarize remaining concerns, if any, so the developer can decide whether to continue or stop.

If the loop created temporary worktrees, conclude by:

1. removing clean merged or abandoned review-fix worktrees;
2. refusing to silently force-remove dirty worktrees unless the developer explicitly asks;
3. reporting any retained worktrees and why they still exist.

## Required Gates

### Comment gate

A comment is not complete until:

- it was classified explicitly;
- a fix, decline, or clarify-first decision was made;
- if fixed, tests and implementation are complete;
- if declined, a rationale is written;
- if clarify-first, the needed clarification was posted and the thread is intentionally left open;
- the thread is resolved or intentionally left open with a stated blocker.

### Fix gate

A fix is not complete until:

- failing tests were added/updated first when applicable;
- the issue is actually resolved;
- GPT-5.4 review finds no unresolved substantive issue;
- changed files remain scoped to the comment’s real concern;
- lint/format/type/test state for touched code is clean.

### PR gate

The PR resolution batch is not complete until:

- all relevant comments are handled;
- `final-pr-readiness-gate` has been run on the stable PR diff;
- repo quality gates pass;
- branch has been pushed;
- temporary review-fix worktrees have been cleaned up, or any retained ones are explicitly called
  out;
- any remaining issues are explicitly reported.

## Quality Gates

At minimum, enforce the repo’s real validation commands.

For Hydra, prefer:

- targeted tests while individual fixes are in progress;
- then full repo validation such as:
  - `npm run format:check`
  - `npm run quality`
  - `npm test`

If a comment changes public behavior, tests are required unless the repo already covers that exact
path.

## Decline Guidance

Good decline reasons:

- the concern is already addressed in current code;
- the comment refers to pre-rebase code that no longer exists;
- the requested change would violate current contracts or architecture;
- the requested change belongs in a follow-up slice, not this PR;
- the reviewer is asking for a behavior that would regress tests or security.

Bad decline reasons:

- "too much work"
- "I disagree"
- "looks fine to me"

Declines must be grounded in code, tests, contracts, or scope.

## Common Failure Modes

Watch for these repeatedly:

1. **Comment cargo-culting**
   - applying reviewer suggestions without checking current code reality.

2. **Fixing stale comments**
   - code changed since the review; the comment no longer applies.

3. **Local fix, global regression**
   - a comment fix breaks another part of the PR.

4. **Unowned thread closure**
   - code changed but no response/resolution was posted.

5. **No-test fixes**
   - behavioral fixes land without corresponding coverage.

6. **Review loops about style**
   - spend cycles only on comments that materially affect correctness, safety, maintainability, or
     testability.

## Prompt Guidance

When prompting an **Opus 4.6 subagent** for a fix, include:

- the exact review comment text or a precise summary;
- why the comment is considered legitimate;
- target files;
- expected tests;
- constraints to avoid unrelated edits.

When prompting a **GPT-5.4 subagent** to review a fix, include:

- the comment being addressed;
- intended resolution;
- diff or changed files;
- instruction to report only substantive issues.

When doing the final PR review, ask:

- "Did resolving these comments introduce any new bugs?"
- "Are there any threads that appear resolved in code but not in rationale?"
- "Are tests sufficient for the changed behavior?"

## Deliverable Expectations

A successful run of this skill should leave behind:

- accepted comments fixed;
- declined comments answered with clear rationale;
- fixed/declined threads resolved where appropriate;
- a clean final PR review;
- repo quality gates passing;
- updated branch state pushed to the PR;
- a short summary of:
   - comments fixed;
   - comments declined and why;
   - tests added;
   - final validation results;
   - remaining issues, if any.

## Final Guidance

The goal is not to appease every review comment.

The goal is to:

- improve the PR where the feedback is right;
- defend correct code where the feedback is wrong;
- leave every thread in a clear, finished state;
- and ensure the final PR is better than it was before the review cycle.
