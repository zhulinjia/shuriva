export type QueryCell =
  | { null: true }
  | { null: false; encoding: "text" | "base64"; value?: string };
export type QueryResult = {
  columns: { name: string; type: string }[];
  rows: QueryCell[][];
  timezone: "UTC";
  truncated: boolean;
  reason?: "rows" | "bytes" | "cell";
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Results cross a trust boundary. Keep display data bounded and text-only. */
export function decodeQueryResult(payload: string): QueryResult {
  if (payload.length < 1 || payload.length > 1_398_102 || !/^[A-Za-z0-9_-]+$/.test(payload))
    throw new Error("invalid result");
  const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
  if (binary.length > 1_048_576) throw new Error("invalid result");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !object(parsed) ||
    parsed.timezone !== "UTC" ||
    typeof parsed.truncated !== "boolean" ||
    !Array.isArray(parsed.columns) ||
    parsed.columns.length < 1 ||
    parsed.columns.length > 256 ||
    !Array.isArray(parsed.rows) ||
    parsed.rows.length > 1000 ||
    (parsed.truncated
      ? !["rows", "bytes", "cell"].includes(String(parsed.reason))
      : parsed.reason !== undefined)
  )
    throw new Error("invalid result");
  const columns = parsed.columns.map((column: unknown) => {
    if (
      !object(column) ||
      typeof column.name !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(column.name) ||
      typeof column.type !== "string" ||
      column.type.length < 1 ||
      column.type.length > 64
    )
      throw new Error("invalid result");
    return { name: column.name, type: column.type };
  });
  const rows = parsed.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== columns.length) throw new Error("invalid result");
    return row.map((cell: unknown): QueryCell => {
      if (!object(cell)) throw new Error("invalid result");
      if (cell.null === true && Object.keys(cell).length === 1) return { null: true };
      if (
        Object.keys(cell).some((key) => !["null", "encoding", "value"].includes(key)) ||
        cell.null !== false ||
        (cell.encoding !== "text" && cell.encoding !== "base64") ||
        (cell.value !== undefined && typeof cell.value !== "string") ||
        (typeof cell.value === "string" && cell.value.length > 43_692)
      )
        throw new Error("invalid result");
      const content = cell.value ?? "";
      if (cell.encoding === "text" && new TextEncoder().encode(content).length > 32_768)
        throw new Error("invalid result");
      if (cell.encoding === "base64") {
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error("invalid result");
        const decoded = atob(content);
        if (decoded.length > 32_768 || btoa(decoded) !== content) throw new Error("invalid result");
      }
      return {
        null: false,
        encoding: cell.encoding,
        ...(cell.value === undefined ? {} : { value: cell.value }),
      };
    });
  });
  const reason = parsed.reason;
  if (reason !== undefined && reason !== "rows" && reason !== "bytes" && reason !== "cell")
    throw new Error("invalid result");
  return {
    columns,
    rows,
    timezone: "UTC",
    truncated: parsed.truncated,
    ...(reason === undefined ? {} : { reason }),
  };
}
