/**
 * Tests for lib/hydra-project.ts
 * Written first (TDD) before the module is implemented.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  _setTestRecentProjectsPath,
  addRecentProject,
  detectProjectName,
  getRecentProjects,
  isValidProject,
  resolveProject,
} from '../lib/hydra-project.ts';

const tempDirs = new Set<string>();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-project-test-'));
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  _setTestRecentProjectsPath(null);
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

// ── detectProjectName ────────────────────────────────────────────────────────

describe('detectProjectName', () => {
  it('reads project name from package.json when present', () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'my-awesome-project' }),
      'utf8',
    );

    assert.equal(detectProjectName(dir), 'my-awesome-project');
  });

  it('falls back to directory basename when package.json is absent', () => {
    const dir = makeTempDir();

    assert.equal(detectProjectName(dir), path.basename(dir));
  });

  it('falls back to directory basename when package.json has no name field', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '1.0.0' }), 'utf8');

    assert.equal(detectProjectName(dir), path.basename(dir));
  });

  it('falls back to directory basename when package.json name is empty string', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '' }), 'utf8');

    assert.equal(detectProjectName(dir), path.basename(dir));
  });

  it('falls back to directory basename when package.json is malformed JSON', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), 'not valid json', 'utf8');

    assert.equal(detectProjectName(dir), path.basename(dir));
  });
});

// ── isValidProject ───────────────────────────────────────────────────────────

describe('isValidProject', () => {
  it('returns true for a directory with package.json', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');

    assert.equal(isValidProject(dir), true);
  });

  it('returns true for a directory with .git', () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, '.git'));

    assert.equal(isValidProject(dir), true);
  });

  it('returns true for a directory with HYDRA.md', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'HYDRA.md'), '', 'utf8');

    assert.equal(isValidProject(dir), true);
  });

  it('returns true for a directory with CLAUDE.md', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '', 'utf8');

    assert.equal(isValidProject(dir), true);
  });

  it('returns true for a directory with Cargo.toml', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '', 'utf8');

    assert.equal(isValidProject(dir), true);
  });

  it('returns true for a directory with go.mod', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'go.mod'), '', 'utf8');

    assert.equal(isValidProject(dir), true);
  });

  it('returns false for an empty directory (no project markers)', () => {
    const dir = makeTempDir();

    assert.equal(isValidProject(dir), false);
  });

  it('returns false for a nonexistent path', () => {
    assert.equal(isValidProject('/nonexistent/path/that/does/not/exist'), false);
  });
});

// ── getRecentProjects / addRecentProject ──────────────────────────────────────

describe('getRecentProjects', () => {
  it('returns an empty array when recent-projects file does not exist', () => {
    const tempDir = makeTempDir();
    _setTestRecentProjectsPath(path.join(tempDir, 'recent-projects.json'));

    assert.deepEqual(getRecentProjects(), []);
  });

  it('returns an empty array when recent-projects file contains invalid JSON', () => {
    const tempDir = makeTempDir();
    const filePath = path.join(tempDir, 'recent-projects.json');
    fs.writeFileSync(filePath, 'not json', 'utf8');
    _setTestRecentProjectsPath(filePath);

    assert.deepEqual(getRecentProjects(), []);
  });

  it('returns an empty array when recent-projects file contains non-array JSON', () => {
    const tempDir = makeTempDir();
    const filePath = path.join(tempDir, 'recent-projects.json');
    fs.writeFileSync(filePath, '{"not": "array"}', 'utf8');
    _setTestRecentProjectsPath(filePath);

    assert.deepEqual(getRecentProjects(), []);
  });
});

describe('addRecentProject', () => {
  it('adds a project and it appears in getRecentProjects()', () => {
    const tempDir = makeTempDir();
    _setTestRecentProjectsPath(path.join(tempDir, 'recent-projects.json'));

    addRecentProject('/some/project');

    const recent = getRecentProjects();
    assert.ok(recent.includes(path.resolve('/some/project')));
  });

  it('normalizes relative paths to absolute', () => {
    const tempDir = makeTempDir();
    _setTestRecentProjectsPath(path.join(tempDir, 'recent-projects.json'));

    addRecentProject('relative/path');

    const recent = getRecentProjects();
    assert.ok(recent[0].startsWith('/'));
  });

  it('deduplicates: adding the same project twice keeps it once at the front', () => {
    const tempDir = makeTempDir();
    _setTestRecentProjectsPath(path.join(tempDir, 'recent-projects.json'));

    addRecentProject('/project/alpha');
    addRecentProject('/project/beta');
    addRecentProject('/project/alpha');

    const recent = getRecentProjects();
    assert.equal(recent[0], path.resolve('/project/alpha'));
    assert.equal(recent.filter((p) => p === path.resolve('/project/alpha')).length, 1);
  });

  it('prepends new projects to the top of the list', () => {
    const tempDir = makeTempDir();
    _setTestRecentProjectsPath(path.join(tempDir, 'recent-projects.json'));

    addRecentProject('/project/first');
    addRecentProject('/project/second');

    const recent = getRecentProjects();
    assert.equal(recent[0], path.resolve('/project/second'));
    assert.equal(recent[1], path.resolve('/project/first'));
  });
});

// ── resolveProject ───────────────────────────────────────────────────────────

describe('resolveProject', () => {
  it('returns a ProjectConfig with all expected path fields', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'test-app' }), 'utf8');

    const project = resolveProject({ project: dir });

    assert.equal(project.projectRoot, dir);
    assert.equal(project.projectName, 'test-app');
    assert.equal(project.coordDir, path.join(dir, 'docs', 'coordination'));
    assert.equal(project.statePath, path.join(dir, 'docs', 'coordination', 'AI_SYNC_STATE.json'));
    assert.equal(project.logPath, path.join(dir, 'docs', 'coordination', 'AI_SYNC_LOG.md'));
    assert.equal(
      project.statusPath,
      path.join(dir, 'docs', 'coordination', 'AI_ORCHESTRATOR_STATUS.json'),
    );
    assert.equal(
      project.eventsPath,
      path.join(dir, 'docs', 'coordination', 'AI_ORCHESTRATOR_EVENTS.ndjson'),
    );
    assert.equal(
      project.archivePath,
      path.join(dir, 'docs', 'coordination', 'AI_SYNC_ARCHIVE.json'),
    );
    assert.equal(project.runsDir, path.join(dir, 'docs', 'coordination', 'runs'));
    assert.ok(project.hydraRoot.length > 0);
  });

  it('resolves project name from directory basename when no package.json', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'HYDRA.md'), '', 'utf8');

    const project = resolveProject({ project: dir });

    assert.equal(project.projectName, path.basename(dir));
  });

  it('throws when directory has no project markers and validation is not skipped', () => {
    const dir = makeTempDir();

    assert.throws(() => resolveProject({ project: dir }), /Not a valid project directory/);
  });

  it('succeeds with skipValidation even for an empty directory', () => {
    const dir = makeTempDir();

    const project = resolveProject({ project: dir, skipValidation: true });

    assert.equal(project.projectRoot, dir);
  });

  it('resolves the absolute path of a relative project root', () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), '{}', 'utf8');

    const project = resolveProject({ project: dir });

    assert.ok(path.isAbsolute(project.projectRoot));
  });
});
