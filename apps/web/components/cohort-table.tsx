"use client";

import { useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

/**
 * Tabla ordenable genérica. Todas las pantallas de datos tabulares
 * (marginal, discovery, hipótesis, plugins) pasan por aquí en vez de montar
 * su propia tabla — es la pieza que le da a TanStack Table su único punto de
 * entrada, y mantiene el estilo consistente en todo el dashboard.
 */
export interface CohortTableProps<T> {
  readonly columns: ColumnDef<T, any>[];
  readonly data: readonly T[];
  readonly initialSort?: SortingState;
  readonly onRowClick?: (row: T) => void;
  readonly emptyMessage?: string;
}

export function CohortTable<T>({
  columns,
  data,
  initialSort = [],
  onRowClick,
  emptyMessage = "Sin resultados.",
}: CohortTableProps<T>): JSX.Element {
  const [sorting, setSorting] = useState<SortingState>(initialSort);

  const table = useReactTable({
    data: data as T[],
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (data.length === 0) {
    return <div className="panel px-4 py-8 text-center text-sm text-base-400">{emptyMessage}</div>;
  }

  return (
    <div className="panel overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-base-800">
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="table-cell cursor-pointer select-none whitespace-nowrap text-xs font-medium uppercase tracking-wide text-base-400 hover:text-base-100"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className={`border-b border-base-800 last:border-0 ${
                onRowClick ? "cursor-pointer hover:bg-base-850" : ""
              }`}
              onClick={onRowClick ? () => onRowClick(row.original) : undefined}
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="table-cell whitespace-nowrap text-base-100">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
