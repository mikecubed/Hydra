# Tasks: Web Hardening and Packaging

**Input**: `.sdd/web-hardening-packaging-v7n2k4q9/spec.md`, `.sdd/web-hardening-packaging-v7n2k4q9/plan.md`, `.sdd/web-hardening-packaging-v7n2k4q9/research.md`

## Phase 0 — Baseline and Scope Matrix

- [x] T001 Create the Phase 5 readiness matrix in .sdd/web-hardening-packaging-v7n2k4q9/tasks.md
- [x] T002 Define the supported packaging target matrix in README.md and docs/WEB_INTERFACE.md
- [x] T003 Define explicit responsiveness and hardening budgets in docs/web-interface/05-security-and-quality.md

## Phase 1 — User Story 1: Packaged Web Operator Experience (Priority: P1)

- [x] T004 [US1] Audit the current packaged web launch path in scripts/build-pack.ts and scripts/build-exe.ts
- [x] T005 [US1] Implement packaged web asset/runtime inclusion in package.json and scripts/build-pack.ts
- [x] T006 [P] [US1] Align post-pack cleanup for packaged web artifacts in scripts/clean-pack.ts
- [x] T007 [US1] Harden packaged static asset resolution and unsupported-state messaging in apps/web-gateway/src/server-runtime.ts
- [x] T008 [US1] Wire packaged launch behavior and startup logging in apps/web-gateway/src/server.ts
- [x] T009 [P] [US1] Update supported local and remote launch guidance in apps/web/README.md and apps/web-gateway/README.md
- [x] T010 [US1] Update top-level packaged launch guidance in README.md

## Phase 2 — User Story 2: Safe Recovery During Failures (Priority: P1)

- [x] T011 [US2] Define the failure-drill matrix in docs/web-interface/05-security-and-quality.md
- [ ] T012 [US2] Tighten session and daemon recovery messaging in apps/web/src/features/auth/ and apps/web/src/features/chat-workspace/components/
- [x] T013 [US2] Harden rejected-mutation and degraded-state handling in apps/web/src/features/mutations/ and apps/web/src/features/operations-panels/
- [ ] T014 [US2] Tighten gateway error classification and runtime failure translation in apps/web-gateway/src/shared/gateway-error-response.ts and apps/web-gateway/src/transport/
- [ ] T015 [P] [US2] Add gateway failure-drill coverage in apps/web-gateway/src/\*_/**tests**/_.test.ts
- [ ] T016 [P] [US2] Add browser recovery-flow coverage in apps/web/src/features/\*_/_.browser.spec.tsx

## Phase 3 — User Story 3: Accessible Core Workflows (Priority: P2)

- [ ] T017 [US3] Audit focus order, labels, and error semantics in apps/web/src/features/auth/, apps/web/src/features/chat-workspace/, apps/web/src/features/operations-panels/, and apps/web/src/features/mutations/
- [ ] T018 [US3] Implement keyboard and focus-management fixes across affected apps/web/src/features/\*_/_.tsx surfaces
- [ ] T019 [P] [US3] Add accessibility-focused browser specs for login, workspace, operations panels, and mutation dialogs in apps/web/src/features/\*_/_.browser.spec.tsx
- [ ] T020 [US3] Document accessibility expectations and supported viewport range in docs/web-interface/05-security-and-quality.md and apps/web/README.md

## Phase 4 — User Story 4: Responsive and Efficient Operations View (Priority: P2)

- [ ] T021 [US4] Define responsiveness budgets and evidence collection points in docs/web-interface/05-security-and-quality.md and .github/workflows/quality.yml
- [ ] T022 [US4] Audit render, refresh, and reconnect hotspots in apps/web/src/features/chat-workspace/model/ and apps/web/src/features/operations-panels/model/
- [ ] T023 [US4] Implement targeted responsiveness fixes in apps/web/src/features/chat-workspace/, apps/web/src/features/operations-panels/, and apps/web/src/features/mutations/
- [ ] T024 [P] [US4] Add regression coverage for narrow viewport and refresh-cycle responsiveness in apps/web/src/features/\*_/_.browser.spec.tsx
- [ ] T025 [P] [US4] Add packaging/build evidence checks in package.json and .github/workflows/ci.yml

## Phase 5 — User Story 5: Contributor Release Readiness (Priority: P3)

- [ ] T026 [US5] Write contributor verification and troubleshooting guidance in CONTRIBUTING.md
- [ ] T027 [US5] Update web-interface status and completion guidance in docs/WEB_INTERFACE.md and docs/web-interface/06-phases-and-sdd.md
- [ ] T028 [US5] Align workspace READMEs with the final verification checklist in apps/web/README.md and apps/web-gateway/README.md
- [ ] T029 [US5] Add or refine release-readiness workflow checks in .github/workflows/ci.yml and .github/workflows/quality.yml
- [ ] T030 [US5] Run and document the final release-readiness command set in README.md and CONTRIBUTING.md

## Phase 5 Readiness Matrix

| Area                  | Scope                                                           | Supported / Target                                                                                                                                                                                                                | Primary evidence                                                                                                                             | Gaps to close                                                                                                      | Tasks           |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------- |
| Packaging             | Supported launch paths for local + explicit remote operator use | Same-origin gateway serving `apps/web/dist` from source checkout today; packaged tarball should document a supported web-capable path; standalone executable must fail explicitly when bundled web assets/runtime are unavailable | `scripts/build-pack.ts`, `scripts/build-exe.ts`, `apps/web-gateway/src/server.ts`, `apps/web-gateway/src/server-runtime.ts`, README guidance | Package the web runtime intentionally, document the target matrix, and surface explicit unsupported-state guidance | T002, T004-T010 |
| Hardening             | Security posture + failure drills                               | Same-origin auth/session/CSRF/origin protections remain mandatory; key drills are session expiry, daemon unavailable, rejected mutation, reconnect disruption, and packaged runtime misconfiguration                              | `docs/web-interface/05-security-and-quality.md`, gateway/browser failure handling, browser + gateway tests                                   | Define drill matrix, tighten failure classification/recovery messaging, and add drill coverage                     | T003, T011-T016 |
| Accessibility         | Keyboard, focus, labels, error semantics                        | Login, workspace shell, operations panels, and mutation dialogs must remain keyboard-operable and assistive-technology-friendly across supported states                                                                           | Browser specs, workspace feature surfaces, quality docs                                                                                      | Audit focus/semantics, land keyboard/focus fixes, and add browser accessibility coverage + docs                    | T017-T020       |
| Responsiveness        | Interactive budgets for primary web surfaces                    | Primary login/workspace/operations flows should stay usable under narrow viewports, refresh cycles, reconnects, and live updates with documented budgets and repeatable evidence                                                  | `docs/web-interface/05-security-and-quality.md`, browser specs, CI evidence hooks                                                            | Define budgets/evidence points, fix hotspots, and add regression/build evidence checks                             | T021-T025       |
| Contributor readiness | Contributor docs, CI, and release checklist                     | Contributors should be able to run, verify, package, and troubleshoot the web interface from published docs without source-diving                                                                                                 | `README.md`, `CONTRIBUTING.md`, `docs/WEB_INTERFACE.md`, `docs/web-interface/06-phases-and-sdd.md`, CI workflows                             | Align docs, tighten release-readiness workflow checks, and publish the final verification command set              | T026-T030       |

## Dependency Graph

- T001 → T002, T003, T004, T011, T017, T021, T026
- T004 → T005, T006, T007, T008, T009, T010
- T005 + T007 + T008 → T025
- T011 → T012, T013, T014, T015, T016
- T017 → T018, T019, T020
- T021 + T022 → T023, T024, T025
- T026 + T027 + T028 + T029 → T030
- T010 + T016 + T020 + T025 + T030 complete the feature

## Parallel Execution Examples

- After T004, one engineer can take T005/T006 while another takes T007/T008 and another updates T009/T010.
- After T011, gateway drill coverage (T015) and browser recovery coverage (T016) can proceed in parallel with T012/T013/T014.
- After T017, accessibility fixes (T018) and browser a11y specs (T019) can run in parallel once the target surfaces are assigned.
- After T021/T022, responsiveness fixes (T023), viewport regressions (T024), and packaging/build evidence checks (T025) can run in parallel.
- Contributor docs (T026/T027/T028) and workflow tightening (T029) can proceed in parallel before the final verification pass in T030.

## Suggested MVP Scope

For the fastest meaningful first slice, deliver **User Story 1** first:

- T004–T010

This establishes the supported packaged launch story and removes the biggest ambiguity in the
pending Phase 5 roadmap.
