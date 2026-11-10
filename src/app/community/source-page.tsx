import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, getSources } from "@/services/community-api"
import type { LiveSource } from "@/services/community-api"
import type { DatasourcePreferences } from "@/shared/datasource-metadata"
import { SourceMetadata } from "./source-metadata"

export function SourcePage({ onDirtyChange }: { onDirtyChange: (dirty: boolean) => void }) {
    const client = useQueryClient()
    const sources = useQuery({ queryKey: ["live-sources"], queryFn: getSources })
    const [selectedSource, setSelectedSource] = useState<LiveSource | null>(null)
    const [drafts, setDrafts] = useState<Record<string, DatasourcePreferences>>({})
    useEffect(() => {
        onDirtyChange(Object.keys(drafts).length > 0)
    }, [drafts, onDirtyChange])
    useEffect(() => () => onDirtyChange(false), [onDirtyChange])
    const updateDraft = (id: string, value: DatasourcePreferences | null) => {
        setDrafts((current) => {
            const next = { ...current }
            if (value) next[id] = value
            else delete next[id]
            return next
        })
    }
    const [engine, setEngine] = useState<"sqlite" | "postgresql" | "mysql">("sqlite")
    const [name, setName] = useState("")
    const [path, setPath] = useState("")
    const [host, setHost] = useState("127.0.0.1")
    const [port, setPort] = useState("5432")
    const [database, setDatabase] = useState("")
    const [user, setUser] = useState("")
    const [password, setPassword] = useState("")
    const [schema, setSchema] = useState("public")
    const [ssl, setSsl] = useState(false)
    const add = useMutation({
        mutationFn: () =>
            api("/datasources", {
                method: "POST",
                body: {
                    name,
                    engine,
                    config:
                        engine === "sqlite"
                            ? { path }
                            : { host, port: Number(port), database, user, password, ssl, ...(engine === "postgresql" ? { schema } : {}) },
                },
            }),
        onSuccess: () => {
            setName("")
            setPath("")
            setPassword("")
            void client.invalidateQueries({ queryKey: ["live-sources"] })
        },
    })
    if (selectedSource)
        return (
            <SourceMetadata
                source={selectedSource}
                draft={drafts[selectedSource.id]}
                onDraft={(value) => updateDraft(selectedSource.id, value)}
                onBack={() => setSelectedSource(null)}
            />
        )
    return (
        <div className="mx-auto max-w-5xl p-6 md:p-10">
            <h1 className="text-2xl font-semibold">数据源</h1>
            <p className="mt-2 text-sm text-muted-foreground">连接已有数据库。当前连接只读，凭证由服务端加密保存。</p>
            <div className="mt-7 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
                <section>
                    <h2 className="mb-3 font-medium">已连接的数据源</h2>
                    {sources.isPending ? (
                        <p className="text-sm text-muted-foreground">正在读取…</p>
                    ) : sources.isError ? (
                        <p role="alert" className="text-sm text-destructive">
                            读取失败，请重试。
                        </p>
                    ) : sources.data.length === 0 ? (
                        <p className="rounded-lg border border-dashed p-5 text-sm text-muted-foreground">
                            还没有数据源。添加连接后即可生成工作台。
                        </p>
                    ) : (
                        <ul className="divide-y rounded-lg border">
                            {sources.data.map((source) => (
                                <li className="flex items-center justify-between gap-3 p-4" key={source.id}>
                                    <span className="min-w-0">
                                        <span className="block truncate text-sm font-medium">{source.name}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {source.engine} · 只读{drafts[source.id] ? " · 有未保存的说明" : ""}
                                        </span>
                                    </span>
                                    <Button type="button" variant="outline" size="sm" onClick={() => setSelectedSource(source)}>
                                        查看结构
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <form
                    className="grid content-start gap-3 rounded-lg border bg-card p-5"
                    onSubmit={(event) => {
                        event.preventDefault()
                        add.mutate()
                    }}
                >
                    <h2 className="font-medium">添加数据源</h2>
                    <label className="grid gap-1.5 text-sm">
                        名称
                        <Input value={name} onChange={(event) => setName(event.target.value)} required />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                        类型
                        <select
                            className="h-9 rounded-md border bg-background px-2"
                            value={engine}
                            onChange={(event) => {
                                const next = event.target.value as typeof engine
                                setEngine(next)
                                setPort(next === "mysql" ? "3306" : "5432")
                            }}
                        >
                            <option value="sqlite">SQLite</option>
                            <option value="postgresql">PostgreSQL</option>
                            <option value="mysql">MySQL</option>
                        </select>
                    </label>
                    {engine === "sqlite" ? (
                        <label className="grid gap-1.5 text-sm">
                            服务器上的数据库文件路径
                            <Input value={path} onChange={(event) => setPath(event.target.value)} required />
                            <span className="text-xs text-muted-foreground">填写运行 Shuriva 的服务器可访问的路径。</span>
                        </label>
                    ) : (
                        <>
                            <div className="grid grid-cols-[1fr_100px] gap-2">
                                <label className="grid gap-1.5 text-sm">
                                    主机
                                    <Input value={host} onChange={(event) => setHost(event.target.value)} required />
                                </label>
                                <label className="grid gap-1.5 text-sm">
                                    端口
                                    <Input
                                        type="number"
                                        min="1"
                                        max="65535"
                                        value={port}
                                        onChange={(event) => setPort(event.target.value)}
                                        required
                                    />
                                </label>
                            </div>
                            <label className="grid gap-1.5 text-sm">
                                数据库
                                <Input value={database} onChange={(event) => setDatabase(event.target.value)} required />
                            </label>
                            {engine === "postgresql" && (
                                <label className="grid gap-1.5 text-sm">
                                    Schema
                                    <Input value={schema} onChange={(event) => setSchema(event.target.value)} required />
                                </label>
                            )}
                            <label className="grid gap-1.5 text-sm">
                                用户名
                                <Input autoComplete="off" value={user} onChange={(event) => setUser(event.target.value)} required />
                            </label>
                            <label className="grid gap-1.5 text-sm">
                                密码
                                <Input
                                    type="password"
                                    autoComplete="new-password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                />
                            </label>
                            <Label className="flex items-center gap-2">
                                <input type="checkbox" checked={ssl} onChange={(event) => setSsl(event.target.checked)} />
                                使用 TLS 并校验证书
                            </Label>
                        </>
                    )}
                    {add.isError && (
                        <p role="alert" className="text-sm text-destructive">
                            连接失败，请检查配置和数据库的只读权限。
                        </p>
                    )}
                    {add.isSuccess && (
                        <p role="status" className="text-sm text-green-700">
                            连接已添加。
                        </p>
                    )}
                    <Button type="submit" disabled={add.isPending}>
                        {add.isPending ? "正在连接…" : "测试并添加"}
                    </Button>
                </form>
            </div>
        </div>
    )
}
