import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { inr } from '../../lib/money'

export interface Slice {
  id: string
  label: string
  amount: number
  colour: string
}

interface Props {
  /** In ring order, clockwise from the top. */
  slices: Slice[]
  total: number
  /** Under the total in the middle: "spent in 2025". */
  caption: string
  selected: string | null
  onSelect: (id: string | null) => void
}

type Arc = { id: string; a0: number; a1: number }

const TAU = Math.PI * 2
const GAP = 3 // px between slices, the same width at every radius
const CORNER = 5 // px, rounded slice corners
const MIN_SWEEP = 0.06 // radians, so a small slice stays visible and hoverable
const LABEL_H = 66
const SIDE_LABELS_FROM = 480 // px of width; narrower, a legend goes under the ring

/** A ring of rounded slices with labels on dotted leader lines (percentage, amount, name), or a legend
 *  underneath on narrow screens. Hover or tap a slice or its label and the middle reads it out; the rest dim.
 *  The ring sweeps in, and glides to the new shares when the year changes. */
export function SpendDonut({ slices, total, caption, selected, onSelect }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const width = useWidth(box)
  const [hover, setHover] = useState<string | null>(null)
  const active = hover ?? selected
  const reduced = useReducedMotion()

  const target = useMemo(() => layout(slices, total), [slices, total])
  const arcs = useTweenedArcs(target, !!reduced)

  const wide = width >= SIDE_LABELS_FROM
  const R = wide ? clamp(width / 2 - 150, 78, 104) : clamp(width / 2 - 20, 70, 112)
  const r = R * 0.63
  const perSide = Math.ceil(target.length / 2)
  const H = wide ? Math.max(2 * R + 56, perSide * LABEL_H + 12) : 2 * R + 20
  const cx = width / 2
  const cy = H / 2
  const labels = wide ? placeLabels(target, cx, cy, R, H) : []
  const byId = new Map(slices.map((s) => [s.id, s]))
  const pct = (s: Slice) => (total > 0 ? (s.amount / total) * 100 : 0)

  const focus = active ? byId.get(active) : undefined
  const pick = (id: string) => onSelect(selected === id ? null : id)

  return (
    <div ref={box} className="w-full">
      {width > 0 && (
        <div className="relative" style={{ height: H }}>
          <svg width={width} height={H} className="absolute inset-0 overflow-visible" role="img" aria-label={`${inr(total)} ${caption}`}>
            {labels.map((l) => {
              const s = byId.get(l.id)!
              return (
                <motion.path
                  key={`line-${l.id}`}
                  d={l.path}
                  initial={{ opacity: 0, d: l.path }}
                  animate={{ d: l.path, opacity: active && active !== l.id ? 0.25 : 0.9 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], opacity: { delay: arcs.length ? 0 : 0.4 } }}
                  fill="none"
                  stroke={s.colour}
                  strokeWidth={1.6}
                  strokeDasharray="0 4.5"
                  strokeLinecap="round"
                />
              )
            })}
            {arcs.map((a) => {
              const s = byId.get(a.id)
              if (!s || a.a1 - a.a0 < 0.001) return null
              const mid = (a.a0 + a.a1) / 2
              const lift = active === a.id ? 5 : 0
              return (
                <motion.g
                  key={a.id}
                  animate={{ x: Math.sin(mid) * lift, y: -Math.cos(mid) * lift, opacity: active && active !== a.id ? 0.3 : 1 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 28 }}
                  onMouseEnter={() => setHover(a.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => pick(a.id)}
                  className="cursor-pointer"
                >
                  <path d={sector(cx, cy, R, r, a.a0, a.a1)} fill={s.colour} />
                  <title>{`${s.label}: ${inr(s.amount)} (${Math.round(pct(s))}%)`}</title>
                </motion.g>
              )
            })}
          </svg>

          {/* the middle: the total, or whatever you're pointing at */}
          <div className="pointer-events-none absolute flex flex-col items-center justify-center text-center" style={{ left: cx - r, top: cy - r, width: 2 * r, height: 2 * r }}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={focus?.id ?? 'total'}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col items-center px-2"
              >
                <span className="font-semibold tracking-tight text-zinc-50 tabular-nums" style={{ fontSize: fit(inr(focus?.amount ?? total), 2 * r) }}>
                  {inr(focus?.amount ?? total)}
                </span>
                <span className="mt-0.5 max-w-full truncate text-xs text-zinc-400">{focus ? `${focus.label} · ${Math.round(pct(focus))}%` : caption}</span>
              </motion.div>
            </AnimatePresence>
          </div>

          {labels.map((l) => {
            const s = byId.get(l.id)!
            const right = l.side === 'right'
            return (
              <motion.button
                key={`label-${l.id}`}
                type="button"
                onMouseEnter={() => setHover(l.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(l.id)}
                onBlur={() => setHover(null)}
                onClick={() => pick(l.id)}
                aria-pressed={selected === l.id}
                initial={{ opacity: 0, top: l.y - LABEL_H / 2 }}
                animate={{ opacity: active && active !== l.id ? 0.35 : 1, top: l.y - LABEL_H / 2 }}
                transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1], opacity: { duration: 0.25 } }}
                className={`absolute flex flex-col justify-center rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${right ? 'items-start text-left' : 'items-end text-right'}`}
                style={{ height: LABEL_H, ...(right ? { left: l.textX } : { right: width - l.textX }), width: Math.max(72, right ? width - l.textX : l.textX) }}
              >
                <span className="text-[22px] leading-none font-semibold tracking-tight text-zinc-50 tabular-nums">{formatPct(pct(s))}</span>
                <span className="mt-1 text-sm leading-tight text-zinc-300 tabular-nums">{inr(s.amount)}</span>
                <span className="mt-0.5 flex max-w-full items-center gap-1.5 text-xs leading-tight text-zinc-500">
                  <span className="size-2 shrink-0 rounded-[3px]" style={{ background: s.colour }} />
                  <span className="truncate">{s.label}</span>
                </span>
              </motion.button>
            )
          })}
        </div>
      )}

      {!wide && width > 0 && (
        <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
          {slices.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => pick(s.id)}
                onMouseEnter={() => setHover(s.id)}
                onMouseLeave={() => setHover(null)}
                aria-pressed={selected === s.id}
                className={`flex w-full items-start gap-2.5 rounded-xl p-2 text-left transition ${active && active !== s.id ? 'opacity-40' : ''} ${selected === s.id ? 'bg-white/[0.05]' : ''}`}
              >
                <span className="mt-1.5 size-2.5 shrink-0 rounded-[3px]" style={{ background: s.colour }} />
                <span className="min-w-0">
                  <span className="block text-lg leading-none font-semibold text-zinc-50 tabular-nums">{formatPct(pct(s))}</span>
                  <span className="mt-1 block text-[13px] text-zinc-300 tabular-nums">{inr(s.amount)}</span>
                  <span className="block truncate text-xs text-zinc-500">{s.label}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---- geometry ----------------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const side = (a: Arc): 'left' | 'right' => (Math.sin((a.a0 + a.a1) / 2) >= -1e-9 ? 'right' : 'left')
/** Angle 0 is 12 o'clock, clockwise. */
const at = (cx: number, cy: number, rad: number, a: number): [number, number] => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)]

function formatPct(p: number): string {
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`
}

/** Font size that fits the amount inside the hole. */
function fit(text: string, hole: number): number {
  return clamp((hole * 0.8) / (text.length * 0.6), 13, 26)
}

function layout(slices: Slice[], total: number): Arc[] {
  if (total <= 0 || !slices.length) return []
  let sweeps = slices.map((s) => (s.amount / total) * TAU)
  const small = sweeps.map((a) => a < MIN_SWEEP)
  const need = sweeps.reduce((n, a, i) => n + (small[i] ? MIN_SWEEP - a : 0), 0)
  const big = sweeps.reduce((n, a, i) => n + (small[i] ? 0 : a), 0)
  if (need > 0 && big > need) sweeps = sweeps.map((a, i) => (small[i] ? MIN_SWEEP : a - (a / big) * need))
  // Turn the ring so its biggest slice sits at 6 o'clock: the smaller ones then spread over both sides of
  // the top, and so do their labels.
  const biggest = sweeps.indexOf(Math.max(...sweeps))
  let a0 = Math.PI - (sweeps.slice(0, biggest).reduce((s, a) => s + a, 0) + sweeps[biggest] / 2)
  return slices.map((s, i) => {
    const arc = { id: s.id, a0, a1: a0 + sweeps[i] }
    a0 = arc.a1
    return arc
  })
}

/** An annular slice with rounded corners and a parallel-sided gap to its neighbours. */
function sector(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const o0 = a0 + GAP / 2 / R
  const o1 = a1 - GAP / 2 / R
  if (o1 - o0 < 0.002) return ''
  let i0 = a0 + GAP / 2 / r
  let i1 = a1 - GAP / 2 / r
  if (i1 - i0 < 0) i0 = i1 = (a0 + a1) / 2 // too thin inside: a wedge
  const c = Math.max(0, Math.min(CORNER, (R - r) / 2 - 0.5, ((o1 - o0) * R) / 2 - 0.5, ((i1 - i0) * r) / 2))

  const PA = at(cx, cy, R, o0)
  const PB = at(cx, cy, R, o1)
  const PC = at(cx, cy, r, i1)
  const PD = at(cx, cy, r, i0)
  const toward = (p: [number, number], q: [number, number], d: number): [number, number] => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1
    return [p[0] + ((q[0] - p[0]) / len) * d, p[1] + ((q[1] - p[1]) / len) * d]
  }
  const A1 = at(cx, cy, R, o0 + c / R)
  const B0 = at(cx, cy, R, o1 - c / R)
  const B1 = toward(PB, PC, c)
  const C0 = toward(PC, PB, c)
  const C1 = at(cx, cy, r, i1 - c / r)
  const D0 = at(cx, cy, r, i0 + c / r)
  const D1 = toward(PD, PA, c)
  const A0 = toward(PA, PD, c)
  const bigOuter = o1 - o0 - (2 * c) / R > Math.PI ? 1 : 0
  const bigInner = i1 - i0 - (2 * c) / r > Math.PI ? 1 : 0
  const p = (q: [number, number]) => `${q[0].toFixed(2)} ${q[1].toFixed(2)}`
  return [
    `M${p(A1)}`,
    `A${R} ${R} 0 ${bigOuter} 1 ${p(B0)}`,
    `Q${p(PB)} ${p(B1)}`,
    `L${p(C0)}`,
    `Q${p(PC)} ${p(C1)}`,
    `A${r} ${r} 0 ${bigInner} 0 ${p(D0)}`,
    `Q${p(PD)} ${p(D1)}`,
    `L${p(A0)}`,
    `Q${p(PA)} ${p(A1)}`,
    'Z',
  ].join('')
}

/** Labels beside the ring, each on its slice's side at its slice's height, pushed apart so none overlap.
 *  When one big slice fills a side, the slices nearest 12 or 6 o'clock cross over, so the two columns stay
 *  even and the ring stays in the middle. */
function placeLabels(arcs: Arc[], cx: number, cy: number, R: number, H: number) {
  const items = arcs.map((a) => {
    const mid = (a.a0 + a.a1) / 2
    return { id: a.id, mid, side: side(a), crossed: false, want: cy - Math.cos(mid) * (R + 16), y: 0, path: '', textX: 0 }
  })
  const perSide = Math.ceil(items.length / 2)
  for (;;) {
    const left = items.filter((i) => i.side === 'left')
    const right = items.filter((i) => i.side === 'right')
    const [heavy, to] = left.length > perSide ? [left, 'right' as const] : right.length > perSide ? [right, 'left' as const] : [null, null]
    if (!heavy || !to) break
    const nearestPole = heavy.reduce((a, b) => (Math.abs(Math.cos(b.mid)) > Math.abs(Math.cos(a.mid)) ? b : a))
    nearestPole.side = to
    nearestPole.crossed = true
    // clear of the ring, above or below it
    nearestPole.want = Math.cos(nearestPole.mid) > 0 ? Math.min(nearestPole.want, cy - R - 12) : Math.max(nearestPole.want, cy + R + 12)
  }
  for (const s of ['left', 'right'] as const) {
    const col = items.filter((i) => i.side === s).sort((a, b) => a.want - b.want)
    let top = LABEL_H / 2 + 4
    for (const it of col) {
      it.y = Math.max(it.want, top)
      top = it.y + LABEL_H
    }
    let bottom = H - LABEL_H / 2 - 4
    for (const it of [...col].reverse()) {
      it.y = Math.min(it.y, bottom)
      bottom = it.y - LABEL_H
    }
  }
  const f = (x: number, y: number) => `${x.toFixed(1)} ${y.toFixed(1)}`
  let around = 0
  for (const it of items) {
    const dir = it.side === 'right' ? 1 : -1
    const [ax, ay] = at(cx, cy, R + 5, it.mid)
    const elbowX = cx + dir * (R + 20)
    const endX = cx + dir * (R + 34)
    if (it.crossed) {
      // over (or under) the ring to the other side, never through it
      const clear = Math.cos(it.mid) > 0 ? cy - R - 10 - around * 5 : cy + R + 10 + around * 5
      const x = elbowX + dir * around * 5
      around++
      it.path = `M${f(ax, ay)}L${f(ax, clear)}L${f(x, clear)}L${f(x, it.y)}L${f(endX, it.y)}`
    } else {
      // from the slice, out to the label's height, then level with the label
      const ex = dir > 0 ? Math.max(elbowX, ax + 6) : Math.min(elbowX, ax - 6)
      it.path = `M${f(ax, ay)}L${f(ex, it.y)}L${f(ex, it.y)}L${f(ex, it.y)}L${f(endX, it.y)}` // same shape as above, so lines can morph
    }
    it.textX = cx + dir * (R + 42)
  }
  return items
}

// ---- motion ------------------------------------------------------------------------------------

/** The arcs as drawn: swept in from 12 o'clock on first show, then eased from the old shares to the new. */
function useTweenedArcs(target: Arc[], reduced: boolean): Arc[] {
  const [drawn, setDrawn] = useState<Arc[]>([])
  const current = useRef<Arc[]>([])
  const key = target.map((a) => `${a.id}:${a.a0.toFixed(4)}:${a.a1.toFixed(4)}`).join('|')

  useEffect(() => {
    if (reduced) {
      current.current = target
      setDrawn(target)
      return
    }
    const from = new Map(current.current.map((a) => [a.id, a]))
    const to = new Map(target.map((a) => [a.id, a]))
    const ids = [...new Set([...target.map((a) => a.id), ...current.current.map((a) => a.id)])]
    const first = current.current.length === 0
    const pairs = ids.map((id) => {
      const s = from.get(id)
      const e = to.get(id)
      const mid = (a: Arc) => (a.a0 + a.a1) / 2
      return {
        id,
        s: s ?? (first ? { a0: 0, a1: 0 } : { a0: mid(e!), a1: mid(e!) }),
        e: e ?? { a0: mid(s!), a1: mid(s!) },
      }
    })
    const controls = animate(0, 1, {
      duration: first ? 0.9 : 0.65,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (t) => {
        const now = pairs.map((p) => ({ id: p.id, a0: p.s.a0 + (p.e.a0 - p.s.a0) * t, a1: p.s.a1 + (p.e.a1 - p.s.a1) * t }))
        current.current = now
        setDrawn(now)
      },
      onComplete: () => {
        current.current = target
        setDrawn(target)
      },
    })
    return () => controls.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reduced])

  return drawn
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
