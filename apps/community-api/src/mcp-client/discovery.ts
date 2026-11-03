import { clientLimits, inspectJson } from "./limits.js";
import { ExternalMcpError, type ToolSnapshot } from "./model.js";
import { snapshotTools } from "./tool-policy.js";

/** A notification invalidates all earlier discovery observations immediately. */
export class ToolRevision {
  private current = Symbol();
  capture() {
    return this.current;
  }
  changed() {
    this.current = Symbol();
  }
  check(revision: symbol | undefined) {
    if (revision === undefined || revision !== this.current)
      throw new ExternalMcpError("EXTERNAL_MCP_SNAPSHOT_CHANGED", 409);
  }
}

/** One isolated, complete discovery. Server-owned fields never carry trust state. */
export class Discovery {
  private active = false;
  private invalid = false;
  private pending = false;
  private expected: string | undefined;
  private finished = false;
  private readonly cursors = new Set<string>();
  private readonly names = new Set<string>();
  private readonly tools: ToolSnapshot[] = [];
  private bytes = 0;
  private pages = 0;

  begin() {
    if (this.active) throw new ExternalMcpError("EXTERNAL_MCP_CONNECTION_BUSY", 409);
    this.active = true;
  }

  invalidate() {
    this.invalid = true;
  }

  request(cursor: unknown) {
    if (
      !this.active ||
      this.invalid ||
      this.pending ||
      this.finished ||
      cursor !== this.expected ||
      this.pages >= 5
    )
      throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
    this.pending = true;
  }

  page(result: Record<string, unknown>) {
    if (!this.active || this.invalid || !this.pending || !Array.isArray(result.tools))
      throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
    const cursor = result.nextCursor;
    if (
      cursor !== undefined &&
      (typeof cursor !== "string" ||
        !cursor.length ||
        cursor.length > 2048 ||
        this.cursors.has(cursor))
    )
      throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
    this.bytes += Buffer.byteLength(JSON.stringify(result.tools));
    if (
      this.bytes > clientLimits.snapshotBytes ||
      this.tools.length + result.tools.length > clientLimits.tools
    )
      throw new ExternalMcpError("EXTERNAL_MCP_TOOL_LIMIT", 413);
    const page = snapshotTools(result.tools);
    for (const tool of page) {
      if (this.names.has(tool.name)) throw new ExternalMcpError("EXTERNAL_MCP_TOOL_REJECTED");
      this.names.add(tool.name);
    }
    this.tools.push(...page);
    this.pages++;
    this.pending = false;
    this.expected = cursor as string | undefined;
    this.finished = cursor === undefined;
    if (typeof cursor === "string") this.cursors.add(cursor);
    // SDK gets only locally constructed definitions, never unsupported schemas or metadata.
    return page.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema:
        tool.status === "available"
          ? tool.inputSchema
          : { type: "object", properties: {}, additionalProperties: false },
      ...(tool.status === "available" && tool.outputSchema
        ? { outputSchema: tool.outputSchema }
        : {}),
    }));
  }

  complete(sdkTools: Array<{ name: string }>) {
    if (
      !this.active ||
      this.invalid ||
      this.pending ||
      !this.finished ||
      !this.pages ||
      sdkTools.length !== this.tools.length ||
      sdkTools.some((t, i) => t.name !== this.tools[i]?.name)
    )
      throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
    inspectJson(this.tools, clientLimits.snapshotBytes);
    this.active = false;
    return this.tools;
  }
}
