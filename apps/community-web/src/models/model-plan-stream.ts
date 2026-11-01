import { DefaultChatTransport } from "ai";
import { ApiError, apiResponse } from "../api.ts";
import { type GenerationStage, isGenerationStage } from "./model-progress.ts";

/** The SDK parses SSE; only validated terminal plans can leave this operation. No paid retry. */
export async function receiveModelPlan(
  path: string,
  payload: object,
  signal: AbortSignal,
  progress: (stage: GenerationStage) => void,
): Promise<{ plan: unknown }> {
  const transport = new DefaultChatTransport({
    api: path,
    headers: { accept: "text/event-stream" },
    prepareSendMessagesRequest: () => ({ body: payload }),
    fetch: async (input, init) => {
      const response = await apiResponse(input, init);
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("Invalid progress stream");
      }
      return response;
    },
  });
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: "plan",
    messageId: undefined,
    messages: [],
    abortSignal: signal,
  });
  const reader = stream.getReader();
  let plan: unknown,
    received = false,
    finished = false,
    count = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("cancelled");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("cancelled");
      if (done) break;
      if (++count > 32 || finished) throw new Error("Invalid progress stream");
      if (value.type === "data-progress") {
        const data = value.data;
        if (
          received ||
          !data ||
          typeof data !== "object" ||
          !("stage" in data) ||
          !isGenerationStage(data.stage)
        )
          throw new Error("Invalid progress stream");
        progress(data.stage);
      } else if (value.type === "data-plan") {
        const data = value.data;
        if (received || !data || typeof data !== "object" || !("plan" in data))
          throw new Error("Invalid progress stream");
        plan = data.plan;
        received = true;
      } else if (value.type === "data-failure") {
        const data = value.data;
        const status =
          data && typeof data === "object" && "status" in data ? data.status : undefined;
        if (
          typeof status !== "number" ||
          ![400, 401, 403, 404, 409, 422, 429, 503].includes(status)
        )
          throw new Error("Invalid progress stream");
        throw new ApiError(status, "模型请求未完成");
      } else if (value.type === "finish") finished = true;
      else if (value.type !== "start") throw new Error("Invalid progress stream");
    }
    if (!received || !finished) throw new Error("Model progress interrupted");
    return { plan };
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
