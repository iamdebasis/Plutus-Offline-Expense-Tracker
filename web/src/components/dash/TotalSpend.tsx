import { ChartPie } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { topOf } from '../../lib/ledger'
import { inr } from '../../lib/money'
import type { PeriodKey } from '../../lib/periods'
import { OTHER_COLOUR, colourSlots, type TotalSpend as Totals } from '../../lib/totals'
import { CategoryBars } from './CategoryBars'
import { Panel, SectionHead } from './Section'
import { SpendDonut, type Slice } from './SpendDonut'

const OTHER = 'other'

interface Props {
  /** The period's totals (computed once on the dashboard, shared with Month by month). */
  totals: Totals
  /** All years, which decides each category's colour so it never changes between years. */
  allTime: Totals
  period: PeriodKey
}

/** Cards and UPI together, counted once: the ring on the left, where it went on the right, one selection
 *  shared by both. */
export function TotalSpend({ totals, allTime, period }: Props) {
  const slots = useMemo(() => colourSlots(allTime), [allTime])
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => setSelected(null), [period])
  // a selection whose category just left (investments switched off) lets go
  useEffect(() => {
    if (selected && selected !== OTHER && !totals.byCategory.some((c) => c.id === topOf(selected))) setSelected(null)
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

  // The ring knows top-level categories and "Other"; the bars know every row.
  const ringSelected = selected ? (slots.has(topOf(selected)) ? topOf(selected) : OTHER) : null
  const barsSelected = selected === OTHER ? null : selected
  const when = period === 'all' ? 'across all years' : `in ${period}`

  return (
    <section className="mt-6">
      <SectionHead icon={<ChartPie className="size-4" />} title="Total spend" note={`Cards and UPI together, counted once · ${period === 'all' ? 'all years' : period}`} />

      {totals.total <= 0.5 ? (
        <p className="rounded-3xl border border-dashed border-white/10 px-5 py-10 text-center text-sm text-zinc-500">No spending {when} yet.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Breakdown">
            <SpendDonut slices={slices} total={totals.total} caption={`spent ${when}`} selected={ringSelected} onSelect={setSelected} />
            <HowItAddsUp totals={totals} />
          </Panel>
          <Panel title="Where it went" note="Tap a row to focus on it">
            <CategoryBars rows={totals.byCategory} total={totals.total} selected={barsSelected} onSelect={setSelected} colourOf={colourOf} />
          </Panel>
        </div>
      )}
    </section>
  )
}

/** The sum in one line, and what's in it: UPI (a card used on UPI included), purchases with a card's number read
 *  from statements, card purchases estimated from bills that pay no statement you added (less what UPI already
 *  counted), and what's left out. */
function HowItAddsUp({ totals: t }: { totals: Totals }) {
  const anyCards = t.cards > 0.5 || t.cardBills > 0.5
  const notes = [
    t.upiOnCards > 0.5 && `UPI includes ${inr(t.upiOnCards)} paid with your credit cards on UPI.`,
    t.cards > 0.5 && `${inr(t.cards)} of purchases and charges with your cards (not on UPI), read from your card statements one by one, on the day you bought.`,
    t.cardBills > 0.5 &&
      `${inr(t.cardPurchases)} of card purchases estimated from ${inr(t.cardBills)} in card bills that pay no statement you added${overlapNote(t)}, each counted in the billing cycle it paid for.`,
    t.coveredBills > 0.5 && `${inr(t.coveredBills)} in bills paid statements you added, so their purchases are counted one by one instead.`,
    t.people > 0.5 && `Not counted: ${inr(t.people)} sent to people. Label a person and their payments move into spending.`,
    t.invested > 0.5 && `Not counted: ${inr(t.invested)} invested. Investments are left out; switch "Count investments" on at the top to include them.`,
  ].filter(Boolean)

  return (
    <div className="mt-5 border-t border-white/[0.06] pt-4">
      {anyCards ? (
        <dl className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-sm tabular-nums">
          <Term label="UPI" value={t.upi} />
          {t.cards > 0.5 && <Term op="+" label="cards, from statements" value={t.cards} />}
          {t.cardBills > 0.5 && <Term op="+" label="cards, estimated from bills" value={t.cardPurchases} />}
          <Term op="=" label="total" value={t.total} strong />
        </dl>
      ) : (
        <p className="text-sm text-zinc-400">UPI only: no card statements or card bills in this period. Add a card statement, or your CRED payment history, to include your cards.</p>
      )}
      {notes.map((n) => (
        <p key={n as string} className="mt-1.5 text-xs leading-relaxed text-zinc-500">
          {n}
        </p>
      ))}
    </div>
  )
}

function overlapNote(t: Totals): string {
  if (t.cardOverlap <= 0.5) return ''
  const counted = t.cardOverlap - t.cardOverlapLeftOut
  if (t.cardOverlapLeftOut <= 0.5) return `, less ${inr(t.cardOverlap)} paid with those cards on UPI (counted under UPI)`
  if (counted <= 0.5) return `, less ${inr(t.cardOverlap)} of investments paid with those cards on UPI, left out`
  return `, less ${inr(t.cardOverlap)} paid with those cards on UPI (${inr(counted)} counted as UPI, ${inr(t.cardOverlapLeftOut)} investments left out)`
}

function Term({ op, label, value, strong }: { op?: string; label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      {op && <span className="mr-1 text-zinc-600">{op}</span>}
      <dd className={strong ? 'font-semibold text-zinc-50' : 'text-zinc-200'}>{inr(value)}</dd>
      <dt className="text-xs text-zinc-500">{label}</dt>
    </div>
  )
}
