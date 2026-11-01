import { api } from "./api.ts";
import type { HistoryRecord } from "./history-model.ts";

export type HistoryKind = "conversation" | "artifact" | "execution";
export function historyBase(workspace: string, source: string, kind: HistoryKind): string {
  return `/api/history/${encodeURIComponent(workspace)}/${encodeURIComponent(source)}/${kind}`;
}
export const historyRequest = <T>(path: string, options: RequestInit = {}) =>
  api<T>(path, { ...options, signal: AbortSignal.timeout(8000) });
export function putHistory<T>(path: string, revision: number, content: T) {
  return historyRequest<Pick<HistoryRecord<T>, "id" | "revision">>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, content }),
  });
}
export function setHistoryDeleted(path: string, revision: number, deleted: boolean) {
  return historyRequest<unknown>(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, deleted }),
  });
}
