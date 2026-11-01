import {
  type ColumnDef,
  createPaginatedRowModel,
  createSortedRowModel,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Button } from "@workspace/ui";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { QueryCell, QueryResult } from "./query-result";
import {
  cellDisplay,
  compareResultCells,
  isNumericColumn,
  resultChartData,
  type VisualizationDefinition,
} from "./result-presentation";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

function ResultTable({ result }: { result: QueryResult }) {
  const columns = useMemo<Array<ColumnDef<typeof features, QueryCell[]>>>(
    () =>
      result.columns.map((column, index) => ({
        id: `column-${index}`,
        accessorFn: (row) => row[index],
        header: column.name,
        sortingFn: (a: { original: QueryCell[] }, b: { original: QueryCell[] }) =>
          compareResultCells(
            a.original[index] ?? { null: true },
            b.original[index] ?? { null: true },
            column.type,
          ),
        cell: (info) => cellDisplay(info.getValue<QueryCell>()),
      })),
    [result.columns],
  );
  const table = useTable({
    features,
    columns,
    data: result.rows,
    initialState: { pagination: { pageIndex: 0, pageSize: 50 } },
  });
  const pagination = table.state.pagination;
  // Reading sorting subscribes the view to order changes in TanStack's reactive state.
  const sorting = table.state.sorting;
  return (
    <>
      <p className="result-note">
        排序和分页只处理本次已返回的结果，不会重新查询数据库。数值保留精确文本。
      </p>
      <div className="read-query-table-wrap">
        <table aria-label="查询结果表格">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header, index) => (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorting.find((item) => item.id === header.column.id)?.desc === true
                        ? "descending"
                        : sorting.some((item) => item.id === header.column.id)
                          ? "ascending"
                          : "none"
                    }
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      aria-label={`按 ${result.columns[index]?.name ?? "字段"} 排序`}
                    >
                      <table.FlexRender header={header} />
                      {header.column.getIsSorted() === "asc"
                        ? " ↑"
                        : header.column.getIsSorted() === "desc"
                          ? " ↓"
                          : " ↕"}
                    </button>
                    <small>{result.columns[index]?.type}</small>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell) => (
                  <td key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="result-pagination">
        <Button
          type="button"
          disabled={!table.getCanPreviousPage()}
          onClick={() => table.previousPage()}
        >
          上一页
        </Button>
        <span>
          第 {pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())} 页 ·{" "}
          {result.rows.length} 行
        </span>
        <Button type="button" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
          下一页
        </Button>
        <label>
          每页{" "}
          <select
            value={pagination.pageSize}
            onChange={(event) => table.setPageSize(Number(event.target.value))}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size} 行
              </option>
            ))}
          </select>
        </label>
      </div>
      {!result.rows.length && <p>查询成功，未返回匹配的数据。</p>}
    </>
  );
}

/** Presentation never stores result rows or grants permission to rerun a saved definition. */
export function ResultPresentation({
  result,
  definition,
  onDefinitionChange,
  disabled = false,
}: {
  result: QueryResult;
  definition: VisualizationDefinition;
  onDefinitionChange: (definition: VisualizationDefinition) => void;
  disabled?: boolean;
}) {
  const chart = useMemo(() => resultChartData(result, definition), [result, definition]);
  const selectableColumns = useMemo(() => {
    const counts = new Map<string, number>();
    for (const column of result.columns) {
      counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    }
    return result.columns.filter((column) => counts.get(column.name) === 1);
  }, [result.columns]);
  const missing = (name: string | undefined, numeric = false) =>
    name &&
    !selectableColumns.some(
      (column) => column.name === name && (!numeric || isNumericColumn(column.type)),
    );
  const xField = (
    <label>
      分类字段
      <select
        disabled={disabled}
        value={definition.x ?? ""}
        onChange={(event) => onDefinitionChange({ ...definition, x: event.target.value })}
      >
        <option value="">请选择</option>
        {missing(definition.x) && <option value={definition.x}>已失效：{definition.x}</option>}
        {selectableColumns.map((column) => (
          <option key={column.name} value={column.name}>
            {column.name}
          </option>
        ))}
      </select>
    </label>
  );
  const yField = (
    <label>
      数值字段
      <select
        disabled={disabled}
        value={definition.y ?? ""}
        onChange={(event) => onDefinitionChange({ ...definition, y: event.target.value })}
      >
        <option value="">请选择</option>
        {missing(definition.y, true) && (
          <option value={definition.y}>已失效：{definition.y}</option>
        )}
        {selectableColumns.map(
          (column) =>
            isNumericColumn(column.type) && (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ),
        )}
      </select>
    </label>
  );
  return (
    <section className="result-presentation" aria-label="结果展示">
      <div className="result-presentation-controls">
        <label>
          展示方式
          <select
            disabled={disabled}
            value={definition.kind}
            onChange={(event) =>
              onDefinitionChange({
                ...definition,
                kind: event.target.value as VisualizationDefinition["kind"],
              })
            }
          >
            <option value="table">表格</option>
            <option value="bar">柱状图</option>
            <option value="line">折线图</option>
          </select>
        </label>
        {definition.kind !== "table" && (
          <>
            {xField}
            {yField}
          </>
        )}
      </div>
      {definition.kind !== "table" &&
        (chart.ok ? (
          <>
            <p className="result-note">
              每个图形对应一条结果行，按查询返回顺序展示，不进行分组或汇总。标签最多显示 120
              个字符，精确原值可在下方表格中查看。
              {chart.nullCount ? ` ${chart.nullCount} 个空值显示为空缺。` : ""}
            </p>
            {result.truncated && (
              <p role="status">图表仅包含已返回的截断结果，不能代表完整数据。</p>
            )}
            <div
              className="result-chart"
              role="img"
              aria-label={`${definition.kind === "bar" ? "柱状图" : "折线图"}：${definition.x}与${definition.y}`}
            >
              <ResponsiveContainer width="100%" height={300}>
                {definition.kind === "bar" ? (
                  <BarChart data={chart.points} accessibilityLayer>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip
                      formatter={(_value, _name, item) => [
                        item.payload?.exactValue ?? "NULL",
                        definition.y ?? "",
                      ]}
                    />
                    <Bar dataKey="value" fill="#7c68d8" isAnimationActive={false} />
                  </BarChart>
                ) : (
                  <LineChart data={chart.points} accessibilityLayer>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="label" />
                    <YAxis />
                    <Tooltip
                      formatter={(_value, _name, item) => [
                        item.payload?.exactValue ?? "NULL",
                        definition.y ?? "",
                      ]}
                    />
                    <Line
                      dataKey="value"
                      stroke="#7c68d8"
                      dot={chart.points.length <= 50}
                      connectNulls={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                )}
              </ResponsiveContainer>
            </div>
          </>
        ) : (
          <p role="alert">{chart.message}</p>
        ))}
      <ResultTable key={result.columns.map((column) => column.name).join("|")} result={result} />
    </section>
  );
}
