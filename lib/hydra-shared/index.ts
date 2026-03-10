/**
 * Hydra Shared — Barrel export for shared infrastructure modules.
 */

export * from './git-ops.ts';
export * from './constants.ts';
export * from './guardrails.ts';
export { BudgetTracker } from './budget-tracker.ts';
export type { Threshold, UnitDelta, BudgetCheckResult, BudgetTrackerOpts, BudgetTrackerData } from './budget-tracker.ts';
export { executeAgent, executeAgentWithRecovery, diagnoseAgentError } from './agent-executor.ts';
export {
  createRL,
  ask,
  loadLatestReport,
  displayBranchInfo,
  handleBranchAction,
  handleEmptyBranch,
  cleanBranches,
} from './review-common.ts';
export type { HandleBranchActionOpts } from './review-common.ts';
