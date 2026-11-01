import { ApiError, api, post } from "../api.ts";
import type { PreparationStage } from "./model-progress.ts";

export type ModelPreview = {
  schema: {
    database: string;
    tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>;
  };
  schemaHash: string;
  destination: { baseUrl: string; model: string; configVersion: string };
  semantics?: {
    entities: Array<{ name: string; description: string; aliases: string[]; table: string }>;
    fields: Array<{
      name: string;
      description: string;
      aliases: string[];
      table: string;
      column: string;
    }>;
    relationships: Array<{
      name: string;
      description: string;
      aliases: string[];
      from: { table: string; column: string };
      to: { table: string; column: string };
    }>;
    metrics: Array<{
      name: string;
      description: string;
      aliases: string[];
      field: { table: string; column: string };
      aggregation: string;
    }>;
  };
};
export type QueryScope = { instanceId: string; scopeToken: string };
type TaskStatus = { state: string };
type Create = QueryScope & { requestId: string; submittedAt: number };
export type ModelTransport = {
  scope(signal: AbortSignal): Promise<QueryScope>;
  create(input: Create, signal: AbortSignal): Promise<unknown>;
  status(id: string, signal: AbortSignal): Promise<TaskStatus>;
  preview(id: string, signal: AbortSignal): Promise<ModelPreview>;
};

/** Abort the transport and settle even if a proxy never sends response headers. */
export async function withRequestTimeout<T>(
  signal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new Error("cancelled");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("request timeout"));
    }, timeoutMs);
  });
  const rejectOnAbort = () => rejectAbort(new Error("cancelled"));
  signal.addEventListener("abort", rejectOnAbort, { once: true });
  try {
    if (signal.aborted) throw new Error("cancelled");
    return await Promise.race([
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("cancelled");
        return operation(controller.signal);
      }),
      stopped,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    signal.removeEventListener("abort", rejectOnAbort);
  }
}

export function modelTransport(base: string): ModelTransport {
  return {
    scope: (signal) => api(`${base}/scope`, { signal }),
    create: (input, signal) => api(`${base}/model-schema`, { ...post(input), signal }),
    status: (id, signal) => api(`${base}/${id}`, { signal }),
    preview: (id, signal) => api(`${base}/${id}/model-preview`, { signal }),
  };
}

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function permanent(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    ([400, 401, 403, 404, 409, 413, 429].includes(error.status) ||
      (error.status === 503 && !!error.code))
  );
}

/** Reuses the same task identity on uncertain submission and only reads a fresh preview. */
export async function prepareModelSchema(
  transport: ModelTransport,
  id: string,
  signal: AbortSignal,
  options: {
    now?: () => number;
    delay?: (signal: AbortSignal) => Promise<void>;
    requestTimeoutMs?: number;
    totalTimeoutMs?: number;
    onProgress?: (stage: PreparationStage) => void;
  } = {},
): Promise<{ scope: QueryScope; preview: ModelPreview }> {
  const now = options.now ?? Date.now;
  const delay = options.delay ?? wait;
  const deadline = now() + (options.totalTimeoutMs ?? 55_000);
  const request = <T>(operation: (requestSignal: AbortSignal) => Promise<T>) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("schema timeout");
    return withRequestTimeout(
      signal,
      Math.min(options.requestTimeoutMs ?? 8_000, remaining),
      operation,
    );
  };
  options.onProgress?.("checking_access");
  const scope = await request((requestSignal) => transport.scope(requestSignal));
  if (signal.aborted) throw new Error("cancelled");
  const payload = { requestId: id, ...scope, submittedAt: now() };
  options.onProgress?.("submitting_schema");
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw new Error("cancelled");
    try {
      await request((requestSignal) => transport.create(payload, requestSignal));
      break;
    } catch (error) {
      if (signal.aborted || permanent(error) || attempt >= 2) throw error;
      await delay(signal);
    }
  }
  options.onProgress?.("waiting_connector");
  let running = false;
  while (now() < deadline) {
    if (signal.aborted) throw new Error("cancelled");
    try {
      const status = await request((requestSignal) => transport.status(id, requestSignal));
      if (status.state === "running" && !running) {
        running = true;
        options.onProgress?.("reading_schema");
      }
      if (status.state === "completed") {
        if (signal.aborted) throw new Error("cancelled");
        options.onProgress?.("building_preview");
        return {
          scope,
          preview: await request((requestSignal) => transport.preview(id, requestSignal)),
        };
      }
      if (!["queued", "running"].includes(status.state)) throw new Error("schema unavailable");
    } catch (error) {
      if (
        signal.aborted ||
        permanent(error) ||
        (error instanceof Error && error.message === "schema unavailable")
      )
        throw error;
    }
    await delay(signal);
  }
  throw new Error("schema timeout");
}
