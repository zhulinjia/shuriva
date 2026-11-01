import type { QueryCell, QueryResult } from "./query-result.ts";

export type VisualizationDefinition = { kind: "table" | "bar" | "line"; x?: string; y?: string };

export function isNumericColumn(type: string): boolean {
  return /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT|LONGLONG|DECIMAL|NEWDECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)(?:\b|$)/i.test(
    type,
  );
}

type Decimal = { negative: boolean; digits: string; exponent: number };
function decimal(value: string): Decimal | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  let digits = `${match[2]}${fraction}`.replace(/^0+/, "");
  if (!digits) return { negative: false, digits: "0", exponent: 0 };
  const normalized = digits.replace(/0+$/, "");
  const exponent = Number(match[4] ?? 0) - fraction.length + digits.length - normalized.length;
  digits = normalized;
  return { negative: match[1] === "-", digits, exponent };
}

function compareDecimal(a: Decimal, b: Decimal): number {
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude = (value: Decimal) =>
    value.digits === "0" ? -Infinity : value.digits.length + value.exponent;
  const left = magnitude(a),
    right = magnitude(b);
  const size = Math.max(a.digits.length, b.digits.length);
  const order =
    left !== right
      ? left < right
        ? -1
        : 1
      : a.digits.padEnd(size, "0") < b.digits.padEnd(size, "0")
        ? -1
        : a.digits.padEnd(size, "0") > b.digits.padEnd(size, "0")
          ? 1
          : 0;
  return a.negative ? -order : order;
}

/** Exact numeric comparison avoids converting DECIMAL/BIGINT values to JS floating point. */
export function compareResultCells(a: QueryCell, b: QueryCell, type: string): number {
  const classify = (cell: QueryCell) => {
    if (cell.null) return { rank: 0, value: "", number: null };
    const value = cell.value ?? "";
    if (cell.encoding === "base64") return { rank: 3, value, number: null };
    const number = isNumericColumn(type) ? decimal(value) : null;
    return { rank: number ? 1 : 2, value, number };
  };
  const left = classify(a),
    right = classify(b);
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.number && right.number) return compareDecimal(left.number, right.number);
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

export function cellDisplay(cell: QueryCell): string {
  if (cell.null) return "NULL";
  if (cell.encoding === "base64") return `Base64: ${cell.value ?? ""}`;
  return cell.value === undefined || cell.value === "" ? "（空文本）" : cell.value;
}

export type ChartPoint = { label: string; value: number | null; exactValue: string };
export type ChartData =
  | { ok: true; points: ChartPoint[]; nullCount: number }
  | { ok: false; message: string };

/** Chart coordinates require a safe decimal round trip. Exact values remain in tooltips/table. */
export function resultChartData(
  result: QueryResult,
  definition: VisualizationDefinition,
): ChartData {
  if (!definition.x || !definition.y) return { ok: false, message: "请选择分类字段和数值字段。" };
  const find = (name: string) => {
    const found: number[] = [];
    result.columns.forEach((column, index) => {
      if (column.name === name) found.push(index);
    });
    return found;
  };
  const xs = find(definition.x),
    ys = find(definition.y);
  if (xs.length !== 1 || ys.length !== 1)
    return { ok: false, message: "图表引用的字段已变化或重名，请重新选择字段。" };
  const x = xs[0],
    y = ys[0];
  if (x === undefined || y === undefined || !isNumericColumn(result.columns[y]?.type ?? ""))
    return { ok: false, message: "纵轴必须是数值类型字段。" };
  if (!result.rows.length) return { ok: false, message: "当前没有结果行，无法绘制图表。" };
  if (result.rows.length > 500)
    return {
      ok: false,
      message: "当前结果超过 500 行，请缩小查询范围后绘图。表格仍保留全部已返回行。",
    };
  let nullCount = 0;
  const points: ChartPoint[] = [];
  for (const row of result.rows) {
    const label = row[x],
      cell = row[y];
    if (!label || !cell || (!label.null && label.encoding !== "text"))
      return { ok: false, message: "分类字段包含二进制内容，请选择其他字段。" };
    let value: number | null = null;
    const exactValue = cell.null ? "NULL" : (cell.value ?? "");
    if (cell.null) nullCount++;
    else {
      const exact = cell.encoding === "text" ? decimal(exactValue) : null;
      const numeric = Number(exactValue);
      const roundtrip = decimal(String(numeric));
      if (
        !exact ||
        !Number.isFinite(numeric) ||
        Math.abs(numeric) > Number.MAX_SAFE_INTEGER ||
        !roundtrip ||
        compareDecimal(exact, roundtrip) !== 0 ||
        (numeric !== 0 && Math.abs(numeric) < 1e-100)
      )
        return { ok: false, message: "数值超出安全绘图精度或范围，请使用表格查看精确值。" };
      value = numeric;
    }
    points.push({ label: cellDisplay(label).slice(0, 120), value, exactValue });
  }
  if (nullCount === points.length)
    return { ok: false, message: "数值字段全部为空，无法绘制图表。" };
  return { ok: true, points, nullCount };
}
