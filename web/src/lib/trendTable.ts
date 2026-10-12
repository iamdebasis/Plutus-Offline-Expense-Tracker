import { monthLabel, monthLongLabel } from './periods'
import type { Trend } from './totals'

/** A figure in the table: null where no file covers the month (shown "—", never ₹0); `estimate` where it's worked out
 *  from a card bill rather than read one by one (shown "≈"). */
export interface Cell {
  value: number | null
  estimate: boolean
}
export interface TableRow {
  id: string
  label: string
  cells: Cell[]
  /** The line's own figure for the period (its chip), which its months add up to (tests/totals.test.ts). */
  total: number
  estimate: boolean
}
export interface TrendTableData {
  /** `label` heads the column ("Jan", "2025"); `title` says it in full ("January 2026"). */
  columns: { key: string; label: string; title: string }[]
  rows: TableRow[]
  /** Each column summed over the rows, when there's more than one. */
  together: { cells: Cell[]; total: number; estimate: boolean } | null
}

/** The month-by-month lines as a table: a row a line (a category, a card), in the order given (the chips'), and a
 *  column a month; when the months span more than one calendar year (All years), a column a year instead, each the sum
 *  of its months, so the table stays a dozen columns wide. The same numbers the chart draws. */
export function trendTable(months: string[], series: Trend[]): TrendTableData {
  const years = [...new Set(months.map((k) => k.slice(0, 4)))]
  const byYear = years.length > 1
  const columns = byYear
    ? years.map((y) => ({ key: y, label: y, title: y }))
    : months.map((k) => ({ key: k, label: monthLabel(k), title: monthLongLabel(k) }))
  // which months make each column
  const parts = byYear ? years.map((y) => months.flatMap((k, i) => (k.startsWith(y) ? [i] : []))) : months.map((_, i) => [i])

  const rows = series.map((s) => {
    const cells = parts.map((idx) => {
      const known = idx.filter((i) => s.values[i] !== null)
      return {
        value: known.length ? known.reduce((sum, i) => sum + s.values[i]!, 0) : null,
        estimate: known.some((i) => !!s.dashed || !!s.estimated?.[i]),
      }
    })
    return { id: s.id, label: s.label, cells, total: s.amount, estimate: cells.some((c) => c.estimate) }
  })

  const together =
    rows.length > 1
      ? {
          cells: columns.map((_, j) => {
            const known = rows.map((r) => r.cells[j]).filter((c) => c.value !== null)
            return { value: known.length ? known.reduce((sum, c) => sum + c.value!, 0) : null, estimate: known.some((c) => c.estimate) }
          }),
          total: rows.reduce((sum, r) => sum + r.total, 0),
          estimate: rows.some((r) => r.estimate),
        }
      : null
  return { columns, rows, together }
}
