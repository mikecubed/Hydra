/**
 * Regression tests for the dynamic context injection in hydra-evolve-executor.ts.
 *
 * Previously, getProjectContext() in hydra-evolve-executor returned a static
 * hardcoded 27-line string. After the refactor it delegates to buildAgentContext()
 * from lib/hydra-context.ts, keeping context accurate as the codebase evolves.
 *
 * These tests verify that:
 *  1. buildAgentContext() produces a non-empty string with real project info.
 *  2. The output references actual modules that exist in the codebase.
 *  3. Calling it with the same args used by hydra-evolve-executor doesn't throw.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAgentContext } from '../lib/hydra-context.ts';

describe('buildAgentContext (used by hydra-evolve-executor)', () => {
  it('returns a non-empty string when called with executor args', () => {
    const ctx = buildAgentContext('claude', {}, null, null);
    assert.ok(typeof ctx === 'string', 'should return a string');
    assert.ok(ctx.length > 0, 'should return a non-empty string');
  });

  it('returns meaningful context (length > 200 chars)', () => {
    const ctx = buildAgentContext('claude', {}, null, null);
    assert.ok(
      ctx.length > 200,
      `expected context length > 200, got ${String(ctx.length)} chars:\n${ctx}`,
    );
  });

  it('contains at least one real module reference', () => {
    const ctx = buildAgentContext('claude', {}, null, null);
    const hasModuleRef = ctx.includes('hydra-operator') || ctx.includes('lib/');
    assert.ok(
      hasModuleRef,
      `expected context to reference a module (hydra-operator or lib/), got:\n${ctx.slice(0, 400)}`,
    );
  });

  it('contains dynamic project metadata (name, tech, branch)', () => {
    const ctx = buildAgentContext('claude', {}, null, null);
    // buildAgentContext produces metadata-driven output including project name and tech stack.
    assert.ok(
      ctx.includes('Project:') || ctx.includes('Tech:') || ctx.includes('Branch:'),
      `expected context to contain project metadata, got:\n${ctx.slice(0, 400)}`,
    );
  });

  it('does not return the old verbatim hardcoded string', () => {
    // The old static stub started with exactly this header line.
    const oldHeader = '## Hydra Project Context\nKey modules:';
    const ctx = buildAgentContext('claude', {}, null, null);
    // Dynamic output may contain similar headings but not this exact stale prefix.
    // If it does match, that is a sign we accidentally re-introduced the static string.
    assert.ok(
      !ctx.startsWith(oldHeader),
      'context should not start with the legacy hardcoded header',
    );
  });

  it('is stable across two calls (idempotent)', () => {
    const first = buildAgentContext('claude', {}, null, null);
    const second = buildAgentContext('claude', {}, null, null);
    assert.strictEqual(first, second, 'context should be idempotent for same inputs');
  });
});
