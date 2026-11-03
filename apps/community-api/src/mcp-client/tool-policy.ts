import { createHash } from "node:crypto";
import { specTypeSchemas } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { clientLimits, inspectJson } from "./limits.js";
import { ExternalMcpError, type AvailableTool, type ToolSnapshot } from "./model.js";

const scalarKeys = new Set([
  "title",
  "description",
  "type",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "default",
  "examples",
]);
// This built-in metaschema validates structure only. It does not compile a
// remote schema, resolve its references, or change the supported profile.
const metaValidator = new Ajv2020({ strict: true, validateFormats: false }).getSchema(
  "https://json-schema.org/draft/2020-12/schema",
);
class UnsupportedSchemaError extends ExternalMcpError {
  constructor() {
    super("EXTERNAL_MCP_SCHEMA_REJECTED");
  }
}
/** A deliberately bounded, non-regex/non-reference profile. Unknown schema
 * constructs are rejected, never silently stripped or fetched. */
export function validateSchema(schema: unknown): asserts schema is Record<string, unknown> {
  inspectJson(schema, 16384);
  let unsupported = false;
  // SDK extension scanning must never observe a declaration, including one
  // hidden inside annotations that this validator would otherwise treat as data.
  const extensionScan: unknown[] = [schema];
  let containers = 0;
  while (extensionScan.length) {
    const value = extensionScan.pop();
    if (typeof value === "boolean" && ++containers > 512)
      throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
    if (value && typeof value === "object") {
      if (++containers > 512) throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
      if (Object.hasOwn(value, "$schema") && typeof Reflect.get(value, "$schema") !== "string")
        throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
      if (Object.hasOwn(value, "x-mcp-header")) unsupported = true;
      extensionScan.push(...Object.values(value));
    }
  }
  if (!metaValidator?.(schema)) throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
  const stack: unknown[] = [schema];
  let count = 0;
  while (stack.length) {
    const item = stack.pop();
    if (++count > 512) throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
    if (typeof item === "boolean") {
      unsupported = true;
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
    for (const [key, value] of Object.entries(item)) {
      if (key === "$schema") {
        if (typeof value !== "string") throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
        if (item !== schema || value !== "https://json-schema.org/draft/2020-12/schema")
          unsupported = true;
      } else if (key === "type" && Array.isArray(value)) {
        const validTypes = new Set([
          "null",
          "boolean",
          "object",
          "array",
          "number",
          "integer",
          "string",
        ]);
        if (
          !value.length ||
          new Set(value).size !== value.length ||
          value.some((v) => typeof v !== "string" || !validTypes.has(v))
        )
          throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
        if (value.filter((v) => v !== "null").length > 1) unsupported = true;
      } else if (key === "properties") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
        for (const [name, child] of Object.entries(value)) {
          if (["__proto__", "constructor", "prototype"].includes(name) || name.length > 128)
            throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
          stack.push(child);
        }
      } else if (key === "items" || key === "additionalProperties") {
        if (typeof value !== "boolean") stack.push(value);
      } else if (key === "required") {
        if (
          !Array.isArray(value) ||
          value.length > 100 ||
          value.some((n) => typeof n !== "string" || n.length > 128)
        )
          throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
      } else if (!scalarKeys.has(key)) unsupported = true;
    }
  }
  if (unsupported) throw new UnsupportedSchemaError();
  // One dialect, no format plugin or remote loader; limits checked before compile.
  const validator = new AjvJsonSchemaValidator(
    new Ajv2020({ strict: true, allErrors: false, validateFormats: false, ownProperties: true }),
  );
  try {
    validator.getValidator(schema as Record<string, unknown>);
  } catch (error) {
    // Ajv 8.18.0 identifies standards-valid strictTypes incompatibilities
    // this way. They remain unavailable, never sent as executable schemas.
    if (
      error instanceof Error &&
      error.constructor === Error &&
      error.message.startsWith("strict mode: ") &&
      error.message.endsWith("(strictTypes)")
    )
      throw new UnsupportedSchemaError();
    throw error;
  }
}
export function schemaValidator() {
  const engine = new AjvJsonSchemaValidator(
    new Ajv2020({ strict: true, allErrors: false, validateFormats: false, ownProperties: true }),
  );
  return {
    getValidator<T>(schema: Record<string, unknown>) {
      validateSchema(schema);
      return engine.getValidator<T>(schema);
    },
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export function digest(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function snapshotTools(tools: unknown[]): ToolSnapshot[] {
  if (tools.length > clientLimits.tools) throw new ExternalMcpError("EXTERNAL_MCP_TOOL_LIMIT", 413);
  const names = new Set<string>();
  const result = tools.map((raw) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("name" in raw) ||
      typeof raw.name !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(raw.name) ||
      names.has(raw.name)
    )
      throw new ExternalMcpError("EXTERNAL_MCP_TOOL_REJECTED");
    names.add(raw.name);
    if (!("inputSchema" in raw)) throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
    const output = "outputSchema" in raw ? raw.outputSchema : undefined;
    // Check the published Tool envelope using only local placeholder schemas.
    // Neither unsupported input nor output schema enters the SDK validator.
    const envelope = specTypeSchemas.Tool["~standard"].validate({
      ...raw,
      inputSchema: { type: "object" },
      ...(output !== undefined ? { outputSchema: { type: "object" } } : {}),
    });
    if (envelope.issues) throw new ExternalMcpError("EXTERNAL_MCP_TOOL_REJECTED");
    const description =
      "description" in raw && typeof raw.description === "string" ? raw.description : "";
    if (Buffer.byteLength(description) > clientLimits.descriptionBytes)
      throw new ExternalMcpError("EXTERNAL_MCP_TOOL_LIMIT", 413);
    // Resource limits are fatal, including for schemas that cannot be used.
    inspectJson(raw.inputSchema, 16384);
    if (output !== undefined) inspectJson(output, 16384);
    if (
      !raw.inputSchema ||
      typeof raw.inputSchema !== "object" ||
      Array.isArray(raw.inputSchema) ||
      !("type" in raw.inputSchema) ||
      raw.inputSchema.type !== "object" ||
      (output !== undefined && (!output || typeof output !== "object" || Array.isArray(output)))
    )
      throw new ExternalMcpError("EXTERNAL_MCP_SCHEMA_REJECTED");
    let unsupported = false;
    for (const schema of [raw.inputSchema, ...(output !== undefined ? [output] : [])]) {
      try {
        validateSchema(schema);
      } catch (error) {
        if (!(error instanceof UnsupportedSchemaError)) throw error;
        unsupported = true;
      }
    }
    if (unsupported) {
      return {
        name: raw.name,
        description,
        hash: digest(raw),
        status: "unsupported" as const,
        reason: "unsupported_schema" as const,
      };
    }
    const data = {
      name: raw.name,
      description,
      status: "available" as const,
      inputSchema: raw.inputSchema,
      ...(output ? { outputSchema: output as Record<string, unknown> } : {}),
    };
    return { ...data, hash: digest(raw) };
  });
  inspectJson(result, clientLimits.snapshotBytes);
  return result;
}
export function validateArguments(
  tool: AvailableTool,
  args: unknown,
): asserts args is Record<string, unknown> {
  inspectJson(args, clientLimits.argumentsBytes);
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new ExternalMcpError("EXTERNAL_MCP_ARGUMENTS_REJECTED");
  const check = schemaValidator().getValidator(tool.inputSchema);
  if (!check(args).valid) throw new ExternalMcpError("EXTERNAL_MCP_ARGUMENTS_REJECTED");
}
