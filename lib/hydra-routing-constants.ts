/**
 * Shared routing constants for agent selection.
 *
 * Extracted here to avoid duplicating the preference order between
 * hydra-agents.ts (bestAgentFor) and hydra-dispatch.ts (getRoleAgent),
 * which cannot import each other without creating a circular dependency.
 */

/**
 * Ordered list of physical agents tried when resolving a dispatch role.
 * Earlier entries are preferred; 'local' is last and only used when enabled.
 */
export const DISPATCH_PREFERENCE_ORDER = ['claude', 'copilot', 'gemini', 'codex', 'local'] as const;
