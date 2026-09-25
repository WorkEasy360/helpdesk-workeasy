import { z } from 'zod';

/**
 * Optional field that treats an empty form input as "not provided".
 *
 * Browsers submit untouched text inputs as empty strings, so without this an optional
 * email or URL field would fail validation the moment it is left blank.
 *
 * The `.optional()` wraps the transform rather than the other way round, which matters
 * for PATCH semantics: a key the client did not send stays `undefined` so the service
 * leaves that column alone, while an explicit `null` or `''` clears it. With the
 * wrapping reversed, sending `{ subject }` would quietly null every other field.
 */
export function optionalField<T extends z.ZodTypeAny>(schema: T) {
  return z
    .union([schema, z.literal(''), z.null()])
    .transform((value): z.output<T> | null => (value === '' ? null : (value as z.output<T>)))
    .optional();
}

/**
 * Boolean query-string parameter. `z.coerce.boolean()` treats any non-empty string —
 * including "false" — as true, which silently inverts `?flag=false`. This accepts the
 * spellings a client actually sends and rejects anything else.
 */
export const queryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

type WithoutDefault<S> =
  S extends z.ZodDefault<infer Inner> ? Inner : S extends z.ZodPrefault<infer Inner> ? Inner : S;

export type PatchShape<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<WithoutDefault<T[K]>>;
};

function withoutDefault(field: z.ZodType): z.ZodType {
  if (field instanceof z.ZodDefault || field instanceof z.ZodPrefault) {
    return withoutDefault(field.unwrap() as z.ZodType);
  }
  if (field instanceof z.ZodOptional) {
    return withoutDefault(field.unwrap() as z.ZodType);
  }
  return field;
}

/**
 * The PATCH version of a create schema: every field optional, and no defaults.
 *
 * `.partial()` is not enough. In Zod 4 a field declared `.default(x)` still produces `x`
 * when the key is missing, even after `.partial()` — so `{ name }` sent to rename a
 * role would arrive as `{ name, permissionKeys: [] }` and wipe its permissions. Here a
 * key the client did not send stays `undefined`, and the service leaves that column
 * alone. Object-level refinements are not carried over, as with `.partial()`.
 */
export function patchSchema<T extends z.ZodRawShape>(schema: z.ZodObject<T>): z.ZodObject<PatchShape<T>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    shape[key] = withoutDefault(field as z.ZodType).optional();
  }
  return z.object(shape) as unknown as z.ZodObject<PatchShape<T>>;
}
