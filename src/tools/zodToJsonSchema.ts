import type { ZodTypeAny } from 'zod';
import { z } from 'zod';

/**
 * Tiny zod → JSON-schema converter. Covers the shapes we use in tool
 * argument schemas:
 *   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodEnum, ZodArray,
 *   ZodOptional, ZodUnion (tagged by kind), ZodRecord.
 *
 * Not a general-purpose converter. Works for tool-arg shapes; fall back
 * to `zod-to-json-schema` (npm) if we ever need more.
 */

export function zodToJsonSchema(schema: ZodTypeAny): unknown {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const typeName = def.typeName;
  switch (typeName) {
    case 'ZodString':
      return withDesc(schema, { type: 'string' });
    case 'ZodNumber':
      return withDesc(schema, { type: 'number' });
    case 'ZodBoolean':
      return withDesc(schema, { type: 'boolean' });
    case 'ZodOptional':
      return zodToJsonSchema(
        (schema as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType,
      );
    case 'ZodArray':
      return withDesc(schema, {
        type: 'array',
        items: zodToJsonSchema(
          (schema as unknown as { _def: { type: ZodTypeAny } })._def.type,
        ),
      });
    case 'ZodEnum':
      return withDesc(schema, {
        type: 'string',
        enum: (schema as unknown as { _def: { values: string[] } })._def.values,
      });
    case 'ZodUnion': {
      const options = (schema as unknown as { _def: { options: ZodTypeAny[] } })._def.options;
      return withDesc(schema, { anyOf: options.map(zodToJsonSchema) });
    }
    case 'ZodRecord':
      return withDesc(schema, {
        type: 'object',
        additionalProperties: zodToJsonSchema(
          (schema as unknown as { _def: { valueType: ZodTypeAny } })._def.valueType,
        ),
      });
    case 'ZodObject': {
      const shape = (schema as unknown as { _def: { shape: () => Record<string, ZodTypeAny> } })._def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) required.push(key);
      }
      return withDesc(schema, {
        type: 'object',
        properties,
        ...(required.length ? { required } : {}),
      });
    }
    case 'ZodAny':
      return {};
    default:
      // Fallback: permissive.
      return {};
  }
}

function withDesc(schema: ZodTypeAny, base: Record<string, unknown>): Record<string, unknown> {
  const desc = (schema as unknown as { description?: string }).description;
  return desc ? { ...base, description: desc } : base;
}

function isOptional(schema: ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  return def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault';
}

export { z };
