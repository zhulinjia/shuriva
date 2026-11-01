import { Button } from "@workspace/ui";
import type { SchemaContent } from "./schema-diff";

export type Snapshot = { id: string; version: string; createdAt: string; content: SchemaContent };
export type SnapshotVersion = { id: string; version: string; createdAt: string };
export type SnapshotSelection = { id: string; source: string; value: Snapshot };
type SnapshotActions = {
  selectVersion: (id: string) => Promise<void>;
  moreVersions: () => Promise<void>;
  comparePrevious: () => Promise<void>;
};
export function SnapshotPanel({
  snapshot,
  versions,
  versionCursor,
  changes,
  busy,
  actions,
}: {
  snapshot: SnapshotSelection;
  versions: SnapshotVersion[];
  versionCursor: string | null;
  changes: string[] | null;
  busy: boolean;
  actions: SnapshotActions;
}) {
  return (
    <section className="settings-card">
      <h2>{snapshot.source} · 结构快照</h2>
      <label>
        历史版本{" "}
        <select
          value={snapshot.value.id}
          disabled={busy}
          onChange={(e) => void actions.selectVersion(e.target.value)}
        >
          {versions.map((item) => (
            <option key={item.id} value={item.id}>
              版本 {item.version} · {new Date(item.createdAt).toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      {versionCursor && (
        <Button
          className="subtle-button"
          disabled={busy}
          onClick={() => void actions.moreVersions()}
        >
          加载更多版本
        </Button>
      )}
      <p>
        版本 {snapshot.value.version} · 数据库 {snapshot.value.content.database} · 扫描于{" "}
        {new Date(snapshot.value.createdAt).toLocaleString()} · 数据库版本{" "}
        {snapshot.value.content.serverVersion}
      </p>
      <p>快照可能随数据库结构变化而过时；失败时保留上次成功的结果。</p>
      {versions.findIndex((item) => item.id === snapshot.value.id) >= 0 &&
        versions[versions.findIndex((item) => item.id === snapshot.value.id) + 1] && (
          <Button
            className="subtle-button"
            disabled={busy}
            onClick={() => void actions.comparePrevious()}
          >
            比较上一版本
          </Button>
        )}
      {changes &&
        (changes.length === 0 ? (
          <p>与上一版本相比没有结构变化。</p>
        ) : (
          <div>
            <p>与上一版本相比：</p>
            <ul>
              {changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          </div>
        ))}
      {snapshot.value.content.tables.length === 0 ? (
        <p>没有可见的表或视图。</p>
      ) : (
        snapshot.value.content.tables.map((table) => (
          <details key={table.name}>
            <summary>
              {table.name}（{table.kind === "VIEW" ? "视图" : "表"}）
            </summary>
            <ul>
              {snapshot.value.content.columns
                .filter((column) => column.table === table.name)
                .map((column) => (
                  <li key={column.name}>
                    {column.name} · {column.type} · {column.nullable ? "可空" : "非空"}
                  </li>
                ))}
            </ul>
            {snapshot.value.content.relations
              .filter((relation) => relation.table === table.name)
              .map((relation) => (
                <p
                  key={`${relation.column}:${relation.referencedTable}:${relation.referencedColumn}`}
                >
                  {relation.column} → {relation.referencedTable}.{relation.referencedColumn}
                </p>
              ))}
          </details>
        ))
      )}
      {snapshot.value.content.externalRelationsOmitted > 0 && (
        <p>存在范围外的外键关系，未展示具体目标。</p>
      )}
    </section>
  );
}
