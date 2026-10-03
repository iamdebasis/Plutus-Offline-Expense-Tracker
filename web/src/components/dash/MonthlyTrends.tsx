import { ChartSpline } from 'lucide-react'
import { useMemo } from 'react'
import type { LedgerData, PeriodView } from '../../lib/ledger'
import type { PeriodKey } from '../../lib/periods'
import { CARD_PURCHASES, OTHER_COLOUR, colourSlots, monthlyTrends, type TotalSpend } from '../../lib/totals'
import { Panel, SectionHead } from './Section'
import { Trends } from './Trends'

interface Props {
  data: LedgerData
  view: PeriodView
  totals: TotalSpend
  /** All years: fixes each category's colour, the same as in Total spend. */
  allTime: TotalSpend
  period: PeriodKey
  /** Categories the dashboard leaves out (investments, when switched off): no chip, but a tick is kept for later. */
  leftOut: string[]
}

/** How each category moved month by month (components/dash/Trends.tsx draws it). Card purchases estimated from
 *  bills are dashed. */
export function MonthlyTrends({ data, view, totals, allTime, period, leftOut }: Props) {
  const { months, trends } = useMemo(() => monthlyTrends(data, view, totals), [data, view, totals])
  // Seven colours: the ring's six and violet. The palette's red sits too close to its orange for lines, which
  // can cross anywhere; categories past seven are grey, and every line is named at its end and in the tooltip.
  const slots = useMemo(() => colourSlots(allTime, 7), [allTime])
  const labels = useMemo(() => new Map(allTime.byCategory.map((c) => [c.id, c.label])), [allTime])
  const series = useMemo(() => trends.map((t) => ({ ...t, label: labels.get(t.id) ?? t.label, dashed: t.id === CARD_PURCHASES })), [trends, labels])
  const when = period === 'all' ? 'across all years' : `in ${period}`
  if (!trends.length) return null

  return (
    <section className="mt-14">
      <SectionHead icon={<ChartSpline className="size-4" />} title="Month by month" note={`How each category moved ${when}`} />
      <Panel title="Spending by category" note="Tick categories to compare them. The scale fits what's ticked, so one category on its own shows its real ups and downs.">
        <Trends
          months={months}
          series={series}
          colourOf={(id) => slots.get(id) ?? OTHER_COLOUR}
          main={[...slots.keys()].filter((id) => !leftOut.includes(id))}
          labelOf={(id) => labels.get(id) ?? id}
          storageKey="plutus.trends.ticked"
          when={when}
          kind={['category', 'categories']}
          ariaLabel="Monthly spending by category"
        />
      </Panel>
    </section>
  )
}
