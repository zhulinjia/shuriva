import { useState } from "react"
import type { DatasourcePreferences, DatasourceTable } from "@/shared/datasource-metadata"

export function SourceMetadataScope({
    tables,
    preferences,
    onChange,
}: {
    tables: DatasourceTable[]
    preferences: DatasourcePreferences
    onChange: (value: DatasourcePreferences) => void
}) {
    const [selectionInitialized, setSelectionInitialized] = useState(false)
    return (
        <section className="rounded-lg border bg-card p-4">
            <h2 className="font-medium">提供给 AI 的结构</h2>
            <p className="mt-1 text-sm text-muted-foreground">
                生成或修改工作台时会发送所选结构及用户输入的内容，不会自动发送业务记录。此设置不等同于用户数据访问权限。
            </p>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <label className="flex items-center gap-2">
                    <input
                        type="radio"
                        name="ai-scope"
                        checked={preferences.aiScope.mode === "all"}
                        onChange={() => {
                            setSelectionInitialized(true)
                            onChange({ ...preferences, aiScope: { ...preferences.aiScope, mode: "all" } })
                        }}
                    />
                    全部读取到的表和字段（默认）
                </label>
                <label className="flex items-center gap-2">
                    <input
                        type="radio"
                        name="ai-scope"
                        checked={preferences.aiScope.mode === "selected"}
                        onChange={() =>
                            onChange({
                                ...preferences,
                                aiScope: {
                                    mode: "selected",
                                    tables:
                                        selectionInitialized || preferences.aiScope.tables.length
                                            ? preferences.aiScope.tables
                                            : tables
                                                  .map((table) => ({
                                                      name: table.name,
                                                      columns: table.columns.map((column) => column.name),
                                                  }))
                                                  .filter((table) => table.columns.length),
                                },
                            })
                        }
                    />
                    仅选择的表和字段
                </label>
            </div>
            {preferences.aiScope.mode === "selected" && (
                <p className="mt-2 text-xs text-muted-foreground">在下方逐表勾选字段；未勾选的结构不会发送给 AI。</p>
            )}
        </section>
    )
}
