import { ExternalMcpError } from "./model.js";
export const clientLimits = Object.freeze({
  messageBytes: 1024 * 1024,
  argumentsBytes: 32768,
  snapshotBytes: 262144,
  tools: 100,
  descriptionBytes: 4096,
  depth: 24,
  nodes: 12000,
  members: 256,
});
export function inspectJson(value: unknown, bytes = clientLimits.messageBytes) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > bytes)
    throw new ExternalMcpError("EXTERNAL_MCP_SIZE_LIMIT", 413);
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    if (++nodes > clientLimits.nodes || item.depth > clientLimits.depth)
      throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
    if (typeof item.value === "number" && !Number.isFinite(item.value))
      throw new ExternalMcpError("EXTERNAL_MCP_INVALID_JSON");
    if (item.value && typeof item.value === "object") {
      const children = Object.values(item.value);
      if (children.length > clientLimits.members)
        throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
      for (const child of children) stack.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}
export function decodeJson(raw: Buffer, bytes = clientLimits.messageBytes): unknown {
  if (raw.length > bytes) throw new ExternalMcpError("EXTERNAL_MCP_SIZE_LIMIT", 413);
  let quoted = false,
    escaped = false,
    depth = 0,
    nodes = 0;
  for (const b of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (b === 92) escaped = true;
      else if (b === 34) quoted = false;
      continue;
    }
    if (b === 34) quoted = true;
    else if (b === 123 || b === 91) {
      depth++;
      nodes++;
    } else if (b === 125 || b === 93) depth--;
    else if (b === 44 || b === 58) nodes++;
    if (depth > clientLimits.depth || depth < 0 || nodes > clientLimits.nodes)
      throw new ExternalMcpError("EXTERNAL_MCP_STRUCTURE_LIMIT", 413);
  }
  try {
    return inspectJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)), bytes);
  } catch (error) {
    if (error instanceof ExternalMcpError) throw error;
    throw new ExternalMcpError("EXTERNAL_MCP_INVALID_JSON");
  }
}
