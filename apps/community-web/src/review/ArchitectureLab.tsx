import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatWorkspace } from "../chat/ChatWorkspace";
import { DataSourceManager } from "../datasources/DataSourceManager";
import { ReadQueryPanel } from "../queries/ReadQueryPanel";
import "../styles.css";
import "../product.css";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
function ArchitectureLab() {
  const [view, setView] = useState<"sources" | "chat" | "query">("sources");
  return (
    <>
      <aside style={{ padding: 16, background: "#e8f1fd" }}>
        <strong>独立界面回归：虚构数据、本机模拟接口</strong>{" "}
        <button type="button" onClick={() => setView("sources")}>
          数据源管理
        </button>
        {" · "}
        <button type="button" onClick={() => setView("chat")}>
          AI 对话
        </button>
        {" · "}
        <button type="button" onClick={() => setView("query")}>
          只读查询
        </button>
      </aside>
      {view === "sources" ? (
        <DataSourceManager onBack={() => {}} />
      ) : view === "chat" ? (
        <ChatWorkspace workspaceId={workspaceId} workspaceName="模拟工作区" onBack={() => {}} />
      ) : (
        <main className="settings-page">
          <ReadQueryPanel workspaceId={workspaceId} sourceId={sourceId} sourceName="模拟数据源 A" />
        </main>
      )}
    </>
  );
}
const root = document.getElementById("root");
if (!root) throw Error("isolated review root missing");
createRoot(root).render(<ArchitectureLab />);
