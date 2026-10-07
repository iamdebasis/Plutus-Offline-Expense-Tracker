import { X } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { billsFrom, cardColours, cardFigures, cardName, cardTrends, cardsOnly } from '../../lib/cards'
import { plural } from '../../lib/format'
import { NO_NAME, bucketOf, topOf, viewFor, type LedgerData, type PeriodView } from '../../lib/ledger'
import { inr, inrExact } from '../../lib/money'
import { dayLabel, type PeriodKey } from '../../lib/periods'
import { OTHER_COLOUR } from '../../lib/totals'
import { CategoryBars } from './CategoryBars'
import { Panel } from './Section'
import { Trends } from './Trends'

/** What you spent with your cards, the way the UPI section shows UPI: purchases with a card's number, read one by
 *  one from your statements, plus what bills that pay no statement you added say you spent (estimated, in the
 *  cycle each bill paid for). What you paid with a card on UPI is in UPI spends, and only noted here. One card at
 *  a time or all of them. */
export function CardSpending(props: {
  data: LedgerData
  everything: LedgerData
  all: PeriodView
  period: PeriodKey
  /** The card picked by its face above, or all of them. */
  card: string | null
  onCard: (id: string | null) => void
}) {
  const { data, everything, all, period, card, onCard } = props
  const picked = card ? data.cards.find((c) => c.id === card) : undefined
  const [category, setCategory] = useState<string | null>(null)
  useEffect(() => setCategory(null), [period, card])

  const cardData = useMemo(() => cardsOnly(data, card), [data, card])
  const view = useMemo(() => viewFor(cardData, period, null), [cardData, period])
  const focused = useMemo(() => (category ? viewFor(cardData, period, category) : view), [cardData, period, category, view])
  const f = cardFigures(view, all, card)
  const categoryLabel = category ? data.categories.get(category)?.label : null
  const trend = useMemo(() => cardTrends(data, period, category), [data, period, category])
  // a card's colour comes from all your years, so it's the same whichever year (or investments setting) you pick
  const colours = useMemo(() => cardColours(everything), [everything])
  const when = period === 'all' ? 'across all years' : `in ${period}`
  const covered = new Set([...view.coverage.statements, ...view.coverage.estimated]) // months a statement or a bill speaks for
  const spent = f.itemized + f.estimated
  const biggest = focused.txns
    .filter((t) => bucketOf(t) === 'spent' && t.direction === 'debit')
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
  // places you bought at: the bank's fees and taxes are in their own tile
  const merchants = view.topPayees.filter((p) => topOf(p.category) !== 'fees')
  const anything = spent > 0.5 || f.viaUpi > 0.5 || f.billsCount > 0

  return (
    <div className="mt-8">
      {picked && (
        // the card picked by its face above; this is the way back to all of them
        <div className="mb-4 flex items-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/[0.06] py-1 pr-1 pl-3.5 text-sm ring-1 ring-white/15">
            <span className="text-zinc-400">Showing</span>
            <span className="text-zinc-100">{cardName(picked)}</span>
            <button
              type="button"
              onClick={() => onCard(null)}
              className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/[0.08] px-2.5 py-1 text-xs text-zinc-200 transition hover:bg-white/15 hover:text-white"
            >
              All cards <X className="size-3.5" />
            </button>
          </span>
        </div>
      )}

      {!anything ? (
        <p className="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center text-sm text-zinc-500">
          Nothing on {card ? 'this card' : 'your cards'} {period === 'all' ? 'yet' : `in ${period}`}. Add its statements, or your CRED payment history.
        </p>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="rounded-3xl border border-white/[0.07] bg-gradient-to-br from-white/[0.06] to-white/[0.015] p-6 lg:col-span-5">
              <p className="text-sm text-zinc-400">Spent with {card ? 'this card' : 'your cards'}</p>
              <motion.p key={spent} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 text-[52px] leading-none font-semibold tracking-tight">
                {inr(spent)}
              </motion.p>
              <p className="mt-3 text-sm text-zinc-500">
                {[
                  f.itemized > 0.5 &&
                    `${inr(f.itemized)} read one by one from your statements (${plural(f.itemizedCount, f.fees > 0.5 ? 'purchase or charge' : 'purchase', f.fees > 0.5 ? 'purchases and charges' : undefined)})`,
                  f.estimated > 0.5 && `${inr(f.estimated)} estimated from bills that pay no statement you added`,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'Nothing with the card number in this period.'}
              </p>
              {f.viaUpi > 0.5 && (
                <p className="mt-2 text-sm text-zinc-500">
                  + {inr(f.viaUpi)} paid with {card ? 'it' : 'them'} on UPI ({plural(f.viaUpiCount, 'payment')}), counted in UPI spends.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4 lg:col-span-7">
              <Tile label="Bills paid" value={inr(f.billsPaid)} caption={f.billsCount ? `${plural(f.billsCount, 'bill')} paid, from ${billsFrom(f)}` : 'No bills paid in this period'} />
              <Tile
                label="Per month"
                value={covered.size ? inr(spent / covered.size) : '—'}
                caption={`Average over the ${plural(covered.size, 'month')} your statements and bills cover`}
              />
              <Tile label="Fees & interest" value={inr(f.fees)} caption="Charged by the bank, as your statements show it" muted={f.fees <= 0.5} />
              <Tile
                label="Refunds & cashback"
                value={inr(f.refunded + f.cashback)}
                caption={`${inr(f.refunded)} refunded, taken off purchases · ${inr(f.cashback)} cashback`}
                muted={f.refunded + f.cashback <= 0.5}
              />
            </div>
          </div>

          <Panel
            className="mt-4"
            title="Month by month"
            note={
              categoryLabel
                ? `${categoryLabel} on each card, from your statements (a bill doesn't say what you bought)`
                : "Each card's spending with its number: solid where your statements are read, dashed where it's estimated from a bill, a gap where no file covers the month"
            }
          >
            <Trends
              months={trend.months}
              series={trend.trends}
              colourOf={(id) => colours.get(id) ?? OTHER_COLOUR}
              main={[...colours.keys()]}
              labelOf={(id) => {
                const c = data.cards.find((x) => x.id === id)
                return c ? cardName(c) : id
              }}
              storageKey="plutus.cardTrends.ticked"
              when={when}
              kind={['card', 'cards']}
              defaultTicked={7}
              force={card ? [card] : null}
              ariaLabel="Monthly spending by card"
            />
          </Panel>

          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <Panel className="lg:col-span-6" title="Where it went" note={view.byCategory.length ? 'Tap a row to focus on it' : undefined}>
              {view.byCategory.length > 0 ? (
                <CategoryBars rows={view.byCategory} total={f.itemized} selected={category} onSelect={setCategory} />
              ) : (
                <p className="py-6 text-center text-sm text-zinc-500">Add a statement and its purchases show here by category.</p>
              )}
              {f.estimated > 0.5 && (
                <p className="mt-4 border-t border-white/[0.05] pt-3 text-xs leading-relaxed text-zinc-500">
                  + {inr(f.estimated)} estimated from bills, which don't say what you bought. Add those months' statements to see it here.
                </p>
              )}
            </Panel>
            <Panel className="lg:col-span-6" title={`Biggest purchases${categoryLabel ? ` in ${categoryLabel}` : ''}`} note="With the card number, read from your statements">
              {biggest.length > 0 ? (
                <ul className="space-y-0.5">
                  {biggest.map((t) => (
                    <li key={t.id} className="flex items-center gap-3 py-1.5 text-sm">
                      <span className="w-24 shrink-0 text-xs text-zinc-500 tabular-nums">{dayLabel(t.at)}</span>
                      <span className="min-w-0 flex-1 truncate text-zinc-200" title={t.note || t.payee}>
                        {t.payee}
                      </span>
                      <span className="hidden truncate text-xs text-zinc-500 sm:block">{data.categories.get(t.category)?.label}</span>
                      <span className="w-24 text-right text-zinc-100 tabular-nums">{inrExact(t.amount)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-zinc-500">No purchases read from statements {when}.</p>
              )}
            </Panel>
          </div>

          {merchants.length > 0 && (
            <Panel className="mt-4" title="Where you used your cards most" note="Purchases with the card number, refunds taken off">
              <ul className="grid gap-x-8 gap-y-0.5 sm:grid-cols-2">
                {merchants.slice(0, 10).map((p) => (
                  <li key={p.payee} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className={`min-w-0 flex-1 truncate ${p.payee === NO_NAME ? 'text-zinc-500 italic' : 'text-zinc-200'}`} title={p.payee}>
                      {p.payee === NO_NAME ? 'No merchant name' : p.payee}
                    </span>
                    <span className="hidden truncate text-xs text-zinc-500 md:block">{data.categories.get(p.category)?.label}</span>
                    <span className="w-24 text-right text-zinc-100 tabular-nums">{inr(p.amount)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

function Tile({ label, value, caption, muted }: { label: string; value: string; caption: string; muted?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tracking-tight ${muted ? 'text-zinc-500' : ''}`}>{value}</p>
      <p className="mt-1 text-xs leading-snug text-zinc-500">{caption}</p>
    </div>
  )
}
