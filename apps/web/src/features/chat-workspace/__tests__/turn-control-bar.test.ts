import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  resolveTurnActions,
  hasTurnActions,
  type TurnActionSet,
  type TurnActionFlags,
} from '../components/turn-control-logic.ts';

// ─── Helpers ────────────────────────────────────────────────────────────────

function defaultFlags(overrides: Partial<TurnActionFlags> = {}): TurnActionFlags {
  return {
    canCancel: false,
    canRetry: false,
    canBranch: false,
    canFollowUp: false,
    ...overrides,
  };
}

// ─── resolveTurnActions ─────────────────────────────────────────────────────

describe('resolveTurnActions', () => {
  it('returns empty actions when nothing is eligible', () => {
    const result = resolveTurnActions(defaultFlags());
    assert.deepEqual(result, { cancel: false, retry: false, branch: false, followUp: false });
  });

  it('returns cancel=true when canCancel is true', () => {
    const result = resolveTurnActions(defaultFlags({ canCancel: true }));
    assert.equal(result.cancel, true);
    assert.equal(result.retry, false);
    assert.equal(result.branch, false);
    assert.equal(result.followUp, false);
  });

  it('returns retry=true when canRetry is true', () => {
    const result = resolveTurnActions(defaultFlags({ canRetry: true }));
    assert.equal(result.retry, true);
  });

  it('returns branch=true when canBranch is true', () => {
    const result = resolveTurnActions(defaultFlags({ canBranch: true }));
    assert.equal(result.branch, true);
  });

  it('returns followUp=true when canFollowUp is true', () => {
    const result = resolveTurnActions(defaultFlags({ canFollowUp: true }));
    assert.equal(result.followUp, true);
  });

  it('supports multiple actions simultaneously', () => {
    const result = resolveTurnActions(
      defaultFlags({ canRetry: true, canBranch: true, canFollowUp: true }),
    );
    assert.equal(result.cancel, false);
    assert.equal(result.retry, true);
    assert.equal(result.branch, true);
    assert.equal(result.followUp, true);
  });

  it('cancel is exclusive — no retry/branch/follow-up when cancelling', () => {
    const result = resolveTurnActions(
      defaultFlags({ canCancel: true, canRetry: true, canBranch: true }),
    );
    assert.equal(result.cancel, true);
    assert.equal(result.retry, false);
    assert.equal(result.branch, false);
    assert.equal(result.followUp, false);
  });
});

// ─── hasTurnActions ─────────────────────────────────────────────────────────

describe('hasTurnActions', () => {
  it('returns false when all actions are false', () => {
    const actions: TurnActionSet = {
      cancel: false,
      retry: false,
      branch: false,
      followUp: false,
    };
    assert.equal(hasTurnActions(actions), false);
  });

  it('returns true when cancel is true', () => {
    assert.equal(
      hasTurnActions({ cancel: true, retry: false, branch: false, followUp: false }),
      true,
    );
  });

  it('returns true when retry is true', () => {
    assert.equal(
      hasTurnActions({ cancel: false, retry: true, branch: false, followUp: false }),
      true,
    );
  });

  it('returns true when followUp is true', () => {
    assert.equal(
      hasTurnActions({ cancel: false, retry: false, branch: false, followUp: true }),
      true,
    );
  });
});
