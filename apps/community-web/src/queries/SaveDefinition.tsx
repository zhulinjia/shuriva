import { Button, ConfirmDialog } from "@workspace/ui";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { historyBase, putHistory } from "../history-api";
import {
  type Artifact,
  artifactContent,
  type HistoryRecord,
  type ParameterKind,
} from "../history-model";
import type { VisualizationDefinition } from "./result-presentation";

type SaveIntent = {
  path: string;
  scope: string;
  target: { id: string; revision: number };
  content: Artifact;
};

export function SaveDefinition({
  workspaceId,
  sourceId,
  sql,
  parameters,
  maxRows,
  schemaVersion,
  visualization,
  disabled,
  initial,
  onSaved,
  onBusyChange,
}: {
  workspaceId: string;
  sourceId: string;
  sql: string;
  parameters: Array<{ kind: ParameterKind; value: string }>;
  maxRows: number;
  schemaVersion: string | null;
  visualization: VisualizationDefinition;
  disabled: boolean;
  initial?: HistoryRecord<Artifact>;
  onSaved?: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [name, setName] = useState(initial?.content.name ?? ""),
    [notes, setNotes] = useState(initial?.content.notes ?? "");
  const [kind, setKind] = useState<Artifact["kind"]>(initial?.content.kind ?? "query");
  const identity = useRef({
    id: initial?.id ?? crypto.randomUUID(),
    revision: initial?.revision ?? 0,
  });
  const [saving, setSaving] = useState(false),
    [message, setMessage] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<SaveIntent | null>(null);
  const intent = useRef<SaveIntent | null>(null);
  const active = useRef(true);
  const flight = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(saving || confirmation !== null);
    return () => onBusyChange?.(false);
  }, [saving, confirmation, onBusyChange]);
  function save(asNew = false) {
    if (disabled || flight.current || intent.current || !name.trim()) return;
    let content: Artifact;
    try {
      content = artifactContent({
        name,
        kind,
        sql,
        parameters,
        maxRows,
        schemaVersion,
        notes,
        visualization,
      });
    } catch {
      setMessage(
        kind === "chart"
          ? "请先选择有效图表及横纵字段，再填写名称保存。"
          : "请检查查询内容和名称。",
      );
      return;
    }
    const target = asNew ? { id: crypto.randomUUID(), revision: 0 } : { ...identity.current };
    const pending = {
      content,
      target,
      scope: `${workspaceId}:${sourceId}`,
      path: `${historyBase(workspaceId, sourceId, "artifact")}/${target.id}`,
    };
    intent.current = pending;
    setConfirmation(pending);
    setMessage("");
  }
  function cancel() {
    if (flight.current) return;
    intent.current = null;
    setConfirmation(null);
  }
  async function confirmSave() {
    const pending = intent.current;
    if (!pending || flight.current) return;
    if (disabled || pending.scope !== `${workspaceId}:${sourceId}`) {
      cancel();
      setMessage("当前数据源或授权已变化，未保存。请重新核对后操作。");
      return;
    }
    flight.current = true;
    setSaving(true);
    setMessage("");
    try {
      const result = await putHistory(pending.path, pending.target.revision, pending.content);
      if (!active.current) return;
      identity.current = { id: result.id, revision: result.revision };
      setUnconfirmed(false);
      setMessage("定义已保存；重新打开时必须重新填写参数并确认执行。");
      onSaved?.();
    } catch (error) {
      if (active.current) {
        setUnconfirmed(true);
        setMessage(
          error instanceof ApiError && error.status === 409
            ? "定义已被修改，或上次保存已生效。原记录未覆盖，请从历史重新打开核对，或另存为新定义。"
            : "保存未确认，请刷新历史列表核对；也可明确另存为新定义。",
        );
      }
    } finally {
      flight.current = false;
      intent.current = null;
      if (active.current) {
        setSaving(false);
        setConfirmation(null);
      }
    }
  }
  return (
    <section className="history-save-definition" aria-label="保存查询与图表">
      <h3>{initial ? "更新保存的定义" : "保存查询、分析或图表"}</h3>
      <p>
        保存 SQL 与说明，不保存参数值和结果；SQL
        中直接写入的常量仍会保存。图表仅基于实际返回的数据，不自动执行聚合。
      </p>
      <fieldset disabled={disabled || saving || confirmation !== null} className="product-form">
        <label>
          名称
          <input maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          保存类型
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as Artifact["kind"])}
          >
            <option value="query">查询</option>
            <option value="analysis">分析</option>
            <option value="chart">图表</option>
          </select>
        </label>
        <label>
          分析或说明
          <textarea
            maxLength={4000}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>
        <Button type="button" disabled={!name.trim() || !sql.trim()} onClick={() => void save()}>
          {saving ? "保存中…" : "保存定义"}
        </Button>
        {(initial || unconfirmed) && (
          <Button
            type="button"
            disabled={!name.trim() || !sql.trim()}
            onClick={() => void save(true)}
          >
            另存为新定义
          </Button>
        )}
      </fieldset>
      <ConfirmDialog
        open={confirmation !== null}
        title="保存查询与图表定义"
        description="将查询 SQL 和说明保存到本机平台数据库。参数值和查询结果不会保存，但 SQL 中直接写入的常量仍会保存，请核对敏感内容。"
        confirmLabel="确认保存"
        busy={saving}
        onCancel={cancel}
        onConfirm={() => void confirmSave()}
      >
        {confirmation && (
          <p>
            名称：<strong>{confirmation.content.name}</strong>
          </p>
        )}
      </ConfirmDialog>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
