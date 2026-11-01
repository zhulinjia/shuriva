import { Button } from "@workspace/ui";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import {
  confirmSemanticLeave,
  emptySemanticGuard,
  type SemanticGuard,
  semanticEntryKey,
  updateSemanticEntry,
} from "./semantic-editor";

type Ref = { table: string; column: string; type: string };
type Named = {
  name: string;
  description: string;
  aliases: string[];
  sensitivity: "normal" | "sensitive";
};
type Entity = Named & { table: string };
type Field = Named & Ref;
type Relation = Named & { from: Ref; to: Ref };
type Metric = Named & { field: Ref; aggregation: "count" | "sum" | "avg" | "min" | "max" };
type Document = {
  entities: Entity[];
  fields: Field[];
  relationships: Relation[];
  metrics: Metric[];
};
type Snapshot = {
  tables: Array<{ name: string; kind: string }>;
  columns: Array<{ table: string; name: string; type: string }>;
};
type State = {
  revision: number;
  snapshotId: string | null;
  basedOnSnapshotId: string | null;
  document: Document;
  stale: string[];
  snapshot: Snapshot | null;
};
type Kind = keyof Document;
const labels: Record<Kind, string> = {
  entities: "实体",
  fields: "字段",
  relationships: "关系",
  metrics: "指标",
};
/** Semantic definitions describe meaning, not authorization or executable SQL. */
export function SemanticPanel({
  workspaceId,
  sourceId,
  sourceName,
  unavailable = false,
  interactionBlocked = false,
  onGuardChange,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  unavailable?: boolean;
  interactionBlocked?: boolean;
  onGuardChange?: (guard: SemanticGuard) => void;
}) {
  const base = `/api/semantics/${encodeURIComponent(workspaceId)}/${encodeURIComponent(sourceId)}`;
  const [state, setState] = useState<State | null>(null);
  const [document, setDocument] = useState<Document | null>(null);
  const [kind, setKind] = useState<Kind>("entities");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [sensitivity, setSensitivity] = useState<Named["sensitivity"]>("sensitive");
  const [table, setTable] = useState("");
  const [column, setColumn] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [targetColumn, setTargetColumn] = useState("");
  const [aggregation, setAggregation] = useState<Metric["aggregation"]>("sum");
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState(false);
  const busy = saving || reading || interactionBlocked;
  const loadSequence = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState("正在读取业务语义…");
  const formPending =
    editing !== null ||
    !!(name || description || aliases || table || column || targetTable || targetColumn) ||
    sensitivity !== "sensitive" ||
    aggregation !== "sum";
  const clearForm = useCallback(() => {
    setEditing(null);
    setName("");
    setDescription("");
    setAliases("");
    setSensitivity("sensitive");
    setTable("");
    setColumn("");
    setTargetTable("");
    setTargetColumn("");
    setAggregation("sum");
  }, []);
  const pending = dirty || formPending;
  useEffect(() => {
    onGuardChange?.({ pending, busy });
  }, [pending, busy, onGuardChange]);
  useEffect(() => () => onGuardChange?.(emptySemanticGuard()), [onGuardChange]);
  useEffect(() => {
    if (!pending && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending, saving]);
  const discardForm = () => confirmSemanticLeave({ pending: formPending, busy }, window);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++loadSequence.current;
      setReading(true);
      try {
        const timeout = AbortSignal.timeout(8000);
        const result = await api<State>(base, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (signal?.aborted || request !== loadSequence.current) return false;
        setState(result);
        setDocument(result.document);
        clearForm();
        setDirty(false);
        setMessage(result.snapshotId ? "" : "请先扫描数据源结构，再配置业务语义。");
        return true;
      } catch (error) {
        if (signal?.aborted || request !== loadSequence.current) return false;
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
          setState(null);
          setDocument(null);
          setDirty(false);
          clearForm();
        }
        setMessage(
          error instanceof ApiError && error.status === 404
            ? "语义功能未启用，或该数据源不再绑定此工作空间。"
            : "无法读取业务语义，请检查连接后重试。",
        );
        return false;
      } finally {
        if (request === loadSequence.current) setReading(false);
      }
    },
    [base, clearForm],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
      loadSequence.current++;
    };
  }, [load]);
  const tables = state?.snapshot?.tables.filter((item) => item.kind === "BASE TABLE") ?? [];
  const columns = state?.snapshot?.columns ?? [];
  const physical = (whichTable: string, whichColumn: string): Ref | null => {
    const item = columns.find((entry) => entry.table === whichTable && entry.name === whichColumn);
    return item ? { table: item.table, column: item.name, type: item.type } : null;
  };
  function edit(key: string) {
    if (!document || !discardForm()) return;
    const item = document[kind].find((entry) => semanticEntryKey(entry) === key);
    if (!item) return;
    clearForm();
    setEditing(key);
    setName(item.name);
    setDescription(item.description);
    setAliases(item.aliases.join("，"));
    setSensitivity(item.sensitivity);
    if ("table" in item) {
      setTable(item.table);
      setColumn("column" in item ? item.column : "");
    } else if ("from" in item) {
      setTable(item.from.table);
      setColumn(item.from.column);
      setTargetTable(item.to.table);
      setTargetColumn(item.to.column);
    } else {
      setTable(item.field.table);
      setColumn(item.field.column);
      setAggregation(item.aggregation);
    }
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (!document || !name.trim()) return;
    const common: Named = {
      name: name.trim(),
      description: description.trim(),
      aliases: aliases
        .split(/[，,]/)
        .map((item) => item.trim())
        .filter(Boolean),
      sensitivity,
    };
    const from = physical(table, column),
      to = physical(targetTable, targetColumn);
    let item: Entity | Field | Relation | Metric;
    if (kind === "entities") {
      if (!tables.some((entry) => entry.name === table)) {
        setMessage("请选择有效的表。");
        return;
      }
      item = { ...common, table };
    } else if (kind === "fields") {
      if (!from) {
        setMessage("请选择有效的字段。");
        return;
      }
      item = { ...common, ...from };
    } else if (kind === "relationships") {
      if (!from || !to) {
        setMessage("请选择关系两端的字段。");
        return;
      }
      item = { ...common, from, to };
    } else {
      if (!from) {
        setMessage("请选择指标字段。");
        return;
      }
      if (
        ["sum", "avg"].includes(aggregation) &&
        !/^(?:tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real)\b/i.test(
          from.type,
        )
      ) {
        setMessage("求和和平均值需要选择数字类型的字段。");
        return;
      }
      item = { ...common, field: from, aggregation };
    }
    let list: Array<Entity | Field | Relation | Metric>;
    try {
      list = updateSemanticEntry<Entity | Field | Relation | Metric>(document[kind], editing, item);
    } catch (error) {
      setMessage(
        error instanceof Error && error.message === "ENTRY_CHANGED"
          ? "正在编辑的定义已变化，请重新选择要编辑的项目。"
          : "该定义已存在，请编辑现有项。",
      );
      return;
    }
    setDocument({ ...document, [kind]: list });
    setDirty(true);
    setMessage("更改尚未保存。");
    clearForm();
  }
  function remove(key: string) {
    if (!document || !discardForm()) return;
    setDocument({
      ...document,
      [kind]: document[kind].filter((entry) => semanticEntryKey(entry) !== key),
    });
    setDirty(true);
    setMessage("更改尚未保存。");
    clearForm();
  }
  async function save() {
    if (!state?.snapshotId || !document || busy) return;
    setSaving(true);
    setMessage("");
    try {
      await api(base, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: state.revision, snapshotId: state.snapshotId, document }),
        signal: AbortSignal.timeout(10000),
      });
      if (await load()) setMessage("业务语义已保存。已有 AI 发送预览需要重新获取。");
      else setMessage("业务语义已保存，但读取最新状态失败，请重新读取。");
    } catch (error) {
      setMessage(
        error instanceof ApiError && error.status === 409
          ? "语义或结构已变化。请先重新读取，再核对后保存。"
          : error instanceof ApiError && [400, 401, 403, 404, 413].includes(error.status)
            ? "保存失败，请检查输入及访问权限后重试。"
            : "保存未确认：可能已生效，请重新读取并核对后再操作。",
      );
    } finally {
      setSaving(false);
    }
  }
  if (unavailable)
    return (
      <section className="settings-card" role="status">
        暂时无法确认数据源绑定，未保存的语义输入会保留，连接恢复后可继续。
      </section>
    );
  return (
    <section className="settings-card" aria-label="业务语义管理">
      <h2>{sourceName} · 业务语义</h2>
      <p>
        业务说明可帮助 AI
        理解字段，不授予查询权限。敏感标记的内容不会发送给模型；请勿将敏感信息写入非敏感说明。关系和指标当前仅供理解，不自动执行关联或聚合。
      </p>
      {message && <p role="status">{message}</p>}
      {interactionBlocked && <p role="status">正在处理数据源操作，请稍候再编辑业务语义。</p>}
      {state?.stale.length ? (
        <div role="alert">
          <p>以下语义引用的表、字段或类型已变化，请编辑或移除后保存：</p>
          <ul>
            {state.stale.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Button
        type="button"
        disabled={busy}
        onClick={() => {
          if (confirmSemanticLeave({ pending, busy }, window)) void load();
        }}
      >
        {dirty || formPending ? "重新读取（丢弃未保存内容）" : "重新读取"}
      </Button>{" "}
      <Button
        type="button"
        className="product-primary"
        disabled={busy || !dirty || !state?.snapshotId || formPending}
        onClick={() => void save()}
      >
        保存业务语义
      </Button>
      {state && (
        <p>
          语义版本 {state.revision}；
          {state.basedOnSnapshotId && state.basedOnSnapshotId !== state.snapshotId
            ? "结构已更新，请核对标记。"
            : "基于当前结构快照。"}
        </p>
      )}
      {dirty && formPending && <p>请先将当前输入添加到待保存列表，或清空当前输入。</p>}
      {document && state?.snapshot && (
        <>
          <label>
            语义类型{" "}
            <select
              value={kind}
              disabled={busy}
              onChange={(event) => {
                if (!discardForm()) return;
                setKind(event.target.value as Kind);
                clearForm();
              }}
            >
              {(Object.keys(labels) as Kind[]).map((key) => (
                <option key={key} value={key}>
                  {labels[key]}
                </option>
              ))}
            </select>
          </label>
          {document[kind].length ? (
            <ul>
              {document[kind].map((item) => (
                <li key={semanticEntryKey(item)}>
                  {item.name}（{item.sensitivity === "sensitive" ? "敏感，不发送" : "非敏感"}）{" "}
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => edit(semanticEntryKey(item))}
                  >
                    编辑
                  </Button>{" "}
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={() => remove(semanticEntryKey(item))}
                  >
                    移除
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>暂无{labels[kind]}定义。</p>
          )}
          <form className="product-form" onSubmit={apply}>
            <fieldset
              className="product-form"
              disabled={busy}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <h3>
                {editing === null ? "添加" : "编辑"}
                {labels[kind]}
              </h3>
              <label>
                业务名称
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                业务说明
                <textarea
                  maxLength={1000}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <label>
                同义词（用逗号分隔）
                <input value={aliases} onChange={(event) => setAliases(event.target.value)} />
              </label>
              <label>
                敏感级别
                <select
                  value={sensitivity}
                  onChange={(event) => setSensitivity(event.target.value as Named["sensitivity"])}
                >
                  <option value="normal">非敏感</option>
                  <option value="sensitive">敏感，不发送模型</option>
                </select>
              </label>
              <label>
                {kind === "relationships" ? "来源表" : "数据库表"}
                <select
                  required
                  value={table}
                  onChange={(event) => {
                    setTable(event.target.value);
                    setColumn("");
                  }}
                >
                  <option value="">请选择</option>
                  {tables.map((entry) => (
                    <option key={entry.name} value={entry.name}>
                      {entry.name}
                    </option>
                  ))}
                </select>
              </label>
              {kind !== "entities" && (
                <label>
                  {kind === "relationships" ? "来源字段" : "数据库字段"}
                  <select
                    required
                    value={column}
                    onChange={(event) => setColumn(event.target.value)}
                  >
                    <option value="">请选择</option>
                    {columns
                      .filter((item) => item.table === table)
                      .map((item) => (
                        <option key={item.name} value={item.name}>
                          {item.name} · {item.type}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {kind === "relationships" && (
                <>
                  <label>
                    目标表
                    <select
                      required
                      value={targetTable}
                      onChange={(event) => {
                        setTargetTable(event.target.value);
                        setTargetColumn("");
                      }}
                    >
                      <option value="">请选择</option>
                      {tables.map((entry) => (
                        <option key={entry.name} value={entry.name}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    目标字段
                    <select
                      required
                      value={targetColumn}
                      onChange={(event) => setTargetColumn(event.target.value)}
                    >
                      <option value="">请选择</option>
                      {columns
                        .filter((item) => item.table === targetTable)
                        .map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name} · {item.type}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
              {kind === "metrics" && (
                <label>
                  计算方式
                  <select
                    value={aggregation}
                    onChange={(event) =>
                      setAggregation(event.target.value as Metric["aggregation"])
                    }
                  >
                    <option value="sum">求和</option>
                    <option value="count">计数</option>
                    <option value="avg">平均值</option>
                    <option value="min">最小值</option>
                    <option value="max">最大值</option>
                  </select>
                </label>
              )}
              <Button type="submit" disabled={busy}>
                {editing === null ? "添加到待保存列表" : "更新待保存内容"}
              </Button>
              {formPending && (
                <Button
                  type="button"
                  onClick={() => {
                    if (discardForm()) clearForm();
                  }}
                >
                  {editing !== null ? "取消编辑" : "清空当前输入"}
                </Button>
              )}
            </fieldset>
          </form>
        </>
      )}
    </section>
  );
}
