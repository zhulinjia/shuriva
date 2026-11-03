import { McpBoundaryError, RateBudget } from "../mcp/public.js";
import { ExternalMcpError } from "./model.js";

export { RateBudget };
export function takeRate(budget: RateBudget, key: string) {
  try {
    budget.take(key);
  } catch (error) {
    if (error instanceof McpBoundaryError && error.status === 429)
      throw new ExternalMcpError("EXTERNAL_MCP_RATE_LIMIT", 429);
    throw error;
  }
}
