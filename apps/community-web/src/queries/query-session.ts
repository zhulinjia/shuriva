import { ApiError, api, post } from "../api.ts";
import { decodeQueryResult, type QueryResult } from "./query-result.ts";

export type QueryPhase =
  | "idle"
  | "submitting"
  | "queued"
  | "running"
  | "reconnecting"
  | "unknown"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";
export type QueryView = {
  phase: QueryPhase;
  message: string;
  notice: string;
  result: QueryResult | null;
  canCancel: boolean;
  cancelling: boolean;
  scopeStatus: "loading" | "ready" | "unavailable" | "stale";
};
export type QueryRequest = {
  sql: string;
  parameters: { kind: string; value: string }[];
  maxRows: number;
  schemaVersion?: string | null;
};
type QueryTransport = {
  scope(): Promise<unknown>;
  create(request: CreateRequest): Promise<unknown>;
  status(id: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>;
};
type DraftRequest = QueryRequest & { requestId: string; submittedAt: number };
type CreateRequest = DraftRequest & { instanceId: string; scopeToken: string };
type Scheduler = { schedule(fn: () => void): number; clear(id: number): void; now(): number };

const failureMessages: Record<string, string> = {
  denied: "查询未通过授权或安全检查。请确认表、字段及本机只读范围。",
  unavailable: "连接器或数据库环境暂不支持只读查询。",
  timeout: "查询超时，请缩小查询范围后重试。",
  cancelled: "查询已取消。",
  error: "查询未完成，请检查连接和输入后重试。",
  outcome_unknown:
    "连接器已重启，原查询可能已经执行，但结果无法确认；系统不会自动重跑。请核对后再重新查询。",
  schema_changed: "数据表结构已变化，请重新生成查询计划后再执行。",
};
const initial: QueryView = {
  phase: "idle",
  message: "",
  notice: "",
  result: null,
  canCancel: false,
  cancelling: false,
  scopeStatus: "loading",
};

export function queryTransport(base: string): QueryTransport {
  return {
    scope: () => api<unknown>(`${base}/scope`, { signal: AbortSignal.timeout(5000) }),
    create: (request) =>
      api<unknown>(base, { ...post(request), signal: AbortSignal.timeout(10_000) }),
    status: (id) =>
      api<unknown>(`${base}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) }),
    cancel: (id) =>
      api<unknown>(`${base}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      }),
  };
}

/** Owns one scope-bound in-memory task. Closing invalidates all late responses. */
export class QuerySession {
  private generation = 0;
  private timer: number | undefined;
  private active: string | null = null;
  private resultId: string | null = null;
  private scopeValue: { instanceId: string; scopeToken: string } | null = null;
  private scopeLoading = false;
  private pendingCreate: CreateRequest | null = null;
  private pendingSince = 0;
  private closed = false;
  private view: QueryView = initial;
  private readonly transport: QueryTransport;
  private readonly publish: (value: QueryView) => void;
  private readonly clock: Scheduler;
  private readonly newId: () => string;
  constructor(
    transport: QueryTransport,
    publish: (value: QueryView) => void,
    clock: Scheduler = {
      schedule: (fn) => window.setTimeout(fn, 1000),
      clear: (id) => window.clearTimeout(id),
      now: Date.now,
    },
    newId: () => string = () => crypto.randomUUID(),
  ) {
    this.transport = transport;
    this.publish = publish;
    this.clock = clock;
    this.newId = newId;
  }

  private update(next: Partial<QueryView>) {
    this.view = { ...this.view, ...next };
    if (!this.closed) this.publish(this.view);
  }
  private valid(generation: number) {
    return !this.closed && generation === this.generation;
  }
  private stopTimer() {
    if (this.timer !== undefined) this.clock.clear(this.timer);
    this.timer = undefined;
  }
  private schedule(id: string, generation: number, started: number) {
    this.timer = this.clock.schedule(() => void this.poll(id, generation, started));
  }

  /** Obtain authorization before user intent; never refresh it after submission. */
  async prepare(): Promise<void> {
    if (this.closed || this.scopeLoading || this.scopeValue || this.view.scopeStatus === "stale")
      return;
    this.scopeLoading = true;
    this.update({ scopeStatus: "loading" });
    try {
      const response = await this.transport.scope();
      if (
        !response ||
        typeof response !== "object" ||
        !("instanceId" in response) ||
        typeof response.instanceId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          response.instanceId,
        ) ||
        !("scopeToken" in response) ||
        typeof response.scopeToken !== "string" ||
        response.scopeToken.length < 1 ||
        response.scopeToken.length > 1024
      )
        throw new Error("invalid scope");
      if (this.closed) return;
      this.scopeValue = { instanceId: response.instanceId, scopeToken: response.scopeToken };
      this.update({ scopeStatus: "ready" });
    } catch {
      if (!this.closed) this.update({ scopeStatus: "unavailable" });
    } finally {
      this.scopeLoading = false;
    }
  }

  async start(request: QueryRequest): Promise<void> {
    if (
      this.closed ||
      this.active ||
      !this.scopeValue ||
      this.pendingCreate ||
      this.view.phase === "submitting" ||
      this.view.cancelling
    )
      return;
    this.releaseResult();
    const generation = ++this.generation;
    this.pendingSince = this.clock.now();
    this.pendingCreate = {
      ...request,
      schemaVersion: request.schemaVersion ?? null,
      parameters: request.parameters.map((p) => ({ ...p })),
      requestId: this.newId(),
      submittedAt: this.pendingSince,
      ...this.scopeValue,
    };
    this.update({ phase: "submitting", message: "", result: null, canCancel: false });
    await this.sendCreate(this.pendingCreate, generation, this.pendingSince);
  }

  private async sendCreate(
    request: CreateRequest,
    generation: number,
    started: number,
  ): Promise<void> {
    if (this.clock.now() - started >= 120_000) {
      this.pendingCreate = null;
      this.update({
        phase: "failed",
        canCancel: false,
        message: "提交状态长时间无法确认，原任务可能已经执行。请先核对结果，再决定是否发起新查询。",
      });
      return;
    }
    try {
      const response = await this.transport.create(request);
      if (
        !response ||
        typeof response !== "object" ||
        !("id" in response) ||
        typeof response.id !== "string" ||
        response.id !== request.requestId
      )
        throw new Error("invalid response");
      if (!this.valid(generation)) {
        void this.transport.cancel(response.id).catch(() => {});
        return;
      }
      this.pendingCreate = null;
      this.active = response.id;
      this.update({ phase: "queued", canCancel: true });
      void this.poll(response.id, generation, this.clock.now());
    } catch (error) {
      if (!this.valid(generation)) return;
      if (
        error instanceof ApiError &&
        error.status === 503 &&
        (error.code === "CAPACITY" || error.code === "RESULT_CAPACITY")
      ) {
        this.pendingCreate = null;
        this.update({
          phase: "failed",
          message:
            error.code === "RESULT_CAPACITY"
              ? "已保留的查询结果达到上限，请清除不再需要的结果或等待结果过期后重试。"
              : "查询任务暂时达到容量上限，请等待已有任务结束或稍后再试。",
        });
        return;
      }
      if (error instanceof ApiError && [400, 401, 403, 404, 409, 413].includes(error.status)) {
        this.pendingCreate = null;
        if ([401, 403, 404, 409].includes(error.status)) this.scopeValue = null;
        this.update({
          phase: "failed",
          ...([401, 403, 404, 409].includes(error.status) ? { scopeStatus: "stale" as const } : {}),
          message:
            error.status === 404
              ? "只读查询尚未启用或当前数据源不可用。"
              : error.status === 409
                ? "服务已重启或请求已失效，原任务可能已经执行。请先核对结果，刷新页面后再决定是否发起新查询。"
                : error.status === 413
                  ? "SQL 和参数内容过大，请减少内容后重新提交。"
                  : error.status === 400
                    ? "输入不符合查询要求，请检查 SQL、参数和行数。"
                    : "登录或访问权限已失效，请重新登录并检查授权。",
        });
      } else if (this.clock.now() - started > 90_000) {
        this.update({
          phase: "unknown",
          message: "暂时无法确认提交结果。恢复连接后可继续确认，系统不会重复创建查询。",
        });
      } else {
        this.update({
          phase: "reconnecting",
          message: "连接暂时中断，正在确认原查询，不会重复创建任务。",
        });
        this.timer = this.clock.schedule(() => void this.sendCreate(request, generation, started));
      }
    }
  }

  private async poll(id: string, generation: number, started: number): Promise<void> {
    try {
      const response = await this.transport.status(id);
      if (!this.valid(generation)) return;
      if (!response || typeof response !== "object" || Array.isArray(response))
        throw new Error("invalid response");
      const value = response as Record<string, unknown>;
      if (
        typeof value.state !== "string" ||
        !["queued", "running", "completed", "failed", "cancelled", "expired"].includes(
          value.state,
        ) ||
        (value.payload !== undefined && typeof value.payload !== "string")
      )
        throw new Error("invalid response");
      if (value.state === "queued" || value.state === "running") {
        this.update({ phase: value.state, message: "" });
        this.schedule(id, generation, started);
        return;
      }
      this.active = null;
      if (value.state === "completed") {
        if (typeof value.payload !== "string") throw new Error("invalid result");
        let result: QueryResult;
        try {
          result = decodeQueryResult(value.payload);
        } catch {
          throw new Error("invalid result");
        }
        this.resultId = id;
        this.update({ phase: "completed", message: "", result, canCancel: false });
      } else {
        const phase = value.state as "failed" | "cancelled" | "expired";
        const message =
          phase === "failed"
            ? (failureMessages[typeof value.payload === "string" ? value.payload : ""] ??
              failureMessages.error)
            : phase === "expired"
              ? "任务已过期，请重新提交。"
              : "查询已取消。";
        this.update({ phase, message, result: null, canCancel: false });
      }
    } catch (error) {
      if (!this.valid(generation)) return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        this.active = null;
        this.update({
          phase: "failed",
          result: null,
          canCancel: false,
          message:
            error.status === 404
              ? "任务不存在或授权已变化，请刷新后重新提交。"
              : "登录或访问权限已失效，请重新登录并检查授权。",
        });
      } else if (error instanceof Error && error.message.startsWith("invalid")) {
        this.active = null;
        this.update({
          phase: "failed",
          result: null,
          canCancel: false,
          message: "查询结果格式无法验证，已丢弃。",
        });
      } else if (this.clock.now() - started > 90_000) {
        this.update({
          phase: "unknown",
          result: null,
          message: "暂时无法确认任务状态。恢复连接后可继续查看，系统不会自动重新执行查询。",
        });
      } else {
        this.update({
          phase: "reconnecting",
          result: null,
          message: "连接暂时中断，正在重新获取任务状态，不会重新提交查询。",
        });
        this.schedule(id, generation, started);
      }
    }
  }

  resume(): void {
    if (!this.closed && this.pendingCreate && this.view.phase === "unknown") {
      this.update({ phase: "reconnecting", message: "正在确认原查询，不会重复创建任务。" });
      void this.sendCreate(this.pendingCreate, this.generation, this.pendingSince);
      return;
    }
    if (!this.closed && this.active && this.view.phase === "unknown") {
      this.update({ phase: "reconnecting", message: "正在重新获取任务状态，不会重新提交查询。" });
      void this.poll(this.active, this.generation, this.clock.now());
    }
  }
  clear(): void {
    if (!this.active && !this.closed) {
      this.update({ ...initial, scopeStatus: this.view.scopeStatus });
      this.releaseResult();
    }
  }

  private releaseResult(): void {
    const id = this.resultId;
    this.resultId = null;
    if (id)
      void this.transport.cancel(id).catch(() => {
        if (!this.closed) this.update({ notice: "服务端结果暂未清除，将在保留期结束后自动清理。" });
      });
  }

  async cancel(): Promise<void> {
    const id = this.active;
    if (!id || this.closed || this.view.cancelling) return;
    const generation = ++this.generation;
    this.stopTimer();
    this.active = null;
    this.update({ result: null, cancelling: true, canCancel: false, message: "" });
    try {
      await this.transport.cancel(id);
      if (this.valid(generation))
        this.update({
          phase: "cancelled",
          message: "已请求取消查询；数据库中等待锁的操作可能稍后才结束。",
        });
    } catch {
      if (this.valid(generation)) {
        this.active = id;
        this.update({
          phase: "unknown",
          canCancel: true,
          message: "无法确认取消结果，本地结果已清除；恢复连接后可重试取消或查看状态。",
        });
      }
    } finally {
      if (this.valid(generation)) this.update({ cancelling: false });
    }
  }

  close(): void {
    this.closed = true;
    this.generation++;
    this.stopTimer();
    const id = this.active;
    const pending = this.pendingCreate;
    this.active = null;
    this.scopeValue = null;
    this.pendingCreate = null;
    this.view = initial;
    this.releaseResult();
    if (id) void this.transport.cancel(id).catch(() => {});
    if (pending) void this.transport.cancel(pending.requestId).catch(() => {});
  }
}
