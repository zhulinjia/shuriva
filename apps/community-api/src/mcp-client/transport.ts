import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type Transport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import { decodeJson, inspectJson } from "./limits.js";
import { ExternalMcpError } from "./model.js";
import type { Discovery } from "./discovery.js";
/** Snapshot once; the SDK transports subsequently serialize only this immutable value. */
function immutableWireMessage(message: JSONRPCMessage): JSONRPCMessage {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(message);
  } catch {
    throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
  }
  if (encoded === undefined) throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
  const value = decodeJson(Buffer.from(encoded));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Reflect.has(value, "jsonrpc") ||
    Reflect.get(value, "jsonrpc") !== "2.0" ||
    !(
      isJSONRPCRequest(value as JSONRPCMessage) ||
      isJSONRPCNotification(value as JSONRPCMessage) ||
      isJSONRPCResultResponse(value as JSONRPCMessage) ||
      isJSONRPCErrorResponse(value as JSONRPCMessage)
    )
  )
    throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
  const stack: object[] = [value];
  while (stack.length) {
    const item = stack.pop();
    if (!item) break;
    for (const child of Object.values(item))
      if (child && typeof child === "object") stack.push(child);
    Object.setPrototypeOf(item, null);
    Object.freeze(item);
  }
  return value as JSONRPCMessage;
}
/** Validate correlated tool listings before the SDK compiles/caches them or
 * emits warnings containing remote tool names. No method is inferred from a URL. */
export function validatedTransport(
  raw: Transport,
  dispatch: (work: () => Promise<void>, method?: string) => Promise<void> = (work) => work(),
  discovery: () => Discovery | undefined = () => undefined,
  toolsChanged: () => void = () => {},
  cleanupFailed: () => void = () => {},
  authorizeCall: (message: JSONRPCMessage) => void = () => {
    throw new ExternalMcpError("EXTERNAL_MCP_CALL_SAFETY_UNAVAILABLE", 503);
  },
): Transport {
  const pending = new Map<string | number, { method: string; discovery?: Discovery }>();
  let failed = false;
  let cleanup: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const closeRaw = () => {
    if (!cleanup) {
      cleanup = Promise.resolve()
        .then(() => raw.close())
        .catch(() => {
          cleanupFailed();
          throw new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503);
        });
      // Ownership remains with close(); observing the rejection here prevents an
      // unhandled rejection while an asynchronous transport error is delivered.
      void cleanup.catch(() => {});
    }
    return cleanup;
  };
  const closeAfterError = () => {
    void closeRaw().catch(() =>
      value.onerror?.(new ExternalMcpError("EXTERNAL_MCP_CLEANUP_UNKNOWN", 503)),
    );
  };
  const value: Transport = {
    start: () =>
      dispatch(async () => {
        try {
          await raw.start();
        } catch {
          throw new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502);
        }
      }),
    send(message: JSONRPCMessage, options?: TransportSendOptions) {
      const safeMessage = immutableWireMessage(message);
      return dispatch(
        async () => {
          if (failed) throw new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502);
          // Defense in depth: even a caller holding the SDK client cannot send a tool call.
          if ("method" in safeMessage && safeMessage.method === "tools/call")
            authorizeCall(safeMessage);
          if (isJSONRPCRequest(safeMessage)) {
            if (pending.size >= 32)
              throw new ExternalMcpError("EXTERNAL_MCP_REQUEST_CAPACITY", 429);
            if (pending.has(safeMessage.id)) {
              discovery()?.invalidate();
              throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
            }
            const current = safeMessage.method === "tools/list" ? discovery() : undefined;
            if (safeMessage.method === "tools/list") {
              if (!current) throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
              current.request(safeMessage.params?.cursor);
            }
            pending.set(safeMessage.id, { method: safeMessage.method, discovery: current });
          }
          try {
            await raw.send(safeMessage, options);
          } catch {
            if (isJSONRPCRequest(safeMessage)) pending.delete(safeMessage.id);
            throw new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502);
          }
        },
        "method" in safeMessage ? safeMessage.method : undefined,
      );
    },
    close() {
      if (!closing) {
        failed = true;
        pending.clear();
        closing = closeRaw();
      }
      return closing;
    },
    get sessionId() {
      return raw.sessionId;
    },
    setProtocolVersion: (version) => raw.setProtocolVersion?.(version),
  };
  raw.onmessage = (message) => {
    if (failed) return;
    try {
      inspectJson(message);
      if (isJSONRPCNotification(message) && message.method === "notifications/tools/list_changed") {
        discovery()?.invalidate();
        toolsChanged();
      }
      if (isJSONRPCResultResponse(message)) {
        const request = pending.get(message.id);
        if (!request) throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
        pending.delete(message.id);
        if (request?.method === "tools/list") {
          if (!request.discovery || request.discovery !== discovery())
            throw new ExternalMcpError("EXTERNAL_MCP_TOOL_REJECTED");
          message.result.tools = request.discovery.page(message.result);
        }
      } else if (isJSONRPCErrorResponse(message)) {
        if (message.id === undefined || !pending.has(message.id))
          throw new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED");
        pending.delete(message.id);
      }
      value.onmessage?.(message);
    } catch {
      failed = true;
      discovery()?.invalidate();
      value.onerror?.(new ExternalMcpError("EXTERNAL_MCP_RESPONSE_REJECTED"));
      closeAfterError();
    }
  };
  raw.onerror = () => {
    failed = true;
    discovery()?.invalidate();
    value.onerror?.(new ExternalMcpError("EXTERNAL_MCP_NETWORK_FAILED", 502));
    closeAfterError();
  };
  raw.onclose = () => {
    failed = true;
    pending.clear();
    value.onclose?.();
  };
  return value;
}
