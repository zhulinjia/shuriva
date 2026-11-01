import type { MutationClient } from "./client";
import type { Capability, Confirmation, Execution, Plan, Preview, TargetReceipt } from "./model";
import { hasUnresolved, isFrozen, terminalStates } from "./model.ts";

export type MutationView = {
  phase: "loading" | "recovery" | "draft" | "preview" | "confirming" | "reconciling" | "execution";
  capability: Capability | null;
  preview: Preview | null;
  pending: Confirmation | null;
  selected: Execution | null;
  records: Execution[];
  nextCursor: string | null;
  busy: boolean;
  recovered: boolean;
  message: string;
  receipts: TargetReceipt[];
  receiptCursor: string | null;
  receiptMetadataError: boolean;
};
export function initialMutationView(): MutationView {
  return {
    phase: "loading",
    capability: null,
    preview: null,
    pending: null,
    selected: null,
    records: [],
    nextCursor: null,
    busy: false,
    recovered: false,
    message: "",
    receipts: [],
    receiptCursor: null,
    receiptMetadataError: false,
  };
}

/** Browser memory projects server facts. Closing/refreshing this object never cancels or retries DML. */
export class MutationController {
  private view = initialMutationView();
  private generation = 0;
  private closed = false;
  private readonly client: MutationClient;
  private readonly update: (view: MutationView) => void;
  private readonly newId: () => string;
  constructor(
    client: MutationClient,
    update: (view: MutationView) => void,
    newId = () => crypto.randomUUID(),
  ) {
    this.client = client;
    this.update = update;
    this.newId = newId;
  }
  snapshot(): MutationView {
    return { ...this.view, records: [...this.view.records] };
  }
  private publish() {
    if (!this.closed) this.update(this.snapshot());
  }
  private active(token: number) {
    return !this.closed && this.generation === token;
  }
  private start(): number | null {
    if (this.closed || this.view.busy) return null;
    this.view = { ...this.view, busy: true, message: "" };
    this.publish();
    return this.generation;
  }
  private finish(token: number) {
    if (this.active(token)) {
      this.view = { ...this.view, busy: false };
      this.publish();
    }
  }
  private failure(error: unknown) {
    this.view = {
      ...this.view,
      message: error instanceof Error ? error.message : "操作尚未完成，请核对原记录。",
    };
  }
  private adopt(record: Execution) {
    this.view = {
      ...this.view,
      selected: record,
      phase: "execution",
      preview: null,
      capability:
        record.state === "outcome_unknown" && this.view.capability
          ? { ...this.view.capability, available: false, code: "frozen" }
          : this.view.capability,
      records: [
        record,
        ...this.view.records.filter((item) => item.executionId !== record.executionId),
      ],
    };
  }
  async prepare(): Promise<void> {
    if (
      this.view.pending &&
      (this.view.phase === "reconciling" || this.view.phase === "confirming")
    )
      return;
    const token = this.start();
    if (token === null) return;
    try {
      const capability = await this.client.capability();
      if (!this.active(token)) return;
      this.view = { ...this.view, capability, phase: "recovery" };
      if (capability.enabled) {
        const found = await this.client.executions();
        if (this.active(token))
          this.view = { ...this.view, records: found.items, nextCursor: found.nextCursor };
      }
    } catch (error) {
      if (this.active(token)) {
        this.failure(error);
        this.view = { ...this.view, phase: "recovery" };
      }
    } finally {
      this.finish(token);
    }
  }
  async recover(): Promise<void> {
    if (this.view.pending && this.view.phase === "reconciling") return;
    const token = this.start();
    if (token === null) return;
    try {
      const found = await this.client.recover();
      if (!this.active(token)) return;
      this.view = {
        ...this.view,
        recovered: true,
        records: found.items,
        nextCursor: found.nextCursor,
        receipts: found.recoveredReceipts ?? [],
        receiptCursor: found.receiptCursor ?? null,
        receiptMetadataError: this.view.receiptMetadataError || !!found.metadataError,
        preview: null,
        pending: null,
        selected: null,
        phase: "draft",
        message: "旧预览已封存。已登记操作仍按原编号核对。",
      };
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  canDraft(): boolean {
    return (
      !this.closed &&
      this.view.recovered &&
      this.view.receiptCursor === null &&
      !this.view.receiptMetadataError &&
      !!this.view.capability?.available &&
      !this.view.busy &&
      !hasUnresolved(this.view.records) &&
      this.view.phase !== "reconciling" &&
      this.view.phase !== "confirming"
    );
  }
  async preview(plan: Plan): Promise<void> {
    if (this.view.phase !== "draft" || !this.canDraft()) return;
    const token = this.start();
    if (token === null) return;
    try {
      const preview = await this.client.preview(plan);
      if (!this.active(token)) return;
      if (preview.operation !== plan.operation || preview.table !== plan.table)
        throw Error("预览与当前草稿不匹配，请重新核对。");
      this.view = { ...this.view, preview, pending: null, selected: null, phase: "preview" };
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async edit(): Promise<void> {
    const preview = this.view.preview;
    if (this.closed || this.view.busy || this.view.phase !== "preview" || !preview) return;
    const token = this.start();
    if (token === null) return;
    const pending: Confirmation = {
      confirmationId: this.newId(),
      previewId: preview.previewId,
      commitment: preview.commitment,
      revision: preview.revision,
    };
    this.view = { ...this.view, pending, phase: "reconciling" };
    this.publish();
    try {
      const response = await this.client.close(pending);
      if (!this.active(token)) return;
      if (response.execution) this.adopt(response.execution);
      else if (response.state === "closed")
        this.view = {
          ...this.view,
          preview: null,
          pending: null,
          phase: "draft",
          message: "旧预览已作废。编辑后需要重新生成预览并确认。",
        };
      else throw Error("尚未确认旧预览已作废，请继续核对。");
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async confirm(): Promise<void> {
    const p = this.view.preview;
    if (
      this.view.phase !== "preview" ||
      !p ||
      !this.view.capability?.executionEnabled ||
      !this.view.capability.available ||
      !this.view.recovered ||
      this.view.receiptMetadataError ||
      isFrozen(this.view.records) ||
      Date.parse(p.expiresAt) <= Date.now()
    )
      return;
    const token = this.start();
    if (token === null) return;
    const pending: Confirmation = {
      confirmationId: this.newId(),
      previewId: p.previewId,
      commitment: p.commitment,
      revision: p.revision,
    };
    this.view = { ...this.view, pending, phase: "confirming" };
    this.publish();
    try {
      const record = await this.client.confirm(pending);
      if (!this.active(token)) return;
      if (
        record.confirmationId !== pending.confirmationId ||
        record.previewId !== pending.previewId ||
        record.commitment !== pending.commitment ||
        record.revision !== pending.revision
      )
        throw Error("回执身份不匹配，请按原确认继续核对。");
      this.adopt(record);
    } catch (error) {
      if (this.active(token)) {
        this.failure(error);
        this.view = { ...this.view, phase: "reconciling" };
      }
    } finally {
      this.finish(token);
    }
  }
  async lookup(close = false): Promise<void> {
    const pending = this.view.pending;
    if (!pending || this.view.phase !== "reconciling") return;
    const token = this.start();
    if (token === null) return;
    try {
      const response = close
        ? await this.client.close(pending)
        : await this.client.lookup(pending.confirmationId);
      if (!this.active(token)) return;
      if (response.execution) {
        if (
          response.execution.previewId !== pending.previewId ||
          response.execution.commitment !== pending.commitment ||
          response.execution.revision !== pending.revision
        )
          throw Error("核对记录与原预览不符，请停止重复提交。");
        this.adopt(response.execution);
      } else if (response.state === "closed") {
        this.view = {
          ...this.view,
          phase: "draft",
          preview: null,
          pending: null,
          message: "本次待核对确认已封存，迟到确认无法登记。",
        };
      } else
        this.view = {
          ...this.view,
          message: "本次读取尚未见登记。原请求仍可能稍后到达，不能据此重新提交。",
        };
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async refresh(id?: string): Promise<void> {
    if (
      this.view.phase === "preview" ||
      this.view.phase === "reconciling" ||
      this.view.phase === "confirming"
    )
      return;
    const executionId = id ?? this.view.selected?.executionId;
    if (!executionId) return;
    const token = this.start();
    if (token === null) return;
    try {
      const record = await this.client.execution(executionId);
      if (!this.active(token)) return;
      if (record.executionId !== executionId) throw Error("返回的执行身份不匹配。");
      this.adopt(record);
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async cancel(): Promise<void> {
    const record = this.view.selected;
    if (
      !record ||
      record.permitIssued ||
      record.cancelRequested ||
      !["registered", "running"].includes(record.state)
    )
      return;
    const token = this.start();
    if (token === null) return;
    try {
      const response = await this.client.cancel(record.executionId);
      if (this.active(token)) {
        if (response.executionId !== record.executionId) throw Error("取消回执身份不匹配。");
        this.adopt(response);
        this.view = {
          ...this.view,
          message: "取消请求已登记，等待明确结果；这不代表数据库已经回滚。",
        };
      }
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async more(): Promise<void> {
    const after = this.view.nextCursor;
    if (!after) return;
    const token = this.start();
    if (token === null) return;
    try {
      const found = await this.client.executions(after);
      if (this.active(token))
        this.view = {
          ...this.view,
          records: [
            ...this.view.records,
            ...found.items.filter(
              (record) => !this.view.records.some((old) => old.executionId === record.executionId),
            ),
          ],
          nextCursor: found.nextCursor,
        };
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  async moreReceipts(): Promise<void> {
    const after = this.view.receiptCursor;
    if (!after) return;
    const token = this.start();
    if (token === null) return;
    try {
      const found = await this.client.receipts(after);
      if (this.active(token))
        this.view = {
          ...this.view,
          receipts: [
            ...this.view.receipts,
            ...found.items.filter(
              (record) => !this.view.receipts.some((old) => old.executionId === record.executionId),
            ),
          ],
          receiptCursor: found.nextCursor,
          receiptMetadataError: this.view.receiptMetadataError || !!found.metadataError,
        };
    } catch (error) {
      if (this.active(token)) this.failure(error);
    } finally {
      this.finish(token);
    }
  }
  newDraft(): void {
    if (
      this.view.phase !== "execution" ||
      !this.canDraft() ||
      (this.view.selected && !terminalStates.has(this.view.selected.state))
    )
      return;
    this.view = {
      ...this.view,
      selected: null,
      preview: null,
      pending: null,
      phase: "draft",
      message: "",
    };
    this.publish();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.client.dispose();
  }
}
