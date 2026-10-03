/** The dashboard runs on calendar years (Jan–Dec). Statements arrive in whatever span the bank or app exports
 *  (often April–March); that only decides which months have data, not how years are cut.
 *
 *  Dates are read from the stored local timestamp ("2025-12-31T23:30:00+05:30"), not converted through the
 *  browser clock, so a payment late on 31 December stays in December. */

export type PeriodKey = number | 'all'

export const yearOf = (iso: string) => Number(iso.slice(0, 4))
export const monthKey = (iso: string) => iso.slice(0, 7) // "2025-04"

export const periodLabel = (p: PeriodKey) => (p === 'all' ? 'All years' : String(p))

export function inPeriod(iso: string, period: PeriodKey) {
  return period === 'all' || yearOf(iso) === period
}

/** Month keys a period covers, in order: Jan–Dec for a year; first to last month with data for 'all'. */
export function monthsOf(period: PeriodKey, dates: string[]): string[] {
  let startY: number, startM: number, endY: number, endM: number
  if (period === 'all') {
    if (!dates.length) return []
    const sorted = dates.map(monthKey).sort()
    ;[startY, startM] = sorted[0].split('-').map(Number)
    ;[endY, endM] = sorted[sorted.length - 1].split('-').map(Number)
  } else {
    ;[startY, startM, endY, endM] = [period, 1, period, 12]
  }
  const out: string[] = []
  for (let y = startY, m = startM; y < endY || (y === endY && m <= endM); m === 12 ? (y++, (m = 1)) : m++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  return out
}

const monthShort = new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' })
const monthLong = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthYearShort = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const asUTC = (key: string) => new Date(`${key}-01T00:00:00Z`)
export const monthLabel = (key: string) => monthShort.format(asUTC(key))
export const monthLongLabel = (key: string) => monthLong.format(asUTC(key))
export const monthYearLabel = (key: string) => monthYearShort.format(asUTC(key))

function nextMonth(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Month keys as readable runs, gaps included: "Jan–Mar 2026, Sept 2026" or "Apr 2024 – Mar 2025". */
export function spanLabel(keys: string[]): string | null {
  const sorted = [...new Set(keys)].sort()
  if (!sorted.length) return null
  const runs: [string, string][] = []
  for (const k of sorted) {
    const last = runs[runs.length - 1]
    if (last && nextMonth(last[1]) === k) last[1] = k
    else runs.push([k, k])
  }
  if (runs.length > 3) return `${sorted.length} months between ${monthYearLabel(sorted[0])} and ${monthYearLabel(sorted[sorted.length - 1])}`
  return runs
    .map(([a, b]) =>
      a === b
        ? monthYearLabel(a)
        : a.slice(0, 4) === b.slice(0, 4)
          ? `${monthLabel(a)}–${monthLabel(b)} ${a.slice(0, 4)}`
          : `${monthYearLabel(a)} – ${monthYearLabel(b)}`,
    )
    .join(', ')
}

// Day and time come straight from the stored local timestamp.
const dayFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
export const dayLabel = (iso: string) => dayFmt.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`))
export function timeLabel(iso: string) {
  const [h, m] = iso.slice(11, 16).split(':').map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`
}
