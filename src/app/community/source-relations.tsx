import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { DatasourcePreferences, DatasourceTable } from "@/shared/datasource-metadata"

type Props = {
    table: DatasourceTable
    tables: DatasourceTable[]
    preferences: DatasourcePreferences
    onChange: (value: DatasourcePreferences) => void
}

const selectClass = "h-9 min-w-0 w-full rounded-md border bg-background px-2 text-sm"

export function SourceRelations({ table, tables, preferences, onChange }: Props) {
    const [targetName, setTargetName] = useState("")
    const [mappings, setMappings] = useState([{ from: "", to: "" }])
    const [description, setDescription] = useState("")
    const [showForm, setShowForm] = useState(false)
    const [error, setError] = useState("")
    const target = tables.find((item) => item.name === targetName)
    const confirmed = preferences.relations.filter((relation) => relation.fromTable === table.name)
    const databaseRelations = table.relations ?? []
    const addRelation = () => {
        if (
            !target ||
            mappings.some((mapping) => !mapping.from || !mapping.to) ||
            new Set(mappings.map((mapping) => mapping.from)).size !== mappings.length ||
            new Set(mappings.map((mapping) => mapping.to)).size !== mappings.length
        ) {
            setError("请选择目标表及每组不同的关联字段。")
            return
        }
        onChange({
            ...preferences,
            relations: [
                ...preferences.relations,
                { id: crypto.randomUUID(), fromTable: table.name, toTable: target.name, mappings, description },
            ],
        })
        setMappings([{ from: "", to: "" }])
        setDescription("")
        setTargetName("")
        setError("")
        setShowForm(false)
    }
    return (
        <section className="rounded-lg border bg-card p-4 md:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2 className="font-medium">表关系</h2>
                    <p className="mt-1 text-xs text-muted-foreground">数据库定义和用户确认的关系用于帮助 AI 理解；当前尚不支持多表查询。</p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setShowForm((value) => !value)}>
                    {showForm ? "取消添加" : "添加关系"}
                </Button>
            </div>
            {!databaseRelations.length && !confirmed.length && (
                <p className="mt-4 text-sm text-muted-foreground">没有读取到已声明的关系，可以根据业务手动添加。</p>
            )}
            {databaseRelations.map((relation, index) => (
                <div className="mt-3 rounded-md border p-3 text-sm" key={`${relation.name ?? "foreign-key"}-${index}`}>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs">数据库定义</span>
                        <span className="break-all font-medium">
                            {relation.fromTable} → {relation.toSchema && !relation.sameDatasource ? `${relation.toSchema}.` : ""}
                            {relation.toTable}
                        </span>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                        {relation.mappings.map((mapping) => `${mapping.from} → ${mapping.to ?? "目标字段未读取"}`).join("，")}
                    </p>
                    {!relation.sameDatasource && (
                        <p className="mt-1 text-xs text-muted-foreground">目标不在当前数据源范围内，不会用于 AI 关联。</p>
                    )}
                </div>
            ))}
            {confirmed.map((relation) => {
                const to = tables.find((item) => item.name === relation.toTable)
                const valid = Boolean(
                    to &&
                    relation.mappings.every(
                        (mapping) =>
                            table.columns.some((column) => column.name === mapping.from) &&
                            to.columns.some((column) => column.name === mapping.to),
                    ),
                )
                return (
                    <div className="mt-3 rounded-md border p-3 text-sm" key={relation.id}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0 break-all">
                                <span className="mr-2 rounded bg-muted px-1.5 py-0.5 text-xs">用户确认</span>
                                {relation.fromTable} → {relation.toTable}
                            </span>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                    onChange({ ...preferences, relations: preferences.relations.filter((item) => item.id !== relation.id) })
                                }
                            >
                                移除关系
                            </Button>
                        </div>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                            {relation.mappings.map((mapping) => `${mapping.from} → ${mapping.to}`).join("，")}
                        </p>
                        {relation.description && <p className="mt-1 break-words text-xs text-muted-foreground">{relation.description}</p>}
                        {!valid && (
                            <p role="status" className="mt-2 text-xs text-destructive">
                                关联的表或字段已不可见，请检查后重新添加。
                            </p>
                        )}
                    </div>
                )
            })}
            {showForm && (
                <div className="mt-4 space-y-3 rounded-md border bg-muted/20 p-3">
                    <label className="grid gap-1.5 text-sm">
                        目标表
                        <select
                            aria-label="目标表"
                            className={selectClass}
                            value={targetName}
                            onChange={(event) => {
                                setTargetName(event.target.value)
                                setMappings([{ from: "", to: "" }])
                                setError("")
                            }}
                        >
                            <option value="">选择目标表</option>
                            {tables.map((item) => (
                                <option key={item.name} value={item.name}>
                                    {item.name}
                                </option>
                            ))}
                        </select>
                    </label>
                    {mappings.map((mapping, index) => (
                        <div key={index} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                            <label className="grid gap-1 text-xs text-muted-foreground">
                                本表字段
                                <select
                                    className={selectClass}
                                    aria-label={`第 ${index + 1} 组本表字段`}
                                    value={mapping.from}
                                    onChange={(event) =>
                                        setMappings(
                                            mappings.map((item, position) =>
                                                position === index ? { ...item, from: event.target.value } : item,
                                            ),
                                        )
                                    }
                                >
                                    <option value="">选择字段</option>
                                    {table.columns.map((column) => (
                                        <option key={column.name} value={column.name}>
                                            {column.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="grid gap-1 text-xs text-muted-foreground">
                                目标表字段
                                <select
                                    className={selectClass}
                                    aria-label={`第 ${index + 1} 组目标表字段`}
                                    value={mapping.to}
                                    onChange={(event) =>
                                        setMappings(
                                            mappings.map((item, position) =>
                                                position === index ? { ...item, to: event.target.value } : item,
                                            ),
                                        )
                                    }
                                >
                                    <option value="">选择字段</option>
                                    {target?.columns.map((column) => (
                                        <option key={column.name} value={column.name}>
                                            {column.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            {mappings.length > 1 && (
                                <Button
                                    variant="ghost"
                                    className="self-end"
                                    onClick={() => setMappings(mappings.filter((_, position) => position !== index))}
                                >
                                    移除
                                </Button>
                            )}
                        </div>
                    ))}
                    <Button
                        variant="ghost"
                        size="sm"
                        disabled={mappings.length >= 20}
                        onClick={() => setMappings([...mappings, { from: "", to: "" }])}
                    >
                        添加一组字段
                    </Button>
                    <label className="grid gap-1.5 text-sm">
                        关系说明（选填）
                        <Input
                            maxLength={1500}
                            placeholder="例如：订单属于对应的客户"
                            value={description}
                            onChange={(event) => setDescription(event.target.value)}
                        />
                    </label>
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                    <Button onClick={addRelation}>确认添加关系</Button>
                </div>
            )}
        </section>
    )
}
