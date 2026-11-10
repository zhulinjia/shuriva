import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { DatasourcePreferences, DatasourceTable } from "@/shared/datasource-metadata"

function replaceTableNote(
    preferences: DatasourcePreferences,
    tableName: string,
    update: (note: DatasourcePreferences["tables"][number]) => DatasourcePreferences["tables"][number],
) {
    const existing = preferences.tables.find((table) => table.name === tableName) ?? { name: tableName, description: "", columns: [] }
    return { ...preferences, tables: [...preferences.tables.filter((table) => table.name !== tableName), update(existing)] }
}

function setScopeTable(preferences: DatasourcePreferences, table: DatasourceTable, columns: string[]) {
    return {
        ...preferences,
        aiScope: {
            mode: "selected" as const,
            tables: [
                ...preferences.aiScope.tables.filter((item) => item.name !== table.name),
                ...(columns.length ? [{ name: table.name, columns }] : []),
            ],
        },
    }
}

export function SourceMetadataFields({
    table: active,
    preferences,
    onChange: change,
}: {
    table: DatasourceTable
    preferences: DatasourcePreferences
    onChange: (value: DatasourcePreferences) => void
}) {
    const notes = preferences.tables.find((table) => table.name === active.name)
    const selected = preferences.aiScope.tables.find((table) => table.name === active.name)
    return (
        <>
            <section className="rounded-lg border bg-card p-4 md:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="break-all text-lg font-semibold">{active.name}</h2>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {active.kind === "view" ? "视图" : active.kind === "table" ? "表" : "表或视图"} · {active.columns.length} 个字段
                        </p>
                    </div>
                    {preferences.aiScope.mode === "selected" && (
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={
                                    active.columns.length > 0 && active.columns.every((column) => selected?.columns.includes(column.name))
                                }
                                onChange={(event) =>
                                    change(
                                        setScopeTable(
                                            preferences,
                                            active,
                                            event.target.checked ? active.columns.map((column) => column.name) : [],
                                        ),
                                    )
                                }
                            />
                            全选此表字段（
                            {active.columns.filter((column) => selected?.columns.includes(column.name)).length}/{active.columns.length}）
                        </label>
                    )}
                </div>
                {active.comment && <p className="mt-3 text-sm text-muted-foreground">数据库注释：{active.comment}</p>}
                <label className="mt-4 grid gap-1.5 text-sm">
                    表的业务说明
                    <Textarea
                        aria-label="表的业务说明"
                        value={notes?.description ?? ""}
                        maxLength={1500}
                        placeholder="例如：记录每笔订单的当前状态"
                        onChange={(event) =>
                            change(
                                replaceTableNote(preferences, active.name, (note) => ({
                                    ...note,
                                    description: event.target.value,
                                })),
                            )
                        }
                    />
                </label>
                <p className="mt-1 text-xs text-muted-foreground">填写后优先用于 AI 理解；只保存在 Shuriva，不修改原数据库。</p>
            </section>
            <section className="rounded-lg border bg-card p-4 md:p-5">
                <h2 className="font-medium">字段说明</h2>
                <div className="mt-3 divide-y">
                    {active.columns.map((column) => (
                        <div
                            key={column.name}
                            className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(150px,0.8fr)_minmax(180px,1.2fr)] sm:items-start"
                        >
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    {preferences.aiScope.mode === "selected" && (
                                        <input
                                            type="checkbox"
                                            aria-label={`允许 AI 使用字段 ${column.name}`}
                                            checked={selected?.columns.includes(column.name) ?? false}
                                            onChange={(event) =>
                                                change(
                                                    setScopeTable(
                                                        preferences,
                                                        active,
                                                        event.target.checked
                                                            ? [...(selected?.columns ?? []), column.name]
                                                            : (selected?.columns ?? []).filter((name) => name !== column.name),
                                                    ),
                                                )
                                            }
                                        />
                                    )}
                                    <span className="break-all text-sm font-medium">{column.name}</span>
                                    {column.primaryKeyPosition && (
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                                            主键
                                            {column.primaryKeyPosition > 1 ? ` ${column.primaryKeyPosition}` : ""}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 break-all text-xs text-muted-foreground">
                                    {column.type || "未声明类型"}
                                    {column.nullable === false ? " · 非空" : column.nullable === true ? " · 可空" : ""}
                                </p>
                                {column.comment && (
                                    <p className="mt-1 break-words text-xs text-muted-foreground">数据库注释：{column.comment}</p>
                                )}
                            </div>
                            <Input
                                aria-label={`字段 ${column.name} 的业务说明`}
                                maxLength={1500}
                                placeholder="补充字段业务含义"
                                value={notes?.columns.find((item) => item.name === column.name)?.description ?? ""}
                                onChange={(event) =>
                                    change(
                                        replaceTableNote(preferences, active.name, (note) => ({
                                            ...note,
                                            columns: [
                                                ...note.columns.filter((item) => item.name !== column.name),
                                                { name: column.name, description: event.target.value },
                                            ],
                                        })),
                                    )
                                }
                            />
                        </div>
                    ))}
                </div>
            </section>
        </>
    )
}
