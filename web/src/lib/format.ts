export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const monthYear = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric' })
const dayMonth = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short' })

export function formatPeriod(period: { start: string; end: string } | null): string | null {
  if (!period) return null
  const [a, b] = [new Date(period.start), new Date(period.end)]
  const [ma, mb] = [monthYear.format(a), monthYear.format(b)]
  return ma === mb ? ma : `${ma} – ${mb}`
}

export function formatDay(iso: string): string {
  return dayMonth.format(new Date(iso))
}

const dayMonthYear = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

/** A statement's span, with its year: "13 Aug – 12 Sep 2026", or "1 Apr 2026 – 31 Mar 2027" across two years. */
export function formatSpan(start: string, end: string): string {
  const [a, b] = [new Date(start), new Date(end)]
  return `${a.getFullYear() === b.getFullYear() ? dayMonth.format(a) : dayMonthYear.format(a)} – ${dayMonthYear.format(b)}`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Keeps the start and the end of a long path, which are the parts that say where it is. */
export function shortPath(path: string, max = 56): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  const head = parts[0] === '' ? `/${parts[1]}` : parts[0]
  let tail = parts[parts.length - 1]
  for (let i = parts.length - 2; i > 1 && head.length + tail.length + parts[i].length + 3 <= max; i--) tail = `${parts[i]}/${tail}`
  return `${head}/…/${tail}`
}
