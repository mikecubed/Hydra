/**
 * Tests for contract validation helpers.
 *
 * These helpers are schema-agnostic — they work with any Zod schema,
 * not just web initiative contracts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { assertContractValid, assertContractInvalid } from './contract-helpers.ts';

const TestSchema = z.object({
  name: z.string(),
  age: z.number().int().positive(),
});

describe('assertContractValid', () => {
  it('returns parsed result for valid data', () => {
    const result = assertContractValid(TestSchema, { name: 'Alice', age: 30 });
    assert.deepEqual(result, { name: 'Alice', age: 30 });
  });

  it('throws AssertionError for invalid data', () => {
    assert.throws(
      () => assertContractValid(TestSchema, { name: 123, age: 'not a number' }),
      (err: unknown) => {
        assert.ok(
          err instanceof assert.AssertionError || (err as Error).name === 'AssertionError',
          `Expected AssertionError, got ${(err as Error).name}`,
        );
        return true;
      },
    );
  });

  it('throws AssertionError (not raw ZodError) for schema violations', () => {
    assert.throws(
      () => assertContractValid(TestSchema, {}),
      (err: unknown) => {
        // Must be an assertion error, not a ZodError
        assert.notEqual((err as Error).name, 'ZodError');
        return true;
      },
    );
  });
});

describe('assertContractInvalid', () => {
  it('passes when data is invalid', () => {
    assertContractInvalid(TestSchema, { name: 123 });
  });

  it('throws AssertionError when data is unexpectedly valid', () => {
    assert.throws(
      () => {
        assertContractInvalid(TestSchema, { name: 'Alice', age: 30 });
      },
      (err: unknown) => {
        assert.ok(
          err instanceof assert.AssertionError || (err as Error).name === 'AssertionError',
          `Expected AssertionError, got ${(err as Error).name}`,
        );
        return true;
      },
    );
  });

  it('checks expectedField in Zod error path', () => {
    // Should pass: 'age' is the field that fails
    assertContractInvalid(TestSchema, { name: 'Alice', age: -5 }, 'age');
  });

  it('throws when expectedField is not in error path', () => {
    assert.throws(
      () => {
        assertContractInvalid(TestSchema, { name: 'Alice', age: -5 }, 'name');
      },
      (err: unknown) => {
        assert.ok(
          err instanceof assert.AssertionError || (err as Error).name === 'AssertionError',
          `Expected AssertionError, got ${(err as Error).name}`,
        );
        return true;
      },
    );
  });
});
