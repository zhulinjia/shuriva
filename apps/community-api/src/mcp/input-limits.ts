/** Candidate limits exercised by G2; this module is not mounted in the product. */
export const limits = Object.freeze({
  messageBytes: 64 * 1024,
  argumentBytes: 32 * 1024,
  depth: 32,
  nodes: 2048,
  members: 256,
  headerBytes: 8192,
});

export class BoundaryError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function boundedJson(raw: Buffer): unknown {
  if (raw.length > limits.messageBytes) throw new BoundaryError(413, "MCP_INPUT_LIMIT");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new BoundaryError(400, "MCP_INPUT_INVALID");
  }
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > limits.nodes || item.depth > limits.depth)
      throw new BoundaryError(413, "MCP_STRUCTURE_LIMIT");
    if (typeof item.value === "string" && Buffer.byteLength(item.value) > limits.argumentBytes)
      throw new BoundaryError(413, "MCP_STRING_LIMIT");
    if (item.value && typeof item.value === "object") {
      const children = Object.values(item.value);
      if (children.length > limits.members) throw new BoundaryError(413, "MCP_STRUCTURE_LIMIT");
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  if (value && typeof value === "object" && "params" in value) {
    const params = value.params;
    if (
      params &&
      typeof params === "object" &&
      "arguments" in params &&
      Buffer.byteLength(JSON.stringify(params.arguments) ?? "") > limits.argumentBytes
    )
      throw new BoundaryError(413, "MCP_ARGUMENT_LIMIT");
  }
  return value;
}
