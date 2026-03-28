import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ZodError } from 'zod';
import {
  SafeConfigView,
  RoutingModeMutationRequest,
  ModelTierMutationRequest,
  BudgetMutationRequest,
} from '../config-mutation.ts';

describe('SafeConfigView', () => {
  const validConfig = { routing: { mode: 'balanced' } };

  it('accepts valid config with just routing.mode', () => {
    const result = SafeConfigView.parse(validConfig);
    assert.deepStrictEqual(result, { routing: { mode: 'balanced' } });
  });

  it('strips extra fields (returns only declared fields)', () => {
    const input = {
      routing: { mode: 'economy', extraRouting: true },
      unknownTopLevel: 42,
      anotherField: 'gone',
    };
    const result = SafeConfigView.parse(input);
    assert.deepStrictEqual(result, { routing: { mode: 'economy' } });
    assert.equal((result as Record<string, unknown>)['unknownTopLevel'], undefined);
    assert.equal((result as Record<string, unknown>)['anotherField'], undefined);
  });

  it('rejects objects with apiKey key', () => {
    assert.throws(() => SafeConfigView.parse({ ...validConfig, apiKey: 'k' }), {
      name: 'ZodError',
    });
  });

  it('rejects objects with secret key', () => {
    assert.throws(() => SafeConfigView.parse({ ...validConfig, secret: 's' }), {
      name: 'ZodError',
    });
  });

  it('rejects objects with hash key', () => {
    assert.throws(() => SafeConfigView.parse({ ...validConfig, hash: 'h' }), {
      name: 'ZodError',
    });
  });

  it('rejects objects with password key', () => {
    assert.throws(() => SafeConfigView.parse({ ...validConfig, password: 'p' }), {
      name: 'ZodError',
    });
  });
});

describe('RoutingModeMutationRequest', () => {
  it('rejects invalid mode "turbo"', () => {
    assert.throws(
      () => RoutingModeMutationRequest.parse({ mode: 'turbo', expectedRevision: 'r1' }),
      (err) => err instanceof ZodError,
    );
  });
});

describe('ModelTierMutationRequest', () => {
  it('rejects invalid tier "ultra"', () => {
    assert.throws(
      () => ModelTierMutationRequest.parse({ tier: 'ultra', expectedRevision: 'r1' }),
      (err) => err instanceof ZodError,
    );
  });
});

describe('BudgetMutationRequest', () => {
  const base = { modelId: 'gpt-4', expectedRevision: 'r1' };

  it('rejects non-positive dailyLimit: 0', () => {
    assert.throws(
      () => BudgetMutationRequest.parse({ ...base, dailyLimit: 0, weeklyLimit: 100 }),
      (err) => err instanceof ZodError,
    );
  });

  it('rejects non-positive dailyLimit: -1', () => {
    assert.throws(
      () => BudgetMutationRequest.parse({ ...base, dailyLimit: -1, weeklyLimit: 100 }),
      (err) => err instanceof ZodError,
    );
  });

  it('rejects non-integer dailyLimit: 1.5', () => {
    assert.throws(
      () => BudgetMutationRequest.parse({ ...base, dailyLimit: 1.5, weeklyLimit: 100 }),
      (err) => err instanceof ZodError,
    );
  });

  it('rejects when both dailyLimit and weeklyLimit are null', () => {
    assert.throws(
      () => BudgetMutationRequest.parse({ ...base, dailyLimit: null, weeklyLimit: null }),
      (err) => err instanceof ZodError,
    );
  });

  it('accepts valid request with one null limit', () => {
    const result = BudgetMutationRequest.parse({
      ...base,
      dailyLimit: 1000,
      weeklyLimit: null,
    });
    assert.equal(result.dailyLimit, 1000);
    assert.equal(result.weeklyLimit, null);
  });
});
