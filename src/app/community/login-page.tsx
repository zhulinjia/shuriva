import { useState } from "react"
import { Database, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api } from "@/services/community-api"

export function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")

  return <main className="flex min-h-svh items-center justify-center bg-muted/30 px-5 py-12">
    <section className="w-full max-w-sm rounded-xl border bg-card p-7 shadow-sm">
      <div className="mb-7 flex items-center gap-2.5"><span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Database className="size-4" /></span><span className="text-lg font-semibold">Shuriva</span></div>
      <h1 className="text-xl font-semibold">登录工作台</h1>
      <p className="mt-2 text-sm text-muted-foreground">使用此实例的管理员账号登录。</p>
      <form className="mt-6 grid gap-4" onSubmit={(event) => {
        event.preventDefault(); setPending(true); setError("")
        void api<{ username: string }>("/auth/login", { method: "POST", body: { username, password } }).then((result) => { setPassword(""); onLogin(result.username) }).catch(() => setError("登录失败，请检查账号、密码及服务状态。首次使用请先在服务器上运行 pnpm admin。") ).finally(() => setPending(false))
      }}>
        <div className="grid gap-2"><Label htmlFor="community-user">管理员账号</Label><Input id="community-user" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div>
        <div className="grid gap-2"><Label htmlFor="community-password">密码</Label><Input id="community-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>{pending && <Loader2 className="animate-spin" />}登录</Button>
      </form>
      <p className="mt-6 text-xs leading-5 text-muted-foreground">首次部署时，请在服务器终端运行 <code>pnpm admin</code> 创建管理员。忘记密码时运行 <code>pnpm admin reset-password</code>。</p>
    </section>
  </main>
}
