import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractPathsFromPrompt,
  findScopedContextFiles,
  compileHierarchicalContext,
  buildAgentContext,
} from '../lib/hydra-context.ts';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helper: create a unique temp directory tree ───────────────────────────────

function makeTmpTree(structure) {
  const root = join(
    tmpdir(),
    `hydra-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(root, { recursive: true });

  for (const [relPath, content] of Object.entries(structure)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  return root;
}

function cleanTmp(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ── extractPathsFromPrompt ─────────────────────────────────────────────────────

describe('extractPathsFromPrompt', () => {
  it('finds a relative path with separators in a sentence', () => {
    const result = extractPathsFromPrompt(
      'Please update the types in src/foo/bar.ts to add a new field.',
    );
    assert.ok(
      result.includes('src/foo/bar.ts'),
      `Expected src/foo/bar.ts, got: ${JSON.stringify(result)}`,
    );
  });

  it('finds a plain filename with an extension', () => {
    const result = extractPathsFromPrompt('Check config.json for the database settings.');
    assert.ok(
      result.includes('config.json'),
      `Expected config.json, got: ${JSON.stringify(result)}`,
    );
  });

  it('returns [] for plain text with no file paths', () => {
    const result = extractPathsFromPrompt('Please fix the authentication bug in the login flow.');
    assert.deepEqual(result, []);
  });

  it('deduplicates repeated paths', () => {
    const result = extractPathsFromPrompt(
      'Edit src/foo/bar.ts — the main logic is in src/foo/bar.ts.',
    );
    const count = result.filter((p) => p === 'src/foo/bar.ts').length;
    assert.equal(count, 1, 'Duplicate path should appear only once');
  });
});

// ── findScopedContextFiles ────────────────────────────────────────────────────

describe('findScopedContextFiles', () => {
  it('walks dirs and returns HYDRA.md found in an ancestor dir', () => {
    const root = makeTmpTree({
      'src/db/schema.ts': '// schema',
      'src/HYDRA.md': '# Src context',
    });
    try {
      const result = findScopedContextFiles(
        'Please update src/db/schema.ts with the new index.',
        root,
      );
      assert.equal(result.length, 1, 'Should find exactly one HYDRA.md');
      assert.ok(result[0].endsWith('HYDRA.md'), 'Result should end with HYDRA.md');
      assert.ok(result[0].includes('src'), 'Result path should contain src');
    } finally {
      cleanTmp(root);
    }
  });

  it('returns [] when no HYDRA.md files exist in the tree', () => {
    const root = makeTmpTree({
      'src/db/schema.ts': '// schema',
    });
    try {
      const result = findScopedContextFiles('Edit src/db/schema.ts.', root);
      assert.deepEqual(result, []);
    } finally {
      cleanTmp(root);
    }
  });

  it('caps results at maxFiles', () => {
    const root = makeTmpTree({
      'a/b/c/deep.ts': '// deep',
      'a/b/HYDRA.md': '# b context',
      'a/HYDRA.md': '# a context',
      // root HYDRA.md is intentionally excluded by the function
    });
    try {
      const result = findScopedContextFiles('Edit a/b/c/deep.ts.', root, { maxFiles: 1 });
      assert.equal(result.length, 1, 'Should be capped at 1');
    } finally {
      cleanTmp(root);
    }
  });
});

// ── compileHierarchicalContext ────────────────────────────────────────────────

describe('compileHierarchicalContext', () => {
  it('produces the correct section-header format', () => {
    const root = makeTmpTree({
      'src/HYDRA.md': '# Src context\nSome details.',
    });
    try {
      const filePath = join(root, 'src', 'HYDRA.md');
      const result = compileHierarchicalContext([filePath], root);
      assert.ok(result.includes('--- [src/HYDRA.md] ---'), `Missing header. Got:\n${result}`);
      assert.ok(result.includes('# Src context'), `Missing content. Got:\n${result}`);
    } finally {
      cleanTmp(root);
    }
  });

  it('returns empty string for an empty array', () => {
    const result = compileHierarchicalContext([], '/any/root');
    assert.equal(result, '');
  });

  it('silently skips files that cannot be read', () => {
    const root = makeTmpTree({
      'src/HYDRA.md': '# Real file',
    });
    try {
      const realFile = join(root, 'src', 'HYDRA.md');
      const missingFile = join(root, 'nonexistent', 'HYDRA.md');
      const result = compileHierarchicalContext([missingFile, realFile], root);
      // Should not throw; should include the real file's content
      assert.ok(result.includes('# Real file'), `Missing real content. Got:\n${result}`);
      // The missing file's path should not produce a broken section
      assert.ok(!result.includes('nonexistent'), `Should skip missing file. Got:\n${result}`);
    } finally {
      cleanTmp(root);
    }
  });
});

// ── buildAgentContext (wired behavior) ────────────────────────────────────────

describe('buildAgentContext', () => {
  it('returns root-only context when no promptText is provided', () => {
    const root = makeTmpTree({
      'src/HYDRA.md': '# Scoped src context',
      'package.json': '{"name":"test-project"}',
    });
    try {
      const projectConfig = { projectRoot: root, projectName: 'test-project' };
      // No promptText → should fall through to base context only
      const result = buildAgentContext('claude', {}, projectConfig, null);
      // Must not contain the scoped context header
      assert.ok(
        !result.includes('--- [src/HYDRA.md] ---'),
        `Should not include scoped header. Got:\n${result}`,
      );
    } finally {
      cleanTmp(root);
    }
  });

  it('prepends scoped HYDRA.md when promptText references a path in that subtree', () => {
    const root = makeTmpTree({
      'src/foo/bar.ts': '// implementation',
      'src/HYDRA.md': '# Src module context\nDatabase schema details.',
      'package.json': '{"name":"test-project"}',
    });
    try {
      const projectConfig = { projectRoot: root, projectName: 'test-project' };
      const prompt = `Please update the function in src/foo/bar.ts to handle null input.`;
      const result = buildAgentContext('claude', {}, projectConfig, prompt);
      // Scoped context header must appear before root context
      assert.ok(
        result.includes('--- [src/HYDRA.md] ---'),
        `Should include scoped header. Got:\n${result}`,
      );
      assert.ok(
        result.includes('# Src module context'),
        `Should include scoped content. Got:\n${result}`,
      );
      // Scoped section should come before the root PROJECT CONTEXT block
      const scopedIdx = result.indexOf('--- [src/HYDRA.md] ---');
      const rootIdx = result.indexOf('--- PROJECT CONTEXT');
      assert.ok(
        scopedIdx < rootIdx,
        `Scoped context should precede root context. scopedIdx=${scopedIdx}, rootIdx=${rootIdx}`,
      );
    } finally {
      cleanTmp(root);
    }
  });

  it('falls back to root-only context when no scoped HYDRA.md files are found', () => {
    const root = makeTmpTree({
      'src/foo/bar.ts': '// implementation',
      'package.json': '{"name":"test-project"}',
      // No HYDRA.md in src/
    });
    try {
      const projectConfig = { projectRoot: root, projectName: 'test-project' };
      const prompt = `Please update src/foo/bar.ts.`;
      const result = buildAgentContext('claude', {}, projectConfig, prompt);
      assert.ok(
        !result.includes('--- [src/'),
        `Should not include any scoped header. Got:\n${result}`,
      );
    } finally {
      cleanTmp(root);
    }
  });
});
