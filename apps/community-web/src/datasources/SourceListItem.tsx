import { Button } from "@workspace/ui";
import { useState } from "react";
import { type Connector, connectorStatus, type Scan, type Source } from "./source-types";

type SourceActions = {
  restore: () => Promise<boolean>;
  reassign: (connectorId: string) => Promise<boolean>;
  rename: (name: string) => Promise<boolean>;
  archive: () => Promise<boolean>;
  bind: () => Promise<boolean>;
  setDefault: () => Promise<boolean>;
  scan: () => Promise<boolean>;
  unbind: () => Promise<boolean>;
  view: () => void;
};
type Context = {
  archived: boolean;
  busy: boolean;
  workspace: string;
  binding?: Source;
  scan: Scan;
  connectors: Connector[];
};
const failure: Record<string, string> = {
  connection: "无法连接数据库",
  permissions: "账号权限超出支持的只读范围",
  scope: "数据源不允许该工作空间",
  limit: "结构超过扫描限制",
  metadata: "无法读取完整结构",
  local_config: "Connector 本机缺少数据源配置",
};

/** Owns only the row's transient editing and confirmation UI. */
export function SourceListItem({
  item,
  context,
  actions,
}: {
  item: Source;
  context: Context;
  actions: SourceActions;
}) {
  const { archived, busy, workspace, binding, scan, connectors } = context;
  const [reassigning, setReassigning] = useState(false);
  const [newConnector, setNewConnector] = useState("");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [confirm, setConfirm] = useState(false);

  return (
    <li>
      <div>
        <strong>{item.name}</strong>
        <small>
          {archived
            ? "已归档"
            : binding
              ? binding.isDefault
                ? "已绑定 · 默认"
                : "已绑定"
              : "未绑定"}
        </small>
        {scan && (
          <small>
            扫描：
            {scan.status === "pending"
              ? "等待连接器"
              : scan.status === "completed"
                ? "已完成"
                : scan.status === "expired"
                  ? "已超时，请重试"
                  : scan.status === "failed"
                    ? (failure[scan.errorCode ?? ""] ?? "失败")
                    : "已取消"}
          </small>
        )}
      </div>
      {archived ? (
        <Button disabled={busy} onClick={() => void actions.restore()}>
          恢复
        </Button>
      ) : (
        <>
          {reassigning ? (
            <div>
              <p>
                请先解除所有工作空间与此数据源的绑定，并在新 Connector 所在机器配置相同的数据源
                ID。相同机器迁移前，请停止新旧 Connector，然后运行：
              </p>
              <code className="connector-command">
                go run ./cmd/connector source adopt --id {item.id} --from {item.connectorId}{" "}
                --confirm-both-stopped
              </code>
              <p>
                不同机器请参考 Connector 使用说明，以相同 ID
                在新机器添加数据源并安全清理旧凭据。重新关联会保留历史快照。
              </p>
              <label>
                新连接器
                <select value={newConnector} onChange={(e) => setNewConnector(e.target.value)}>
                  <option value="">请选择</option>
                  {connectors
                    .filter((c) => c.status !== "revoked" && c.id !== item.connectorId)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}（{connectorStatus[c.status] ?? "状态未知"}）
                      </option>
                    ))}
                </select>
              </label>
              <Button
                disabled={busy || !newConnector}
                onClick={() =>
                  void actions.reassign(newConnector).then((ok) => {
                    if (ok) setReassigning(false);
                  })
                }
              >
                确认重新关联
              </Button>
              <Button disabled={busy} onClick={() => setReassigning(false)}>
                取消关联
              </Button>
            </div>
          ) : (
            <Button
              disabled={busy}
              onClick={() => {
                setReassigning(true);
                setNewConnector("");
              }}
            >
              更换连接器
            </Button>
          )}
          {editing ? (
            <>
              <input
                aria-label="新的数据源名称"
                maxLength={120}
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
              <Button
                disabled={busy || !editName.trim()}
                onClick={() =>
                  void actions.rename(editName).then((ok) => {
                    if (ok) setEditing(false);
                  })
                }
              >
                保存名称
              </Button>
              <Button disabled={busy} onClick={() => setEditing(false)}>
                取消重命名
              </Button>
            </>
          ) : (
            <Button
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setEditName(item.name);
              }}
            >
              重命名
            </Button>
          )}
          {archiveConfirm ? (
            <>
              <span>仅可归档未被任何工作空间绑定的数据源，历史快照保留。</span>
              <Button
                disabled={busy}
                onClick={() =>
                  void actions.archive().then((ok) => {
                    if (ok) setArchiveConfirm(false);
                  })
                }
              >
                确认归档
              </Button>
              <Button disabled={busy} onClick={() => setArchiveConfirm(false)}>
                取消归档
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => setArchiveConfirm(true)}>
              归档数据源
            </Button>
          )}
          {!binding ? (
            <Button disabled={busy || !workspace} onClick={() => void actions.bind()}>
              绑定
            </Button>
          ) : (
            <>
              <Button
                disabled={busy || !!binding.isDefault}
                onClick={() => void actions.setDefault()}
              >
                设为默认
              </Button>
              <Button
                disabled={busy || scan?.status === "pending"}
                onClick={() => void actions.scan()}
              >
                测试连接并扫描
              </Button>
              <Button disabled={busy} onClick={actions.view}>
                查看结构
              </Button>
              {confirm ? (
                <>
                  <span>解绑后停止接收结果。</span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void actions.unbind().then((ok) => {
                        if (ok) setConfirm(false);
                      })
                    }
                  >
                    确认解绑
                  </Button>
                  <Button disabled={busy} onClick={() => setConfirm(false)}>
                    取消
                  </Button>
                </>
              ) : (
                <Button disabled={busy} onClick={() => setConfirm(true)}>
                  解绑
                </Button>
              )}
            </>
          )}
        </>
      )}
    </li>
  );
}
