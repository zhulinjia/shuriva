import { Button } from "@workspace/ui";
import { Plus, Trash2 } from "lucide-react";
import { type Dispatch, type SetStateAction, useId } from "react";
import {
  type Draft,
  emptyField,
  type FieldDraft,
  type PredicateDraft,
  type ValueKind,
  valueKinds,
} from "./model";

const kindNames: Record<ValueKind, string> = {
  string: "文本",
  integer: "整数",
  decimal: "精确小数",
  boolean: "布尔值",
  null: "NULL",
  binary: "二进制编码",
  date: "日期",
  datetime: "日期时间",
};
const operatorNames = {
  eq: "等于",
  ne: "不等于",
  lt: "小于",
  lte: "小于等于",
  gt: "大于",
  gte: "大于等于",
  is_null: "为空值",
  not_null: "不为空值",
};
function Field<T extends FieldDraft>({
  field,
  onChange,
  onRemove,
  disabled,
  removeDisabled,
  operator,
}: {
  field: T;
  onChange: (field: T) => void;
  onRemove: () => void;
  disabled: boolean;
  removeDisabled: boolean;
  operator?: {
    value: PredicateDraft["operator"];
    change: (value: PredicateDraft["operator"]) => void;
  };
}) {
  const noValue = operator?.value === "is_null" || operator?.value === "not_null";
  const valueId = useId();
  return (
    <div className="mut-field">
      <label>
        字段
        <input
          value={field.column}
          maxLength={64}
          disabled={disabled}
          placeholder="字段名称"
          onChange={(event) => onChange({ ...field, column: event.target.value })}
        />
      </label>
      {operator && (
        <label>
          条件
          <select
            value={operator.value}
            disabled={disabled}
            onChange={(event) => operator.change(event.target.value as PredicateDraft["operator"])}
          >
            {Object.entries(operatorNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        值类型
        <select
          value={field.kind}
          disabled={disabled || noValue}
          onChange={(event) =>
            onChange({
              ...field,
              kind: event.target.value as ValueKind,
              value: event.target.value === "null" ? "" : field.value,
            })
          }
        >
          {valueKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kindNames[kind]}
            </option>
          ))}
        </select>
      </label>
      <label className="mut-value" htmlFor={valueId}>
        值
        {field.kind === "boolean" && !noValue ? (
          <select
            id={valueId}
            value={field.value}
            disabled={disabled}
            onChange={(event) => onChange({ ...field, value: event.target.value })}
          >
            <option value="">请选择</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            id={valueId}
            value={noValue || field.kind === "null" ? "" : field.value}
            placeholder={noValue || field.kind === "null" ? "无需填写" : "填写本次值"}
            disabled={disabled || noValue || field.kind === "null"}
            maxLength={32768}
            onChange={(event) => onChange({ ...field, value: event.target.value })}
          />
        )}
      </label>
      <Button
        type="button"
        className="mut-remove"
        aria-label={`移除字段 ${field.column || "未命名"}`}
        disabled={disabled || removeDisabled}
        onClick={onRemove}
      >
        <Trash2 size={15} />
      </Button>
    </div>
  );
}

export function MutationEditor({
  draft,
  setDraft,
  disabled,
  tables,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
  disabled: boolean;
  tables: string[];
}) {
  const tableId = useId();
  return (
    <div className="mut-editor">
      <div className="mut-draft-heading">
        <label>
          操作
          <select
            value={draft.operation}
            disabled={disabled}
            onChange={(event) =>
              setDraft((old) => ({ ...old, operation: event.target.value as Draft["operation"] }))
            }
          >
            <option value="update">修改</option>
            <option value="insert">新增</option>
            <option value="delete">删除</option>
          </select>
        </label>
        <label htmlFor={tableId}>
          目标表
          {tables.length ? (
            <select
              id={tableId}
              value={draft.table}
              disabled={disabled}
              onChange={(event) => setDraft((old) => ({ ...old, table: event.target.value }))}
            >
              <option value="">选择已授权的表</option>
              {tables.map((table) => (
                <option key={table} value={table}>
                  {table}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={tableId}
              value={draft.table}
              disabled={disabled}
              maxLength={64}
              placeholder="填写本机已授权的表"
              onChange={(event) => setDraft((old) => ({ ...old, table: event.target.value }))}
            />
          )}
        </label>
      </div>
      {draft.operation === "insert" ? (
        <div className="mut-insert-rows">
          {draft.rows.map((fields, rowIndex) => (
            <fieldset key={fields[0]?.id ?? rowIndex} disabled={disabled}>
              <legend>新增第 {rowIndex + 1} 行</legend>
              {fields.map((field) => (
                <Field
                  key={field.id}
                  field={field}
                  disabled={disabled}
                  removeDisabled={fields.length === 1}
                  onChange={(next) =>
                    setDraft((old) => ({
                      ...old,
                      rows: old.rows.map((items, index) =>
                        index === rowIndex
                          ? items.map((item) => (item.id === field.id ? next : item))
                          : items,
                      ),
                    }))
                  }
                  onRemove={() =>
                    setDraft((old) => ({
                      ...old,
                      rows: old.rows.map((items, index) =>
                        index === rowIndex ? items.filter((item) => item.id !== field.id) : items,
                      ),
                    }))
                  }
                />
              ))}
              <div className="mut-inline-actions">
                <Button
                  type="button"
                  className="outline-button"
                  disabled={disabled || fields.length >= 256}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      rows: old.rows.map((items, index) =>
                        index === rowIndex ? [...items, emptyField()] : items,
                      ),
                    }))
                  }
                >
                  <Plus size={14} />
                  添加字段
                </Button>
                <Button
                  type="button"
                  className="mut-text-button"
                  disabled={disabled || draft.rows.length === 1}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      rows: old.rows.filter((_items, index) => index !== rowIndex),
                    }))
                  }
                >
                  移除此行
                </Button>
              </div>
            </fieldset>
          ))}
          <Button
            type="button"
            className="outline-button"
            disabled={disabled || draft.rows.length >= 100}
            onClick={() => setDraft((old) => ({ ...old, rows: [...old.rows, [emptyField()]] }))}
          >
            <Plus size={14} />
            再新增一行
          </Button>
        </div>
      ) : (
        <>
          {draft.operation === "update" && (
            <fieldset disabled={disabled}>
              <legend>修改后的值</legend>
              {draft.changes.map((field) => (
                <Field
                  key={field.id}
                  field={field}
                  disabled={disabled}
                  removeDisabled={draft.changes.length === 1}
                  onChange={(next) =>
                    setDraft((old) => ({
                      ...old,
                      changes: old.changes.map((item) => (item.id === field.id ? next : item)),
                    }))
                  }
                  onRemove={() =>
                    setDraft((old) => ({
                      ...old,
                      changes: old.changes.filter((item) => item.id !== field.id),
                    }))
                  }
                />
              ))}
              <Button
                type="button"
                className="outline-button"
                disabled={disabled || draft.changes.length >= 256}
                onClick={() =>
                  setDraft((old) => ({ ...old, changes: [...old.changes, emptyField()] }))
                }
              >
                <Plus size={14} />
                添加修改字段
              </Button>
            </fieldset>
          )}
          <fieldset disabled={disabled}>
            <legend>目标筛选条件</legend>
            <p className="mut-muted">
              全部条件同时成立；最终只操作完整预览中冻结的记录，新匹配记录不会加入。
            </p>
            {draft.where.map((field) => (
              <Field
                key={field.id}
                field={field}
                disabled={disabled}
                removeDisabled={draft.where.length === 1}
                operator={{
                  value: field.operator,
                  change: (operator) =>
                    setDraft((old) => ({
                      ...old,
                      where: old.where.map((item) =>
                        item.id === field.id ? { ...item, operator } : item,
                      ),
                    })),
                }}
                onChange={(next) =>
                  setDraft((old) => ({
                    ...old,
                    where: old.where.map((item) => (item.id === field.id ? next : item)),
                  }))
                }
                onRemove={() =>
                  setDraft((old) => ({
                    ...old,
                    where: old.where.filter((item) => item.id !== field.id),
                  }))
                }
              />
            ))}
            <Button
              type="button"
              className="outline-button"
              disabled={disabled || draft.where.length >= 32}
              onClick={() =>
                setDraft((old) => ({
                  ...old,
                  where: [...old.where, { ...emptyField(), operator: "eq" }],
                }))
              }
            >
              <Plus size={14} />
              添加条件
            </Button>
          </fieldset>
        </>
      )}
    </div>
  );
}
