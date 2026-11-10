import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ApiError, getDatasourceSchema, saveDatasourceMetadata } from "@/services/community-api"
import type { LiveSource } from "@/services/community-api"
import type { DatasourcePreferences, DatasourceSchema } from "@/shared/datasource-metadata"
import { SourceMetadataFields } from "./source-metadata-fields"
import { SourceMetadataScope } from "./source-metadata-scope"
import { SourceRelations } from "./source-relations"

type Props = {
    source: LiveSource
    draft?: DatasourcePreferences
    onDraft: (draft: DatasourcePreferences | null) => void
    onBack: () => void
}

export function SourceMetadata({ source, draft, onDraft, onBack }: Props) {
    const client = useQueryClient()
    const queryKey = ["datasource-schema", source.id]
    const schema = useQuery({ queryKey, queryFn: () => getDatasourceSchema(source.id) })
    const [tableName, setTableName] = useState("")
    const [search, setSearch] = useState("")
    const save = useMutation({
        mutationFn: (value: DatasourcePreferences) => saveDatasourceMetadata(source.id, value),
        onSuccess: (preferences) => {
            client.setQueryData<DatasourceSchema>(queryKey, (current) => (current ? { ...current, preferences } : current))
            onDraft(null)
        },
    })
    const current = schema.data
    const preferences = draft ?? current?.preferences
    const change = (value: DatasourcePreferences) => {
        save.reset()
        onDraft(current && JSON.stringify(value) === JSON.stringify(current.preferences) ? null : value)
    }
    const active = current?.tables.find((table) => table.name === tableName) ?? current?.tables[0]
    const visibleTables = current?.tables.filter((table) => table.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? []
    const staleNotes =
        current &&
        preferences?.tables.some((table) => {
            const actual = current.tables.find((item) => item.name === table.name)
            return !actual || table.columns.some((column) => !actual.columns.some((item) => item.name === column.name))
        })
    const missingSourceRelations =
        preferences?.relations.filter((relation) => !current?.tables.some((table) => table.name === relation.fromTable)) ?? []

    return (
        <div className="mx-auto max-w-7xl p-4 md:p-8">
            <Button variant="ghost" className="mb-4 -ml-2" onClick={onBack} disabled={save.isPending}>
                <ArrowLeft />
                返回数据源
            </Button>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <h1 className="break-all text-2xl font-semibold">{source.name}</h1>
                    <p className="mt-1 text-sm text-muted-foreground">数据库结构与业务说明 · {source.engine} · 只读</p>
                </div>
                <Button variant="outline" onClick={() => void schema.refetch()} disabled={schema.isFetching || save.isPending}>
                    <RefreshCw />
                    {schema.isFetching ? "正在读取…" : "刷新结构"}
                </Button>
            </div>
            {schema.isPending ? (
                <p className="mt-8 text-sm text-muted-foreground">正在读取数据库结构…</p>
            ) : schema.isError && !current ? (
                <div role="alert" className="mt-6 rounded-lg border p-4 text-sm">
                    读取结构失败，请检查数据源连接和读取权限。
                    <Button className="ml-3" variant="outline" size="sm" onClick={() => void schema.refetch()}>
                        重试
                    </Button>
                </div>
            ) : current && preferences ? (
                <>
                    {schema.isRefetchError && (
                        <p role="alert" className="mt-4 text-sm text-destructive">
                            刷新失败，当前显示的是上次读取的结构；请检查连接后重试。
                        </p>
                    )}
                    {current.warnings.map((warning) => (
                        <p
                            role="alert"
                            key={warning.code}
                            className="mt-4 rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                        >
                            {warning.message}
                        </p>
                    ))}
                    {current.warnings.some((warning) => warning.code === "tables_truncated" || warning.code === "columns_truncated") && (
                        <p className="mt-2 text-sm text-muted-foreground">结构读取不完整时，暂不能使用该数据源生成或修改工作台。</p>
                    )}
                    {staleNotes && (
                        <p role="status" className="mt-4 rounded-lg border p-3 text-sm">
                            数据库结构已有变化，部分已保存的说明对应的表或字段暂不可见；说明仍保留在 Shuriva 中。
                        </p>
                    )}
                    <fieldset disabled={save.isPending} className="mt-6 min-w-0">
                        {missingSourceRelations.length > 0 && (
                            <section className="mb-5 rounded-lg border p-4 text-sm">
                                <p>以下关系的来源表暂不可见，已保留但不会提供给 AI：</p>
                                {missingSourceRelations.map((relation) => (
                                    <div key={relation.id} className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                        <span className="break-all">
                                            {relation.fromTable} → {relation.toTable}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                change({
                                                    ...preferences,
                                                    relations: preferences.relations.filter((item) => item.id !== relation.id),
                                                })
                                            }
                                        >
                                            移除关系
                                        </Button>
                                    </div>
                                ))}
                            </section>
                        )}
                        <SourceMetadataScope tables={current.tables} preferences={preferences} onChange={change} />
                        <div className="mt-5 grid min-w-0 gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
                            <aside className="min-w-0 rounded-lg border bg-card p-4">
                                <h2 className="font-medium">
                                    表和视图 <span className="text-xs font-normal text-muted-foreground">{current.tables.length}</span>
                                </h2>
                                <Input
                                    className="mt-3"
                                    aria-label="搜索表或视图"
                                    placeholder="搜索表或视图"
                                    value={search}
                                    onChange={(event) => setSearch(event.target.value)}
                                />
                                {visibleTables.length ? (
                                    <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
                                        {visibleTables.map((table) => (
                                            <li key={table.name}>
                                                <button
                                                    type="button"
                                                    onClick={() => setTableName(table.name)}
                                                    aria-current={active?.name === table.name ? "true" : undefined}
                                                    className={`w-full rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted ${active?.name === table.name ? "bg-muted font-medium" : ""}`}
                                                >
                                                    <span className="block truncate">{table.name}</span>
                                                    <span className="text-xs font-normal text-muted-foreground">
                                                        {table.kind === "view" ? "视图" : table.kind === "table" ? "表" : "表或视图"} ·{" "}
                                                        {table.columns.length} 字段
                                                        {preferences.aiScope.mode === "selected" && (
                                                            <>
                                                                {" "}
                                                                · 已选{" "}
                                                                {
                                                                    table.columns.filter((column) =>
                                                                        preferences.aiScope.tables
                                                                            .find((item) => item.name === table.name)
                                                                            ?.columns.includes(column.name),
                                                                    ).length
                                                                }
                                                            </>
                                                        )}
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                ) : (
                                    <p className="mt-4 text-sm text-muted-foreground">
                                        {current.tables.length ? "没有匹配的表或视图。" : "没有读取到表或视图。"}
                                    </p>
                                )}
                            </aside>
                            {active ? (
                                <div className="min-w-0 space-y-5">
                                    <SourceMetadataFields table={active} preferences={preferences} onChange={change} />
                                    <SourceRelations
                                        key={active.name}
                                        table={active}
                                        tables={current.tables}
                                        preferences={preferences}
                                        onChange={change}
                                    />
                                </div>
                            ) : (
                                <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
                                    选择一张表查看字段和关系。
                                </div>
                            )}
                        </div>
                    </fieldset>
                    <div
                        className={`${draft ? "md:sticky md:bottom-0 md:z-10" : ""} mt-6 flex flex-wrap items-center gap-3 border-t bg-background py-4`}
                    >
                        <Button disabled={!draft || save.isPending} onClick={() => draft && save.mutate(draft)}>
                            {save.isPending ? "正在保存…" : "保存说明与范围"}
                        </Button>
                        {draft && <span className="text-sm text-muted-foreground">有未保存的修改</span>}
                        {save.isSuccess && !draft && (
                            <span role="status" className="text-sm text-green-700">
                                已保存，刷新页面后仍会保留。
                            </span>
                        )}
                        {save.isError && (
                            <span role="alert" className="text-sm text-destructive">
                                {save.error instanceof ApiError && save.error.status === 409
                                    ? "其他页面已更新配置，当前输入仍保留。请先复制需要保留的内容，再读取最新配置。"
                                    : "保存失败，当前输入仍保留，请检查连接或配置后重试。"}
                            </span>
                        )}
                        {save.isError && save.error instanceof ApiError && save.error.status === 409 && (
                            <Button
                                variant="outline"
                                onClick={() =>
                                    void schema.refetch().then((result) => {
                                        if (result.isSuccess) {
                                            onDraft(null)
                                            save.reset()
                                        }
                                    })
                                }
                            >
                                放弃本地修改并读取最新
                            </Button>
                        )}
                    </div>
                </>
            ) : null}
        </div>
    )
}
