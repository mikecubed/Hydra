/**
 * Request validation middleware for conversation routes (T009, FR-006, SC-008).
 *
 * Runs Zod safeParse on request bodies or query params against @hydra/web-contracts
 * schemas. On failure, returns HTTP 400 with a GatewayErrorResponse (category: 'validation').
 * On success, stores the parsed result in the Hono context variable.
 */
import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';
import { createGatewayErrorResponse } from '../shared/gateway-error-response.ts';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Minimal schema interface compatible with Zod's safeParse. */
interface ParseableSchema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: ZodLikeError };
}

/** Extended schema that may expose a Zod shape for field-level type inspection. */
interface ShapedSchema<T> extends ParseableSchema<T> {
  shape?: Record<string, unknown>;
}

interface ZodLikeError {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

/**
 * Detect whether a Zod schema field is a numeric type (possibly wrapped in
 * optional, default, or nullable).
 *
 * Best-effort: Zod has no public field-kind introspection API, so we inspect
 * internal `def` (Zod v4) or `_def` (Zod v3) shapes. We also support both
 * `innerType` and `inner` keys for wrapped schemas since Zod versions differ.
 * This may need updating if Zod changes its internal layout.
 */
function isZodNumericType(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') return false;
  const obj = schema as Record<string, unknown>;
  const def = (obj['def'] ?? obj['_def']) as Record<string, unknown> | undefined;
  if (!def) return false;
  const fieldType = (def['type'] ?? def['typeName']) as string | undefined;
  if (fieldType === 'number' || fieldType === 'ZodNumber') return true;
  const wrapperTypes = [
    'optional',
    'default',
    'nullable',
    'ZodOptional',
    'ZodDefault',
    'ZodNullable',
  ];
  if (fieldType !== undefined && wrapperTypes.includes(fieldType)) {
    const inner = def['innerType'] ?? def['inner'] ?? def['type_'];
    return isZodNumericType(inner);
  }
  return false;
}

/**
 * Coerce only fields the schema declares as numeric. String fields like
 * cursor are left untouched — no blanket coercion.
 */
function coerceNumericFields(
  schema: ShapedSchema<unknown>,
  raw: Record<string, string>,
): Record<string, unknown> {
  const shape = schema.shape;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (shape && key in shape && isZodNumericType(shape[key])) {
      const num = Number(value);
      result[key] = value !== '' && !Number.isNaN(num) ? num : value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Format Zod issues into a human-readable message.
 */
function formatZodErrors(error: ZodLikeError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

/**
 * Middleware that validates the JSON request body against a Zod schema.
 * On success, sets `validatedBody` in the Hono context.
 * On failure, returns 400 with a GatewayErrorResponse.
 */
export function validateBody<T>(schema: ParseableSchema<T>): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      const errorResponse = createGatewayErrorResponse({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: 'Request body is not valid JSON',
      });
      return c.json(errorResponse, 400 as ContentfulStatusCode);
    }

    const result = schema.safeParse(raw);
    if (!result.success) {
      const errorResponse = createGatewayErrorResponse({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: formatZodErrors(result.error),
      });
      return c.json(errorResponse, 400 as ContentfulStatusCode);
    }

    c.set('validatedBody' as never, result.data as never);
    await next();
    return; // eslint-disable-line no-useless-return
  });
}

/**
 * Middleware that validates query parameters against a Zod schema.
 * Converts query string values to appropriate types before parsing.
 * On success, sets `validatedQuery` in the Hono context.
 * On failure, returns 400 with a GatewayErrorResponse.
 */
export function validateQuery<T>(schema: ParseableSchema<T>): MiddlewareHandler {
  return createMiddleware(async (c, next) => {
    const rawQuery = c.req.query();

    // Only coerce fields the schema declares as numeric — opaque strings like cursor stay intact
    const coerced = coerceNumericFields(schema as ShapedSchema<unknown>, rawQuery);

    const result = schema.safeParse(coerced);
    if (!result.success) {
      const errorResponse = createGatewayErrorResponse({
        code: 'VALIDATION_FAILED',
        category: 'validation',
        message: formatZodErrors(result.error),
      });
      return c.json(errorResponse, 400 as ContentfulStatusCode);
    }

    c.set('validatedQuery' as never, result.data as never);
    await next();
    return; // eslint-disable-line no-useless-return
  });
}
