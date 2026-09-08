/**
 * Minimal JSON Schema (2020-12 subset) validator for the tool schemas.
 * Supports: type (incl. unions + null), properties, required,
 * additionalProperties:false, items, enum, const, minItems, minimum/maximum,
 * minLength, local `#/$defs/...` refs.
 * No oneOf / anyOf / allOf / remote $ref.
 */

export type JsonSchemaLike = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaLike;
  items?: JsonSchemaLike;
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  $ref?: string;
  $defs?: Record<string, JsonSchemaLike>;
  [k: string]: unknown;
};

interface ValidationIssue {
  path: string;
  message: string;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, t: string): boolean {
  if (t === "integer") return typeof value === "number" && Number.isInteger(value);
  if (t === "number") return typeof value === "number" && Number.isFinite(value);
  if (t === "object") return typeOf(value) === "object";
  return typeOf(value) === t;
}

function resolveRef(root: JsonSchemaLike, schema: JsonSchemaLike): JsonSchemaLike {
  if (!schema.$ref) return schema;
  const m = /^#\/\$defs\/([^/]+)$/.exec(schema.$ref);
  if (!m) throw new Error(`unsupported $ref ${schema.$ref}`);
  const def = root.$defs?.[m[1]];
  if (!def) throw new Error(`missing $defs.${m[1]}`);
  return def;
}

export function validateSchema(
  schema: JsonSchemaLike,
  value: unknown,
  path = "$",
  root: JsonSchemaLike = schema,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  schema = resolveRef(root, schema);

  if (schema.const !== undefined) {
    if (JSON.stringify(schema.const) !== JSON.stringify(value)) {
      issues.push({ path, message: `expected const ${JSON.stringify(schema.const)}` });
      return issues;
    }
  }

  if (schema.enum) {
    const ok = schema.enum.some(
      (e) => Object.is(e, value) || JSON.stringify(e) === JSON.stringify(value),
    );
    if (!ok) {
      issues.push({ path, message: "value not in enum" });
      return issues;
    }
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      issues.push({
        path,
        message: `expected type ${types.join("|")}, got ${typeOf(value)}`,
      });
      return issues;
    }
  }

  if (matchesType(value, "object") && value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in obj)) issues.push({ path: `${path}.${key}`, message: "required" });
    }
    const extra = schema.additionalProperties;
    if (extra === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push({ path: `${path}.${key}`, message: "additional property" });
        }
      }
    } else if (extra && typeof extra === "object") {
      // Open map of named blocks (e.g. a third-party adapter under `adapters`):
      // the names are free, the shape still has to validate.
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push(...validateSchema(extra, obj[key], `${path}.${key}`, root));
        }
      }
    }
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) {
        issues.push(...validateSchema(child, obj[key], `${path}.${key}`, root));
      }
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push({ path, message: `minItems ${schema.minItems}` });
    }
    if (schema.items) {
      value.forEach((item, i) => {
        issues.push(...validateSchema(schema.items!, item, `${path}[${i}]`, root));
      });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, message: `minimum ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push({ path, message: `maximum ${schema.maximum}` });
    }
  }

  if (
    typeof value === "string" &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    issues.push({ path, message: `minLength ${schema.minLength}` });
  }

  return issues;
}

export function assertValid(schema: JsonSchemaLike, value: unknown): void {
  const issues = validateSchema(schema, value, "$", schema);
  if (issues.length) {
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  }
}
