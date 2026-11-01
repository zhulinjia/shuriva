export type SemanticEntry = {
  name: string;
} & (
  | { table: string; column?: string }
  | { from: { table: string; column: string } }
  | { field: { table: string; column: string } }
);

/** JSON tuples avoid ambiguity for legal identifiers containing separators. */
export function semanticEntryKey(item: SemanticEntry): string {
  if ("table" in item)
    return JSON.stringify(
      "column" in item ? ["field", item.table, item.column] : ["entity", item.table],
    );
  return JSON.stringify(["from" in item ? "relation" : "metric", item.name]);
}

export function updateSemanticEntry<T extends SemanticEntry>(
  entries: readonly T[],
  editing: string | null,
  item: T,
): T[] {
  const index =
    editing === null ? -1 : entries.findIndex((entry) => semanticEntryKey(entry) === editing);
  if (editing !== null && index === -1) throw new Error("ENTRY_CHANGED");
  const key = semanticEntryKey(item);
  if (entries.some((entry, position) => position !== index && semanticEntryKey(entry) === key))
    throw new Error("DUPLICATE");
  const result = [...entries];
  if (index === -1) result.push(item);
  else result[index] = item;
  return result;
}

export type SemanticGuard = { pending: boolean; busy: boolean };
export const emptySemanticGuard = (): SemanticGuard => ({ pending: false, busy: false });

/** Navigation and local editor transitions share the same explicit discard decision. */
export function confirmSemanticLeave(
  state: SemanticGuard,
  dialogs: { confirm: (message: string) => boolean; alert: (message: string) => void },
): boolean {
  if (state.busy) {
    dialogs.alert("正在处理数据源或业务语义，请等待完成后再操作。");
    return false;
  }
  return (
    !state.pending ||
    dialogs.confirm("业务语义有未保存的内容。确定丢弃这些内容并继续？取消可保留输入。")
  );
}
