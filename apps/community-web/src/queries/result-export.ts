import type { QueryResult } from "./query-result.ts";

/** JSON preserves exact decimal text, binary encoding, nulls and truncation metadata. */
export function encodeResultExport(result: QueryResult): string {
  return `${JSON.stringify({ format: "ai-workspace-query-result", version: 1, ...result }, null, 2)}\n`;
}

/** Authorization may complete after the user changed data source or result.
 * A download is valid only while the exact reviewed intent remains current. */
export async function exportReviewedResult<T extends { result: QueryResult }>(
  intent: T,
  matches: (intent: T) => boolean,
  authorize: (intent: T) => Promise<unknown>,
  download: (result: QueryResult) => void,
): Promise<"stale" | "exported" | "download-failed"> {
  if (!matches(intent)) return "stale";
  await authorize(intent);
  if (!matches(intent)) return "stale";
  try {
    download(intent.result);
    return "exported";
  } catch {
    return "download-failed";
  }
}

export function downloadResult(result: QueryResult): void {
  const data = new Blob([encodeResultExport(result)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(data);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "query-result.json";
    link.click();
  } finally {
    // Allow the browser to begin the download before releasing the object URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
