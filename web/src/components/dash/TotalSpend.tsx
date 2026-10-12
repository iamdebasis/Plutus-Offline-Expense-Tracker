import { ChartPie } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { topOf, type LedgerData, type PeriodView } from '../../lib/ledger'
import { inr } from '../../lib/money'
import type { PeriodKey } from '../../lib/periods'
import { OTHER_COLOUR, colourSlots, type TotalSpend as Totals } from '../../lib/totals'
import { CategoryBars } from './CategoryBars'
import { Panel, SectionHead } from './Section'
import { FocusDetail, Highlights, OTHER, type FocusProps } from './SpendFocus'
import { SpendDonut, type Slice } from './SpendDonut'

interface Props {
  data: LedgerData
  /** The period's view, the one `totals` was worked out from. */
  view: PeriodView
  /** The period's totals (computed once on the dashboard, shared with Month by month). */
  totals: Totals
  /** All years, which decides each category's colour so it never changes between years. */
  allTime: Totals
  period: PeriodKey
  /** Open these payments in Your transactions. */
  onShow: (ids: string[], label: string) => void
  onChanged: () => void
  notify: (text: string) => void
}

/** Cards and UPI together, counted once: the ring on the left, where it went on the right, one selection shared by
 *  both. Under the ring, the sum, then what you tapped in detail (components/dash/SpendFocus.tsx), or the period's
 *  highlights. Side by side, the detail sits under the ring; stacked (below 1280px), it opens under the row you
 *  tapped, so it shows where you tapped. */
export function TotalSpend({ data, view, totals, allTime, period, onShow, onChanged, notify }: Props) {
  const slots = useMemo(() => colourSlots(allTime), [allTime])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => setSelected(null), [period])
  // a selection whose category just left (investments switched off, its last payee answered) lets go
  useEffect(() => {
    if (selected && selected !== OTHER && !totals.byCategory.some((c) => c.id === topOf(selected) && (c.id === selected || c.children.some((k) => k.id === selected)))) setSelected(null)
  }, [totals, selected])

  const colourOf = (id: string) => slots.get(topOf(id)) ?? OTHER_COLOUR
  const slices = useMemo<Slice[]>(() => {
    const named = [...slots.keys()]
      .map((id) => totals.byCategory.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && c.amount > 0.5)
      .map((c) => ({ id: c.id, label: c.label, amount: c.amount, colour: slots.get(c.id)! }))
    const rest = totals.byCategory.filter((c) => !slots.has(c.id)).reduce((s, c) => s + c.amount, 0)
    return rest > 0.5 ? [...named, { id: OTHER, label: 'Other', amount: rest, colour: OTHER_COLOUR }] : named
  }, [totals, slots])
  const others = useMemo(() => totals.byCategory.filter((c) => !slots.has(c.id)), [totals, slots])

  // The ring knows top-level categories and "Other"; the bars know every row.
  const ringSelected = selected ? (slots.has(topOf(selected)) ? topOf(selected) : OTHER) : null
  const barsSelected = selected === OTHER ? null : selected
  const when = period === 'all' ? 'across all years' : `in ${period}`

  // From a highlight: stacked, the row it opens is further down, so it's brought into view
  const select = (id: string | null) => {
    setSelected(id)
    if (id && !matchMedia('(min-width: 80rem)').matches) {
      requestAnimationFrame(() => document.querySelector(`[data-row="${CSS.escape(topOf(id))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    }
  }
  const focus = (id: string): FocusProps => ({ data, view, totals, period, selected: id, others, colourOf, onSelect: setSelected, onShow, onChanged, notify })
  const highlights = <Highlights data={data} view={view} totals={totals} period={period} onSelect={select} onShow={onShow} />

  return (
    <section className="mt-6">
      <SectionHead icon={<ChartPie className="size-4" />} title="Total spend" note={`Cards and UPI together, counted once · ${period === 'all' ? 'all years' : period}`} />

      {totals.total <= 0.5 ? (
        <p className="rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-muted">No spending {when} yet.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Breakdown">
            <SpendDonut slices={slices} total={totals.total} caption={`spent ${when}`} selected={ringSelected} onSelect={setSelected} />
            <SumLine totals={totals} />
            <div className="mt-5">
              {!selected ? (
                highlights
              ) : selected === OTHER ? (
                <FocusDetail {...focus(OTHER)} />
              ) : (
                <>
                  <div className="hidden xl:block">
                    <FocusDetail {...focus(selected)} />
                  </div>
                  <div className="xl:hidden">{highlights}</div>
                </>
              )}
            </div>
          </Panel>
          <Panel title="Where it went" note="Tap a row to focus on it">
            <CategoryBars
              rows={totals.byCategory}
              total={totals.total}
              selected={barsSelected}
              onSelect={setSelected}
              colourOf={colourOf}
              detail={barsSelected && (
                <div className="mx-2 mt-2 mb-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3.5 xl:hidden">
                  <FocusDetail {...focus(barsSelected)} />
                </div>
              )}
            />
          </Panel>
        </div>
      )}
    </section>
  )
}

/** The sum in one line: UPI (a card used on UPI included), purchases with a card's number read from statements, and
 *  card purchases estimated from bills that pay no statement you added. */
function SumLine({ totals: t }: { totals: Totals }) {
  return (
    <dl className="mt-5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-white/[0.06] pt-4 text-sm tabular-nums">
      <Term label="UPI" value={t.upi} />
      {t.cards > 0.5 && <Term op="+" label="cards, from statements" value={t.cards} />}
      {t.cardBills > 0.5 && <Term op="+" label="cards, estimated from bills" value={t.cardPurchases} />}
      <Term op="=" label="total" value={t.total} strong />
    </dl>
  )
}

function Term({ op, label, value, strong }: { op?: string; label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      {op && <span className="mr-1 text-muted">{op}</span>}
      <dd className={strong ? 'font-semibold text-zinc-50' : 'text-zinc-200'}>{inr(value)}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  )
}
