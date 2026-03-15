/**
 * Shared contract validation test helpers.
 *
 * Schema-agnostic utilities for writing contract conformance tests.
 * Works with any Zod schema — not tied to specific web initiative contracts.
 */
import assert from 'node:assert/strict';
import { type z } from 'zod';

/**
 * Assert that `data` conforms to `schema`. Returns the parsed result.
 * Throws `AssertionError` (not ZodError) on validation failure.
 */
export function assertContractValid<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    assert.fail(`Contract validation failed:\n${issues}`);
  }
  return result.data as z.infer<T>;
}

/**
 * Assert that `data` does NOT conform to `schema`.
 * Optionally verify that a specific `expectedField` appears in the error path.
 * Throws `AssertionError` if data is unexpectedly valid or if the expected field is missing.
 */
export function assertContractInvalid(
  schema: z.ZodType,
  data: unknown,
  expectedField?: string,
): void {
  const result = schema.safeParse(data);
  if (result.success) {
    assert.fail('Expected contract validation to fail, but it succeeded');
  }
  if (expectedField !== undefined) {
    const paths = result.error.issues.flatMap((i) => i.path.map(String));
    assert.ok(
      paths.includes(expectedField),
      `Expected field "${expectedField}" in error path, got: [${paths.join(', ')}]`,
    );
  }
}
