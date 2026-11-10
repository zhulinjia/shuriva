import { flexRender } from "@tanstack/react-table"
import type { RowData } from "@tanstack/react-table"
import { getCoreRowModel, useLegacyTable } from "@tanstack/react-table/legacy"
import type { LegacyColumnDef } from "@tanstack/react-table/legacy"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/** A data table composition. Data fetching, pagination and permissions belong to its caller. */
export function DataTable<TData extends RowData>({ columns, data, emptyText = "暂无数据" }: { columns: LegacyColumnDef<TData, unknown>[]; data: TData[]; emptyText?: string }) {
  const table = useLegacyTable<TData>({ data, columns, getCoreRowModel: getCoreRowModel() })
  return <div className="overflow-x-auto"><Table><TableHeader>{table.getHeaderGroups().map((group) => <TableRow key={group.id}>{group.headers.map((header) => <TableHead key={header.id}>{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader><TableBody>{table.getRowModel().rows.length ? table.getRowModel().rows.map((row) => <TableRow key={row.id}>{row.getVisibleCells().map((cell) => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>) : <TableRow><TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">{emptyText}</TableCell></TableRow>}</TableBody></Table></div>
}
