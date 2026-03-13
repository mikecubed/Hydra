import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CHECKPOINT_FILE,
  SESSION_STATE_FILE,
  getCheckpointPath,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  getSessionStatePath,
  loadSessionState,
  saveSessionState,
  computeSessionStatus,
  computeActionNeeded,
} from '../lib/hydra-evolve-state.ts';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hydra-evolve-state-test-'));
}

describe('hydra-evolve-state', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  describe('Checkpoint', () => {
    it('getCheckpointPath returns correct path', () => {
      tempDir = tmpDir();
      const p = getCheckpointPath(tempDir);
      assert.equal(p, path.join(tempDir, CHECKPOINT_FILE));
    });

    it('loadCheckpoint returns null if no file', () => {
      tempDir = tmpDir();
      const cp = loadCheckpoint(tempDir);
      assert.equal(cp, null);
    });

    it('saveCheckpoint and loadCheckpoint round-trip', () => {
      tempDir = tmpDir();
      const data = { foo: 'bar', n: 123 };
      const savedPath = saveCheckpoint(tempDir, data);
      assert.ok(savedPath.endsWith(CHECKPOINT_FILE));

      const loaded = loadCheckpoint(tempDir);
      assert.deepEqual(loaded, data);
    });

    it('deleteCheckpoint removes file', () => {
      tempDir = tmpDir();
      saveCheckpoint(tempDir, { a: 1 });
      assert.ok(fs.existsSync(getCheckpointPath(tempDir)));
      deleteCheckpoint(tempDir);
      assert.ok(!fs.existsSync(getCheckpointPath(tempDir)));
    });

    it('deleteCheckpoint is safe if file missing', () => {
      tempDir = tmpDir();
      deleteCheckpoint(tempDir); // no throw
    });
  });

  describe('Session State', () => {
    it('getSessionStatePath returns correct path', () => {
      tempDir = tmpDir();
      const p = getSessionStatePath(tempDir);
      assert.equal(p, path.join(tempDir, SESSION_STATE_FILE));
    });

    it('saveSessionState and loadSessionState round-trip', () => {
      tempDir = tmpDir();
      const state = { status: 'running', round: 1 };
      saveSessionState(tempDir, state);
      const loaded = loadSessionState(tempDir);
      assert.deepEqual(loaded, state);
    });
  });

  describe('computeSessionStatus', () => {
    it('returns "running" if isRunning is true', () => {
      assert.equal(computeSessionStatus([], 3, null, true), 'running');
    });

    it('returns "failed" if no results and not running', () => {
      assert.equal(computeSessionStatus([], 3, null, false), 'failed');
    });

    it('returns "failed" if all rounds errored/rejected', () => {
      const rounds = [{ verdict: 'error' }, { verdict: 'reject' }];
      assert.equal(computeSessionStatus(rounds, 3, null, false), 'failed');
    });

    it('returns "partial" if stopReason exists', () => {
      const rounds = [{ verdict: 'approve' }];
      assert.equal(computeSessionStatus(rounds, 3, 'timeout', false), 'partial');
    });

    it('returns "partial" if fewer rounds than max', () => {
      const rounds = [{ verdict: 'approve' }];
      assert.equal(computeSessionStatus(rounds, 3, null, false), 'partial');
    });

    it('returns "completed" if max rounds reached', () => {
      const rounds = [{ verdict: 'approve' }, { verdict: 'reject' }, { verdict: 'approve' }];
      assert.equal(computeSessionStatus(rounds, 3, null, false), 'completed');
    });
  });

  describe('computeActionNeeded', () => {
    it('completed', () => {
      assert.match(computeActionNeeded({ length: 3 }, 3, 'completed'), /Session complete/);
    });
    it('failed', () => {
      assert.match(computeActionNeeded({ length: 3 }, 3, 'failed'), /All rounds failed/);
    });
    it('partial', () => {
      assert.match(computeActionNeeded({ length: 1 }, 3, 'partial'), /2 round\(s\) remaining/);
    });
    it('interrupted', () => {
      assert.match(computeActionNeeded({ length: 1 }, 3, 'interrupted'), /Session was interrupted/);
    });
    it('running', () => {
      assert.match(computeActionNeeded({ length: 1 }, 3, 'running'), /Session in progress/);
    });
  });
});
