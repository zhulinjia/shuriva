import { Button } from "@workspace/ui";
import { ArrowRight, Layers3, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { api, post } from "./api";

export type Workspace = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
};
export function WorkspaceManager({ onSelect }: { onSelect: (workspace: Workspace) => void }) {
  const [items, setItems] = useState<Workspace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (showArchived: boolean, after?: string) => {
    const query = new URLSearchParams({ archived: String(showArchived) });
    if (after) query.set("after", after);
    const data = await api<{ workspaces: Workspace[]; nextCursor: string | null }>(
      `/api/workspaces?${query}`,
    );
    setItems((current) => (after ? [...current, ...data.workspaces] : data.workspaces));
    setCursor(data.nextCursor);
  }, []);
  useEffect(() => {
    setLoading(true);
    setError("");
    void load(archived)
      .catch(() => setError("工作空间加载失败，请检查连接后重试。"))
      .finally(() => setLoading(false));
  }, [archived, load]);
  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/workspaces", post({ name }));
      setName("");
      await load(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }
  async function rename(event: FormEvent, id: string) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/api/workspaces/${encodeURIComponent(id)}`, {
        ...post({ name: editName }),
        method: "PATCH",
      });
      setEditing(null);
      await load(archived);
    } catch (e) {
      setError(e instanceof Error ? e.message : "重命名失败");
    } finally {
      setBusy(false);
    }
  }
  async function move(item: Workspace) {
    setBusy(true);
    setError("");
    try {
      await api(
        `/api/workspaces/${encodeURIComponent(item.id)}/${archived ? "restore" : "archive"}`,
        post(),
      );
      await load(archived);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="workspaces-page">
      <div className="product-eyebrow">YOUR WORKSPACES</div>
      <div className="workspace-heading">
        <div>
          <h1>工作空间</h1>
          <p>选择一个空间，开始探索你的数据。</p>
        </div>
      </div>
      <section className="workspace-tabs" aria-label="工作空间筛选">
        <Button
          aria-pressed={!archived}
          disabled={loading || busy}
          onClick={() => {
            setArchived(false);
            setEditing(null);
          }}
        >
          使用中
        </Button>
        <Button
          aria-pressed={archived}
          disabled={loading || busy}
          onClick={() => {
            setArchived(true);
            setEditing(null);
          }}
        >
          已归档
        </Button>
      </section>
      {error && (
        <div className="product-error" role="alert">
          {error}
        </div>
      )}
      {!archived && (
        <form onSubmit={create} className="workspace-create">
          <label htmlFor="workspace-name">新建工作空间</label>
          <div>
            <input
              id="workspace-name"
              placeholder="输入工作空间名称"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Button className="product-primary" type="submit" disabled={busy}>
              <Plus size={17} />
              创建空间
            </Button>
          </div>
        </form>
      )}
      {loading ? (
        <div className="workspace-empty">正在加载工作空间…</div>
      ) : items.length === 0 ? (
        <div className="workspace-empty">
          {archived ? "没有已归档的工作空间。" : "还没有工作空间，创建一个开始使用。"}
        </div>
      ) : (
        <div className="workspace-grid">
          {items.map((item) => (
            <article className="workspace-card" key={item.id}>
              <span className="workspace-card-icon">
                <Layers3 size={21} />
              </span>
              {editing === item.id ? (
                <form className="rename-form" onSubmit={(e) => void rename(e, item.id)}>
                  <label>
                    工作空间名称
                    <input
                      maxLength={120}
                      required
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </label>
                  <div>
                    <Button type="submit" disabled={busy}>
                      保存
                    </Button>
                    <Button type="button" onClick={() => setEditing(null)}>
                      取消
                    </Button>
                  </div>
                </form>
              ) : (
                <>
                  <strong>{item.name}</strong>
                  <small>{archived ? "已归档，可以恢复" : "工作空间"}</small>
                  <div className="workspace-card-actions">
                    {!archived && (
                      <Button onClick={() => onSelect(item)}>
                        进入 <ArrowRight size={15} />
                      </Button>
                    )}
                    {!archived && (
                      <Button
                        onClick={() => {
                          setEditing(item.id);
                          setEditName(item.name);
                        }}
                      >
                        重命名
                      </Button>
                    )}
                    <Button disabled={busy} onClick={() => void move(item)}>
                      {archived ? "恢复" : "归档"}
                    </Button>
                  </div>
                </>
              )}
            </article>
          ))}
        </div>
      )}
      {cursor && (
        <Button
          className="subtle-button"
          onClick={() => void load(archived, cursor).catch(() => setError("加载失败，请重试。"))}
        >
          加载更多
        </Button>
      )}
    </main>
  );
}
