import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { inr, inrCompact } from '../../lib/money'
import { monthLabel, monthLongLabel } from '../../lib/periods'
import { niceScale } from '../../lib/scale'

interface Month {
  key: string
  spent: number
  count: number
}

const PLOT_H = 190
const AXIS_H = 26
const LEFT = 52
const TOP = 18

/** One series of monthly columns. Thin bars, 4px rounded tops, hairline grid, value on the peak only;
 *  every column is its own hover/focus target, and a table view carries the same numbers. */
export function MonthlyChart({
  months,
  title,
  covered,
  noun = 'payment',
  source = 'data',
}: {
  months: Month[]
  title: string
  /** Months the underlying files actually cover; others read "no data", not "₹0". */
  covered?: Set<string>
  noun?: string
  source?: string
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    setWidth(Math.max(260, el.clientWidth))
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(260, entry.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [asTable]) // the chart's wrapper is re-created when switching back from the table view

  const { ticks, max } = useMemo(() => niceScale(Math.max(...months.map((m) => m.spent), 0)), [months])
  const plotW = Math.max(width - LEFT - 8, 1)
  const band = plotW / Math.max(months.length, 1)
  const barW = Math.min(24, band * 0.56)
  const y = (v: number) => TOP + PLOT_H - (max ? (v / max) * PLOT_H : 0)
  const peak = months.reduce((best, m, i) => (m.spent > (months[best]?.spent ?? 0) ? i : best), 0)
  const showEvery = band < 30 ? Math.ceil(30 / band) : 1

  return (
    <figure className="relative min-w-0">
      <figcaption className="mb-3 flex items-center justify-between gap-3">
        <span className="text-sm text-zinc-400">{title}</span>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          className="rounded-full px-2.5 py-1 text-xs text-zinc-500 transition hover:bg-white/[0.05] hover:text-zinc-200"
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </figcaption>

      {asTable ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500">
            <tr>
              <th className="py-1.5 font-normal">Month</th>
              <th className="py-1.5 text-right font-normal">Spent</th>
              <th className="py-1.5 text-right font-normal">Payments</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {months.map((m) => (
              <tr key={m.key} className="border-t border-white/[0.05]">
                <td className="py-1.5 text-zinc-300">{monthLongLabel(m.key)}</td>
                <td className="py-1.5 text-right text-zinc-100">{inr(m.spent)}</td>
                <td className="py-1.5 text-right text-zinc-400">{m.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div ref={wrap} className="relative w-full min-w-0">
          {width > 0 && <svg width={width} height={TOP + PLOT_H + AXIS_H} role="img" aria-label={title} className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={LEFT} x2={width - 8} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-axis)' : 'var(--color-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={LEFT - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--color-ink-muted)] text-[11px] tabular-nums">
                  {inrCompact(t)}
                </text>
              </g>
            ))}
            {months.map((m, i) => {
              const cx = LEFT + band * i + band / 2
              const h = Math.max(0, y(0) - y(m.spent))
              const hasData = !covered || covered.has(m.key)
              return (
                <g key={m.key}>
                  {m.spent > 0 && (
                    <path d={columnPath(cx - barW / 2, y(0), barW, h)} fill={hover === i ? 'var(--color-series-1-hover)' : 'var(--color-series-1)'} className="transition-[fill] duration-150" />
                  )}
                  {i === peak && m.spent > 0 && hover === null && (
                    <text x={cx} y={y(m.spent) - 7} textAnchor="middle" className="fill-zinc-300 text-[11px] font-medium">
                      {inrCompact(m.spent)}
                    </text>
                  )}
                  {!hasData && <rect x={cx - barW / 2} y={y(0) - 2} width={barW} height={2} rx={1} fill="var(--color-axis)" />}
                  {i % showEvery === 0 && (
                    <text x={cx} y={TOP + PLOT_H + 18} textAnchor="middle" className={`text-[11px] ${hasData ? 'fill-[var(--color-ink-muted)]' : 'fill-zinc-700'}`}>
                      {monthLabel(m.key)}
                    </text>
                  )}
                  <rect
                    x={LEFT + band * i}
                    y={TOP}
                    width={band}
                    height={PLOT_H}
                    fill="transparent"
                    tabIndex={0}
                    aria-label={hasData ? `${monthLongLabel(m.key)}: ${inr(m.spent)}` : `${monthLongLabel(m.key)}: no ${source}`}
                    onPointerEnter={() => setHover(i)}
                    onPointerLeave={() => setHover(null)}
                    onFocus={() => setHover(i)}
                    onBlur={() => setHover(null)}
                    className="cursor-default outline-none"
                  />
                </g>
              )
            })}
          </svg>}
          {hover !== null && width > 0 && (
            <div
              className="pointer-events-none absolute z-10 min-w-36 -translate-x-1/2 rounded-xl border border-white/10 bg-zinc-900/95 px-3 py-2 shadow-xl shadow-black/40 backdrop-blur"
              style={{
                left: Math.min(Math.max(LEFT + band * hover + band / 2, 80), width - 80),
                top: Math.max(0, y(months[hover].spent) - 70),
              }}
            >
              {covered && !covered.has(months[hover].key) ? (
                <>
                  <div className="text-[13px] font-semibold text-zinc-300">No {source}</div>
                  <div className="text-xs text-zinc-500">{monthLongLabel(months[hover].key)} isn't in any file yet</div>
                </>
              ) : (
                <>
                  <div className="text-[15px] font-semibold text-zinc-50">{inr(months[hover].spent)}</div>
                  <div className="text-xs text-zinc-400">
                    {monthLongLabel(months[hover].key)} · {months[hover].count} {noun}
                    {months[hover].count === 1 ? '' : 's'}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}

/** A column with a 4px rounded top and a square foot on the baseline. */
function columnPath(x: number, base: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h)
  const top = base - h
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`
}
