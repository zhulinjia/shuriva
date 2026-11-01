import { api, post } from "../api.ts";
import type { Source } from "./source-types.ts";

const batchSize = 100;
export type BoundPage = { sources: Source[]; nextCursor: string | null };

/** An error is a settled state even if no response established the current key. */
export function bindingIsLoading(
  workspace: string,
  pending: boolean,
  error: boolean,
  loadedKey: string,
  scopeKey: string,
): boolean {
  return !!workspace && (pending || (!error && loadedKey !== scopeKey));
}

/** A poll covers one visible global page plus at most the selected and snapshot
 * sources. Page-independent identities must be explicitly included. */
export function bindingScope(
  visible: readonly string[],
  selected: string,
  snapshot: string,
): string[] {
  if (visible.length > batchSize) throw Error("source page exceeds server limit");
  return [...new Set([...visible, selected, snapshot].filter(Boolean))];
}

export async function loadBindingStatus(
  workspace: string,
  sourceIds: readonly string[],
  request: typeof api = api,
): Promise<Source[]> {
  if (sourceIds.length > batchSize + 2 || new Set(sourceIds).size !== sourceIds.length)
    throw Error("invalid source status scope");
  const all: Source[] = [];
  for (let offset = 0; offset < sourceIds.length; offset += batchSize) {
    const batch = sourceIds.slice(offset, offset + batchSize);
    const result = await request<{ sources: Source[] }>(
      `/api/data-sources/workspaces/${encodeURIComponent(workspace)}/status`,
      { ...post({ sourceIds: batch }), signal: AbortSignal.timeout(4000) },
    );
    if (
      !Array.isArray(result.sources) ||
      result.sources.length > batch.length ||
      result.sources.some(
        (item) => !item || typeof item.id !== "string" || !batch.includes(item.id),
      ) ||
      new Set(result.sources.map((item) => item.id)).size !== result.sources.length
    )
      throw Error("invalid source status response");
    all.push(...result.sources);
  }
  return all;
}

export function loadBoundPage(
  workspace: string,
  after: string,
  request: typeof api = api,
): Promise<BoundPage> {
  const query = new URLSearchParams();
  if (after) query.set("after", after);
  return request<BoundPage>(
    `/api/data-sources/workspaces/${encodeURIComponent(workspace)}?${query}`,
    { signal: AbortSignal.timeout(4000) },
  );
}
