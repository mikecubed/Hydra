/**
 * Artifact renderer unit tests — pure function coverage.
 *
 * Tests the utility/mapping layer of artifact-renderers.tsx without requiring
 * a DOM environment. React component rendering tests live in the companion
 * browser spec (artifact-renderers.browser.spec.tsx).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARTIFACT_KIND_LABELS,
  artifactKindToLabel,
  classifyArtifactKind,
  isCodeLikeArtifact,
  contentBlockStyle,
} from '../render/artifact-render-utils.ts';

// ─── ARTIFACT_KIND_LABELS constant ──────────────────────────────────────────

describe('ARTIFACT_KIND_LABELS', () => {
  it('maps all seven contract-defined artifact kinds', () => {
    const expected = ['file', 'diff', 'patch', 'test-result', 'log', 'plan', 'structured-data'];
    for (const kind of expected) {
      assert.ok(kind in ARTIFACT_KIND_LABELS, `missing label for kind "${kind}"`);
    }
  });

  it('labels are non-empty strings', () => {
    for (const [kind, label] of Object.entries(ARTIFACT_KIND_LABELS)) {
      assert.ok(typeof label === 'string' && label.length > 0, `empty label for "${kind}"`);
    }
  });
});

// ─── artifactKindToLabel ────────────────────────────────────────────────────

describe('artifactKindToLabel', () => {
  it('returns "File" for file kind', () => {
    assert.equal(artifactKindToLabel('file'), 'File');
  });

  it('returns "Diff" for diff kind', () => {
    assert.equal(artifactKindToLabel('diff'), 'Diff');
  });

  it('returns "Patch" for patch kind', () => {
    assert.equal(artifactKindToLabel('patch'), 'Patch');
  });

  it('returns "Test Result" for test-result kind', () => {
    assert.equal(artifactKindToLabel('test-result'), 'Test Result');
  });

  it('returns "Log" for log kind', () => {
    assert.equal(artifactKindToLabel('log'), 'Log');
  });

  it('returns "Plan" for plan kind', () => {
    assert.equal(artifactKindToLabel('plan'), 'Plan');
  });

  it('returns "Structured Data" for structured-data kind', () => {
    assert.equal(artifactKindToLabel('structured-data'), 'Structured Data');
  });

  it('returns title-cased fallback for unknown kind', () => {
    assert.equal(artifactKindToLabel('unknown-widget'), 'Unknown Widget');
  });

  it('handles single-word unknown kind', () => {
    assert.equal(artifactKindToLabel('chart'), 'Chart');
  });

  it('handles empty string gracefully', () => {
    const label = artifactKindToLabel('');
    assert.equal(typeof label, 'string');
  });

  it('falls back for __proto__ key (prototype chain safety)', () => {
    const label = artifactKindToLabel('__proto__');
    // __proto__ is NOT an own property of ARTIFACT_KIND_LABELS, so title-case fallback runs
    assert.equal(label, '__proto__');
  });

  it('falls back for constructor key (prototype chain safety)', () => {
    const label = artifactKindToLabel('constructor');
    assert.equal(label, 'Constructor');
  });

  it('falls back for toString key (prototype chain safety)', () => {
    const label = artifactKindToLabel('toString');
    assert.equal(label, 'ToString');
  });
});

// ─── classifyArtifactKind ───────────────────────────────────────────────────

describe('classifyArtifactKind', () => {
  it('classifies file as code', () => {
    assert.equal(classifyArtifactKind('file'), 'code');
  });

  it('classifies diff as code', () => {
    assert.equal(classifyArtifactKind('diff'), 'code');
  });

  it('classifies patch as code', () => {
    assert.equal(classifyArtifactKind('patch'), 'code');
  });

  it('classifies log as code', () => {
    assert.equal(classifyArtifactKind('log'), 'code');
  });

  it('classifies test-result as data', () => {
    assert.equal(classifyArtifactKind('test-result'), 'data');
  });

  it('classifies structured-data as data', () => {
    assert.equal(classifyArtifactKind('structured-data'), 'data');
  });

  it('classifies plan as prose', () => {
    assert.equal(classifyArtifactKind('plan'), 'prose');
  });

  it('falls back to prose for unknown kinds', () => {
    assert.equal(classifyArtifactKind('mystery'), 'prose');
  });

  it('falls back to prose for __proto__ (prototype chain safety)', () => {
    assert.equal(classifyArtifactKind('__proto__'), 'prose');
  });

  it('falls back to prose for constructor (prototype chain safety)', () => {
    assert.equal(classifyArtifactKind('constructor'), 'prose');
  });

  it('falls back to prose for toString (prototype chain safety)', () => {
    assert.equal(classifyArtifactKind('toString'), 'prose');
  });
});

// ─── isCodeLikeArtifact ─────────────────────────────────────────────────────

describe('isCodeLikeArtifact', () => {
  it('returns true for file', () => {
    assert.equal(isCodeLikeArtifact('file'), true);
  });

  it('returns true for diff', () => {
    assert.equal(isCodeLikeArtifact('diff'), true);
  });

  it('returns true for patch', () => {
    assert.equal(isCodeLikeArtifact('patch'), true);
  });

  it('returns true for log', () => {
    assert.equal(isCodeLikeArtifact('log'), true);
  });

  it('returns false for plan', () => {
    assert.equal(isCodeLikeArtifact('plan'), false);
  });

  it('returns false for test-result', () => {
    assert.equal(isCodeLikeArtifact('test-result'), false);
  });

  it('returns false for structured-data', () => {
    assert.equal(isCodeLikeArtifact('structured-data'), false);
  });

  it('returns false for unknown kinds', () => {
    assert.equal(isCodeLikeArtifact('anything-else'), false);
  });
});

// ─── contentBlockStyle ──────────────────────────────────────────────────────

describe('contentBlockStyle', () => {
  it('returns monospace style for code blocks', () => {
    const style = contentBlockStyle('code');
    assert.equal(style.fontFamily, 'monospace');
  });

  it('returns prose style for text blocks', () => {
    const style = contentBlockStyle('text');
    assert.ok(style.whiteSpace === 'pre-wrap');
  });

  it('returns muted style for status blocks', () => {
    const style = contentBlockStyle('status');
    assert.ok(typeof style.fontStyle === 'string');
  });

  it('returns monospace style for structured blocks', () => {
    const style = contentBlockStyle('structured');
    assert.equal(style.fontFamily, 'monospace');
  });

  it('returns prose style for unknown block kind', () => {
    const style = contentBlockStyle('unknown' as 'text');
    assert.ok(style.whiteSpace === 'pre-wrap');
  });
});
