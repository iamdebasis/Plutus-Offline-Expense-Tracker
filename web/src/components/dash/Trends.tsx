import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { fitLabel } from '../../lib/format'
import { inr, inrCompact } from '../../lib/money'
import { monthLabel, monthLongLabel } from '../../lib/periods'
import { niceScale } from '../../lib/scale'
import { OTHER_COLOUR, type Trend } from '../../lib/totals'

const TOP = 16
const AXIS_H = 30
const LEFT = 52

interface Props {
  months: string[]
  series: Trend[]
  /** A line's colour, fixed by its caller from all years, so it's the same whichever year is picked. */
  colourOf: (id: string) => string
  /** The lines with a colour of their own, in chip order; the rest are under "More", grey. */
  main: string[]
  /** A name for a ticked line with nothing in this period (its chip stays, marked "none"). */
  labelOf?: (id: string) => string
  /** Where the ticks are remembered (browser storage: how the panel was left, nothing that changes a number). */
  storageKey: string
  /** "in 2026", "across all years". */
  when: string
  /** What a line is: ["category", "categories"]. */
  kind: [string, string]
  defaultTicked?: number
  /** Exactly these lines, whatever is ticked (one card picked above the chart). */
  force?: string[] | null
  ariaLabel: string
}

/** Lines month by month, ticked to compare. The scale fits whatever is ticked, so a small line on its own shows its
 *  own ups and downs. A dashed stretch is estimated; a gap is a month no file covers. Ticks are remembered and survive
 *  year changes; hover (or focus and use ← →) for each line's month; a table view carries the same numbers. */
export function Trends({ months, series, colourOf, main, labelOf, storageKey, when, kind, defaultTicked = 4, force, ariaLabel }: Props) {
  const [focus, setFocus] = useState<string | null>(null)
  const [ticked, setTicked] = useTicked(series, storageKey, defaultTicked)
  const [asTable, setAsTable] = useState(false)

  const byId = new Map(series.map((s) => [s.id, s]))
  const chosen = force ? new Set(force) : ticked
  // chips in colour order (stable when the year changes); ticked lines with nothing this period still show
  const mainChips = main.filter((id) => (byId.has(id) || chosen.has(id)) && (!force || force.includes(id)))
  const more = series.filter((s) => !main.includes(s.id) && (!force || force.includes(s.id)))
  const shown = series.filter((s) => chosen.has(s.id))
  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center gap-2">
        {mainChips.map((id) => (
          <Chip
            key={id}
            label={byId.get(id)?.label ?? labelOf?.(id) ?? id}
            colour={colourOf(id)}
            amount={byId.get(id)?.amount ?? 0}
            absent={!byId.has(id)}
            when={when}
            checked={chosen.has(id)}
            fixed={!!force}
            onToggle={() => toggle(id)}
            onOnly={() => setTicked(new Set([id]))}
            onFocus={(on) => setFocus(on ? id : null)}
          />
        ))}
        {more.length > 0 && <More items={more} ticked={chosen} onToggle={toggle} onOnly={(id) => setTicked(new Set([id]))} onFocus={setFocus} />}
        <span className="ml-auto flex items-center gap-1 text-xs">
          {!force && (
            <>
              <button type="button" onClick={() => setTicked(new Set(series.map((s) => s.id)))} className="rounded-full px-2.5 py-1 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                All
              </button>
              <span className="text-zinc-700">·</span>
              <button type="button" onClick={() => setTicked(new Set())} className="rounded-full px-2.5 py-1 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                None
              </button>
              <span className="mx-1 h-4 w-px bg-white/10" />
            </>
          )}
          <button type="button" onClick={() => setAsTable((v) => !v)} className="rounded-full px-2.5 py-1 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
            {asTable ? 'Show chart' : 'Show table'}
          </button>
        </span>
      </div>

      {asTable ? (
        <TrendTable months={months} series={shown} empty={`Tick a ${kind[0]} to list its months.`} />
      ) : (
        <TrendChart
          months={months}
          series={shown}
          colourOf={colourOf}
          focus={focus}
          ariaLabel={ariaLabel}
          empty={chosen.size ? `No spending on the ticked ${kind[1]} ${when}.` : `Tick a ${kind[0]} to see how it changes month by month.`}
        />
      )}
    </>
  )
}

// ---- chips ---------------------------------------------------------------------------------------

function Chip(props: {
  label: string
  colour: string
  amount: number
  absent: boolean
  when: string
  checked: boolean
  /** Shown by the choice above the chart, not by a tick: no box to untick, no "Only". */
  fixed: boolean
  onToggle: () => void
  onOnly: () => void
  /** Hovering a chip brings its line forward. */
  onFocus: (on: boolean) => void
}) {
  const { label, colour, amount, absent, when, checked, fixed, onToggle, onOnly, onFocus } = props
  return (
    <div
      onPointerEnter={() => onFocus(true)}
      onPointerLeave={() => onFocus(false)}
      className={`group relative inline-flex items-center rounded-full ring-1 transition ${
        checked ? 'bg-white/[0.06] ring-white/15' : 'ring-white/[0.08] hover:ring-white/20'
      } ${absent ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={fixed}
        onClick={onToggle}
        className="flex items-center gap-2 rounded-full py-1.5 pr-3 pl-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-white/30"
      >
        <Box colour={colour} checked={checked} />
        <span className={checked ? 'text-zinc-100' : 'text-zinc-400'}>{label}</span>
        <span className={`text-xs text-zinc-500 tabular-nums transition-opacity ${fixed ? '' : 'group-focus-within:opacity-0 group-hover:opacity-0'}`}>
          {absent ? `none ${when}` : inrCompact(amount)}
        </span>
      </button>
      {!fixed && (
        <button
          type="button"
          onClick={onOnly}
          aria-label={`Show only ${label}`}
          className="absolute right-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-100 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-white/20"
        >
          Only
        </button>
      )}
    </div>
  )
}

function Box({ colour, checked }: { colour: string; checked: boolean }) {
  return (
    <span
      className="flex size-4 shrink-0 items-center justify-center rounded-[5px] transition-colors"
      style={checked ? { background: colour } : { boxShadow: `inset 0 0 0 1.5px ${colour}` }}
    >
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={{ type: 'spring', stiffness: 600, damping: 30 }}>
            <Check className="size-3 text-white" strokeWidth={3.2} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  )
}

/** Lines without a colour of their own: each with its own tick, drawn grey and named at its line's end. */
function More({ items, ticked, onToggle, onOnly, onFocus }: { items: Trend[]; ticked: Set<string>; onToggle: (id: string) => void; onOnly: (id: string) => void; onFocus: (id: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const count = items.filter((t) => ticked.has(t.id)).length
  useEffect(() => {
    if (!open) return
    const close = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 rounded-full py-1.5 pr-2.5 pl-3 text-sm ring-1 transition ${count ? 'bg-white/[0.06] text-zinc-100 ring-white/15' : 'text-zinc-400 ring-white/[0.08] hover:ring-white/20'}`}
      >
        More
        {count > 0 && <span className="rounded-full bg-white/15 px-1.5 text-[11px] tabular-nums">{count}</span>}
        <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute top-full left-0 z-30 mt-2 max-h-80 w-64 origin-top-left overflow-y-auto rounded-2xl border border-white/10 bg-panel/95 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl"
          >
            {items.map((t) => (
              <li key={t.id} onPointerEnter={() => onFocus(t.id)} onPointerLeave={() => onFocus(null)} className="group flex items-center rounded-xl hover:bg-white/[0.05]">
                <button type="button" role="checkbox" aria-checked={ticked.has(t.id)} onClick={() => onToggle(t.id)} className="flex flex-1 items-center gap-2.5 px-2.5 py-2 text-left text-sm">
                  <Box colour={OTHER_COLOUR} checked={ticked.has(t.id)} />
                  <span className={`flex-1 truncate ${ticked.has(t.id) ? 'text-zinc-100' : 'text-zinc-300'}`}>{t.label}</span>
                  <span className="text-xs text-zinc-500 tabular-nums group-hover:hidden">{inrCompact(t.amount)}</span>
                </button>
                <button type="button" onClick={() => onOnly(t.id)} className="mr-2 hidden rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-zinc-100 group-hover:block hover:bg-white/20">
                  Only
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  )
}

// ---- the chart -------------------------------------------------------------------------------------

function TrendChart({ months, series, colourOf, focus, empty, ariaLabel }: { months: string[]; series: Trend[]; colourOf: (id: string) => string; focus: string | null; empty: string; ariaLabel: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const width = useWidth(wrap)
  const reduced = !!useReducedMotion()
  const [hover, setHover] = useState<number | null>(null)

  const peak = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)))
  const { ticks, max: targetMax } = useMemo(() => niceScale(peak), [peak])
  const max = useTweened(targetMax, reduced) // the scale glides when lines are ticked or unticked

  const wide = width >= 640
  const plotH = wide ? 280 : 210
  const right = wide ? 136 : 14
  const plotW = Math.max(1, width - LEFT - right)
  const n = months.length
  const band = plotW / Math.max(n, 1)
  const x = (i: number) => LEFT + band * i + band / 2
  const y = (v: number) => TOP + plotH - (max > 0 ? (v / max) * plotH : 0)
  const dots = n <= 24
  const labelEvery = band < 34 ? Math.ceil(34 / band) : 1
  const onlyYears = n > 24 // too many months to name: mark the years

  const nothing = !series.length || peak <= 0
  const gaps = months.map((_, i) => series.length > 0 && series.every((s) => s.values[i] === null)) // nothing ticked has data
  const multiYear = n > 0 && months[0].slice(0, 4) !== months[n - 1].slice(0, 4)
  const isEstimate = (s: Trend, i: number) => !!s.dashed || !!s.estimated?.[i]

  // names at the ends of the lines, pushed apart so they never overlap
  const ends = useMemo(() => {
    if (!wide) return []
    const items = series
      .map((s) => {
        const last = lastIndex(s.values)
        return last < 0 ? null : { id: s.id, label: s.label, want: y(s.values[last]!), y: 0 }
      })
      .filter((e): e is NonNullable<typeof e> => !!e)
      .sort((a, b) => a.want - b.want)
    let top = TOP + 6
    for (const e of items) {
      e.y = Math.max(e.want, top)
      top = e.y + 17
    }
    let bottom = TOP + plotH
    for (const e of [...items].reverse()) {
      e.y = Math.min(e.y, bottom)
      bottom = e.y - 17
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, max, wide, plotH])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1))
    else if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1))
    else if (e.key === 'Escape') setHover(null)
    else return
    e.preventDefault()
  }

  return (
    <div ref={wrap} className="relative w-full min-w-0">
      {width > 0 && (
        <svg width={width} height={TOP + plotH + AXIS_H} className="block overflow-visible" role="img" aria-label={ariaLabel}>
          {/* months with no data for anything ticked: a quiet band, so a gap reads as "no file", not ₹0 */}
          {gaps.map((g, i) => g && <rect key={`gap-${i}`} x={LEFT + band * i} y={TOP} width={band} height={plotH} fill="rgb(255 255 255 / 0.018)" />)}

          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={LEFT + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-axis)' : 'var(--color-grid)'} strokeWidth={1} shapeRendering="crispEdges" />
              <text x={LEFT - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--color-ink-muted)] text-[11px] tabular-nums">
                {inrCompact(t)}
              </text>
            </g>
          ))}

          {months.map((k, i) => {
            const newYear = multiYear && (i === 0 || k.endsWith('-01'))
            const named = !onlyYears && i % labelEvery === 0
            if (!newYear && !named) return null
            return (
              <g key={k}>
                {newYear && i > 0 && <line x1={LEFT + band * i} x2={LEFT + band * i} y1={TOP} y2={TOP + plotH} stroke="rgb(255 255 255 / 0.12)" strokeDasharray="2 4" />}
                <text
                  x={onlyYears ? LEFT + band * i + 3 : x(i)}
                  y={TOP + plotH + 19}
                  textAnchor={onlyYears ? 'start' : 'middle'}
                  className={`text-[11px] ${newYear ? 'fill-zinc-300 font-medium' : gaps[i] ? 'fill-zinc-700' : 'fill-[var(--color-ink-muted)]'}`}
                >
                  {newYear ? (onlyYears ? k.slice(0, 4) : `${monthLabel(k)} ’${k.slice(2, 4)}`) : monthLabel(k)}
                </text>
              </g>
            )
          })}

          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={TOP} y2={TOP + plotH} stroke="rgb(255 255 255 / 0.25)" strokeWidth={1} shapeRendering="crispEdges" />}

          <AnimatePresence initial={false}>
            {series.map((s) => {
              const colour = colourOf(s.id)
              const { solid, dashed } = linePaths(s.values, (i) => isEstimate(s, i), x, y)
              const faded = (hover !== null && s.values[hover] === null) || (focus !== null && focus !== s.id && series.some((t) => t.id === focus))
              return (
                <motion.g key={s.id} initial={{ opacity: 0 }} animate={{ opacity: faded ? 0.2 : 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
                  {solid && (
                    <motion.path
                      d={solid}
                      fill="none"
                      stroke={colour}
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      // a solid line draws itself in; an estimate's dashes fade in
                      initial={reduced ? false : { pathLength: 0 }}
                      animate={reduced ? undefined : { pathLength: 1 }}
                      transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
                    />
                  )}
                  {dashed && <path d={dashed} fill="none" stroke={colour} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="7 5" />}
                  {dots &&
                    s.values.map((v, i) =>
                      v === null ? null : (
                        // an estimated month is a ring, a month read one by one a dot
                        <circle
                          key={i}
                          cx={x(i)}
                          cy={y(v)}
                          r={hover === i ? 5 : 3.5}
                          fill={isEstimate(s, i) ? 'var(--color-panel)' : colour}
                          stroke={isEstimate(s, i) ? colour : 'var(--color-panel)'}
                          strokeWidth={2}
                          className="transition-[r] duration-150"
                        />
                      ),
                    )}
                  {!dots && hover !== null && s.values[hover] !== null && <circle cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={colour} stroke="var(--color-panel)" strokeWidth={2} />}
                </motion.g>
              )
            })}
          </AnimatePresence>

          {ends.map((e) => (
            <g key={`end-${e.id}`} className="pointer-events-none">
              <circle cx={LEFT + plotW + 12} cy={e.y} r={3} fill={colourOf(e.id)} />
              <text x={LEFT + plotW + 20} y={e.y} dy="0.32em" className="fill-zinc-300 text-[12px]">
                {fitLabel(e.label, right - 22, labelWidth)}
              </text>
            </g>
          ))}

          {/* one target across the plot: hover, or focus and use ← → */}
          <rect
            x={LEFT}
            y={TOP}
            width={plotW}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${ariaLabel}; use the arrow keys to move between months`}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              setHover(Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / band))))
            }}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onKeyDown={onKey}
            className="cursor-crosshair outline-none"
          />
        </svg>
      )}

      {nothing && width > 0 && (
        <p className="pointer-events-none absolute inset-x-0 flex items-center justify-center text-sm text-zinc-500" style={{ top: TOP, height: plotH, left: LEFT, right }}>
          {empty}
        </p>
      )}

      <AnimatePresence>
        {hover !== null && series.length > 0 && width > 0 && (
          <Tooltip key="tip" month={months[hover]} index={hover} series={series} colourOf={colourOf} isEstimate={isEstimate} left={x(hover)} width={width} top={TOP + 6} />
        )}
      </AnimatePresence>
    </div>
  )
}

function Tooltip(props: {
  month: string
  index: number
  series: Trend[]
  colourOf: (id: string) => string
  isEstimate: (s: Trend, i: number) => boolean
  left: number
  width: number
  top: number
}) {
  const { month, index, series, colourOf, isEstimate, left, width, top } = props
  const W = 272
  const flip = left + 16 + W > width
  const rows = series.map((s) => ({ s, v: s.values[index], prev: index > 0 ? s.values[index - 1] : null })).sort((a, b) => (b.v ?? -1) - (a.v ?? -1))
  const total = rows.reduce((t, r) => t + (r.v ?? 0), 0)
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, left: flip ? left - 16 - W : left + 16 }}
      exit={{ opacity: 0 }}
      transition={{ opacity: { duration: 0.12 }, left: { type: 'spring', stiffness: 700, damping: 45 } }}
      className="pointer-events-none absolute z-10 rounded-xl border border-white/10 bg-zinc-900/95 px-3 py-2.5 shadow-xl shadow-black/40 backdrop-blur"
      style={{ top, width: W }}
    >
      <p className="mb-1.5 text-xs font-medium text-zinc-400">{monthLongLabel(month)}</p>
      <ul className="space-y-1">
        {rows.map(({ s, v, prev }) => (
          <li key={s.id} className="text-[13px]">
            <div className="flex items-center gap-2">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ background: colourOf(s.id) }} />
              <span className="min-w-0 flex-1 truncate text-zinc-300">{s.label}</span>
              {v === null ? (
                <span className="text-xs text-zinc-600">no data</span>
              ) : (
                <>
                  <span className="text-zinc-50 tabular-nums">
                    {isEstimate(s, index) && <span className="text-zinc-500">≈ </span>}
                    {inr(v)}
                  </span>
                  <span className="w-12 text-right text-[11px] text-zinc-500 tabular-nums">{change(v, prev)}</span>
                </>
              )}
            </div>
            {s.notes?.[index] && <p className="pl-4 text-[11px] text-zinc-500">{s.notes[index]}</p>}
          </li>
        ))}
      </ul>
      {rows.length > 1 && (
        <p className="mt-2 flex justify-between border-t border-white/[0.07] pt-1.5 text-[13px]">
          <span className="text-zinc-400">Together</span>
          <span className="pr-14 text-zinc-50 tabular-nums">{inr(total)}</span>
        </p>
      )}
      {rows.some(({ s }) => isEstimate(s, index)) && <p className="mt-1.5 text-[11px] text-zinc-500">≈ estimated from bills</p>}
    </motion.div>
  )
}

/** Versus the month before: "▲ 18%", "▼ 6%", "new", or nothing. */
function change(v: number, prev: number | null): string {
  if (prev === null) return ''
  if (prev <= 0) return v > 0 ? 'new' : ''
  const pct = ((v - prev) / prev) * 100
  if (Math.abs(pct) < 0.5) return '='
  return `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct) >= 999 ? '999+' : Math.round(Math.abs(pct))}%`
}

function TrendTable({ months, series, empty }: { months: string[]; series: Trend[]; empty: string }) {
  if (!series.length) return <p className="py-10 text-center text-sm text-zinc-500">{empty}</p>
  const estimate = (s: Trend, i: number) => !!s.dashed || !!s.estimated?.[i]
  const together = series.length > 1
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-zinc-500">
          <tr>
            <th className="py-1.5 pr-4 font-normal">Month</th>
            {series.map((s) => (
              <th key={s.id} className="py-1.5 pl-4 text-right font-normal whitespace-nowrap">
                {s.label}
              </th>
            ))}
            {together && <th className="py-1.5 pl-4 text-right font-normal">Together</th>}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {months.map((k, i) => {
            const any = series.some((s) => s.values[i] !== null)
            return (
              <tr key={k} className="border-t border-white/[0.05]">
                <td className="py-1.5 pr-4 whitespace-nowrap text-zinc-300">{monthLongLabel(k)}</td>
                {series.map((s) => (
                  <td key={s.id} className={`py-1.5 pl-4 text-right whitespace-nowrap ${s.values[i] === null ? 'text-zinc-600' : estimate(s, i) ? 'text-zinc-400' : 'text-zinc-100'}`}>
                    {s.values[i] === null ? '—' : `${estimate(s, i) ? '≈ ' : ''}${inr(s.values[i]!)}`}
                  </td>
                ))}
                {together && (
                  <td className="py-1.5 pl-4 text-right whitespace-nowrap text-zinc-300">
                    {any ? inr(series.reduce((t, s) => t + (s.values[i] ?? 0), 0)) : '—'}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {series.some((s) => s.dashed || s.estimated?.some(Boolean)) && <p className="mt-3 text-xs text-zinc-500">≈ estimated from bills that pay no statement you added</p>}
    </div>
  )
}

// ---- helpers ---------------------------------------------------------------------------------------

function lastIndex(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] !== null) return i
  return -1
}

/** A smooth line through the points that never overshoots them (monotone cubic, Fritsch–Carlson): it can't dip
 *  below ₹0 or above a real peak. A missing month breaks the line. Split in two: the stretches between months read
 *  one by one (solid) and those that touch an estimated month (dashed). */
function linePaths(values: (number | null)[], estimated: (i: number) => boolean, x: (i: number) => number, y: (v: number) => number) {
  const out = { solid: '', dashed: '' }
  let run: number[] = []
  const flush = () => {
    if (run.length === 1) {
      const i = run[0]
      out[estimated(i) ? 'dashed' : 'solid'] += `M${x(i).toFixed(1)},${y(values[i]!).toFixed(1)}h0.01`
    } else if (run.length > 1) {
      const segs = monotone(run.map((i) => [x(i), y(values[i]!)] as [number, number]))
      let style: 'solid' | 'dashed' | null = null
      run.slice(0, -1).forEach((i, k) => {
        const next = estimated(i) || estimated(run[k + 1]) ? 'dashed' : 'solid'
        if (next !== style) out[next] += segs.starts[k]
        out[next] += segs.curves[k]
        style = next
      })
    }
    run = []
  }
  values.forEach((v, i) => (v === null ? flush() : run.push(i)))
  flush()
  return out
}

/** Each stretch of a monotone cubic through the points: where it starts ("M…") and its curve ("C…"). */
function monotone(p: [number, number][]): { starts: string[]; curves: string[] } {
  const n = p.length
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) slope.push((p[i + 1][1] - p[i][1]) / (p[i + 1][0] - p[i][0]))
  const t: number[] = new Array(n)
  t[0] = slope[0]
  t[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) t[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      t[i] = t[i + 1] = 0
      continue
    }
    const a = t[i] / slope[i]
    const b = t[i + 1] / slope[i]
    const s = a * a + b * b
    if (s > 9) {
      const k = 3 / Math.sqrt(s)
      t[i] = k * a * slope[i]
      t[i + 1] = k * b * slope[i]
    }
  }
  const f = (v: number) => v.toFixed(1)
  const starts: string[] = []
  const curves: string[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = (p[i + 1][0] - p[i][0]) / 3
    starts.push(`M${f(p[i][0])},${f(p[i][1])}`)
    curves.push(`C${f(p[i][0] + dx)},${f(p[i][1] + t[i] * dx)} ${f(p[i + 1][0] - dx)},${f(p[i + 1][1] - t[i + 1] * dx)} ${f(p[i + 1][0])},${f(p[i + 1][1])}`)
  }
  return { starts, curves }
}

/** Which lines are ticked: remembered across reloads and year changes; the period's biggest few at first. */
function useTicked(series: Trend[], key: string, first: number): [Set<string>, (fn: Set<string> | ((s: Set<string>) => Set<string>)) => void] {
  const [ticked, set] = useState<Set<string> | null>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved ? new Set(JSON.parse(saved) as string[]) : null
    } catch {
      return null
    }
  })
  const current = ticked ?? new Set([...series].sort((a, b) => b.amount - a.amount).slice(0, first).map((t) => t.id))
  const update = (fn: Set<string> | ((s: Set<string>) => Set<string>)) => {
    const next = typeof fn === 'function' ? fn(current) : fn
    set(next)
    try {
      localStorage.setItem(key, JSON.stringify([...next]))
    } catch {
      /* private window: works, just isn't remembered */
    }
  }
  return [current, update]
}

function useTweened(target: number, reduced: boolean): number {
  const [value, setValue] = useState(target)
  const from = useRef(target)
  useEffect(() => {
    if (reduced) {
      from.current = target
      setValue(target)
      return
    }
    const controls = animate(from.current, target, {
      duration: 0.55,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => {
        from.current = v
        setValue(v)
      },
    })
    return () => controls.stop()
  }, [target, reduced])
  return value
}

let ruler: CanvasRenderingContext2D | null = null

/** How wide a line's name is drawn at its end (12px, in the page's font). */
function labelWidth(text: string): number {
  ruler ??= document.createElement('canvas').getContext('2d')
  if (!ruler) return text.length * 7
  ruler.font = `12px ${getComputedStyle(document.body).fontFamily}`
  return ruler.measureText(text).width
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(el.clientWidth)
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return w
}
