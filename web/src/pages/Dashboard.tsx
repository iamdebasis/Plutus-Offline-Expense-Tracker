import { motion } from 'motion/react'
import { CircleCheck, CirclePause, CreditCard, ListChecks, Plus, Smartphone, TrendingUp, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { AskPanel } from '../components/AskPanel'
import { Backdrop } from '../components/Backdrop'
import { CardFace } from '../components/CardFace'
import { CardSpending } from '../components/dash/CardSpending'
import { CategoryBars } from '../components/dash/CategoryBars'
import { Panel, SectionHead } from '../components/dash/Section'
import { MonthlyTrends } from '../components/dash/MonthlyTrends'
import { TotalSpend } from '../components/dash/TotalSpend'
import { MonthlyChart } from '../components/dash/MonthlyChart'
import { InvestmentsSwitch } from '../components/dash/InvestmentsSwitch'
import { ReviewPanel } from '../components/dash/ReviewQueue'
import { TransactionsTable, type ShowRequest } from '../components/dash/TransactionsTable'
import type { Intake } from '../components/FileIntake'
import { ActivityLine, ImportActivity } from '../components/ImportActivity'
import { Header } from '../components/Header'
import { Vault } from '../components/Vault'
import { categoryIcon } from '../lib/categoryIcons'
import { plural } from '../lib/format'
import { skinFor } from '../components/cards/skins'
import { NO_NAME, bucketOf, bestPeriod, describeSource, periodsIn, topOf, upiOnly, viewFor, type LedgerData, type PeriodView } from '../lib/ledger'
import { inr, inrExact } from '../lib/money'
import { INVESTMENTS, scoped } from '../lib/scope'
import { totalSpendFor } from '../lib/totals'
import type { CardStatement, OwnAccount } from '../types'
import type { Activity } from '../lib/useImportActivity'
import { dayLabel, monthKey, periodLabel, spanLabel, type PeriodKey } from '../lib/periods'

const rupees = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

interface Props {
  data: LedgerData
  refresh: () => void
  intake: Intake
  activity: Activity
}

export function Dashboard({ data: everything, refresh, intake, activity }: Props) {
  // Years and colours come from everything; every figure, chart and list from what counts (investments can be
  // left out, see lib/scope.ts), so the switch never moves a year or repaints a category.
  const years = useMemo(() => periodsIn(everything), [everything])
  const [period, setPeriod] = useState<PeriodKey>(() => bestPeriod(everything))
  const [category, setCategory] = useState<string | null>(null)
  // your choice, kept in data/settings.json: shown at once, saved behind the scenes, undone if it can't be saved
  const saved = everything.preferences.countInvestments
  const [countInvestments, setCount] = useState(saved)
  useEffect(() => setCount(saved), [saved])
  const setCountInvestments = (on: boolean) => {
    setCount(on)
    api.setPreferences({ countInvestments: on }).catch(() => {
      setCount(!on)
      intake.notify("Couldn't save that setting")
    })
  }
  const data = useMemo(() => scoped(everything, countInvestments), [everything, countInvestments])
  const leftOut = useMemo(() => (countInvestments ? [] : [INVESTMENTS]), [countInvestments])

  useEffect(() => setCategory(null), [period])
  useEffect(() => {
    if (category && leftOut.includes(topOf(category))) setCategory(null)
  }, [category, leftOut])

  const sentinel = useRef<HTMLDivElement>(null)
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting))
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // everything (cards and UPI) for Total spend, the charts and the cards; UPI alone for the UPI section
  const all = useMemo(() => viewFor(data, period, null), [data, period])
  const focused = useMemo(() => viewFor(data, period, category), [data, period, category])
  const upi = useMemo(() => upiOnly(data), [data])
  const upiAll = useMemo(() => viewFor(upi, period, null), [upi, period])
  const upiFocused = useMemo(() => viewFor(upi, period, category), [upi, period, category])
  const allTime = useMemo(() => totalSpendFor(everything, viewFor(everything, 'all', null)), [everything])
  const totals = useMemo(() => totalSpendFor(data, all), [data, all])
  const categoryLabel = category ? data.categories.get(category)?.label : null

  // Ask Plutus: questions about your spending, answered from these same numbers (the orb in the corner opens it;
  // components/AskPanel.tsx)
  const [asking, setAsking] = useState(false)
  const openAsk = useMemo(() => () => setAsking(true), [])
  const closeAsk = useMemo(() => () => setAsking(false), [])

  // "Show them" (payments with no name) and "Show these rows" (a statement's): open them in the transactions list
  const [request, setRequest] = useState<ShowRequest | null>(null)
  const show = (what: Omit<ShowRequest, 'at'>) => {
    setCategory(null)
    setRequest({ ...what, at: Date.now() })
    requestAnimationFrame(() => document.getElementById('transactions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  const deleteUpload = async (id: string) => {
    await api.deleteUpload(id).catch(() => intake.notify("Couldn't delete that file"))
    refresh()
  }

  return (
    <div className="relative min-h-dvh pb-28">
      <Backdrop />
      <Header
        activity={activity}
        actions={
          <button
            type="button"
            onClick={() => intake.browse()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-zinc-950 shadow-lg shadow-black/40 transition hover:bg-zinc-200"
          >
            <Plus className="size-4" />
            <span className="whitespace-nowrap">
              Add<span className="hidden sm:inline"> files</span>
            </span>
          </button>
        }
      />
      <AskPanel open={asking} onOpen={openAsk} onClose={closeAsk} data={data} onShow={(ids, label) => show({ ids, label })} />

      <main className="mx-auto max-w-6xl px-4 sm:px-6">
        {/* the timeline: one row that scopes everything below it */}
        <div ref={sentinel} aria-hidden className="h-6" />
        <div
          className={`sticky top-0 z-20 -mx-4 px-4 py-3 transition-colors duration-200 sm:-mx-6 sm:px-6 ${
            stuck ? 'border-b border-white/[0.06] bg-canvas/85 backdrop-blur-md' : 'border-b border-transparent'
          }`}
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div role="tablist" aria-label="Year" className="flex max-w-full gap-2 overflow-x-auto [scrollbar-width:none]">
              {[...years, 'all' as const].map((p) => {
                const active = period === p
                return (
                  <button
                    key={p}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setPeriod(p)}
                    className={`relative shrink-0 rounded-xl px-4 py-2 text-sm font-semibold whitespace-nowrap tabular-nums ring-1 transition ${
                      active ? 'text-zinc-950 ring-white' : 'text-zinc-400 ring-white/10 hover:text-zinc-100 hover:ring-white/25'
                    }`}
                  >
                    {active && <motion.span layoutId="year" className="absolute inset-0 rounded-xl bg-white" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
                    <span className="relative">{periodLabel(p)}</span>
                  </button>
                )
              })}
            </div>
            <InvestmentsSwitch on={countInvestments} onChange={setCountInvestments} />
            <Coverage view={all} held={data.held} />
            <div className="ml-auto flex items-center gap-2">
              {categoryLabel && (
                <button
                  type="button"
                  onClick={() => setCategory(null)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] px-3 py-1.5 text-sm text-zinc-100 ring-1 ring-white/15"
                >
                  {categoryLabel} <X className="size-3.5" />
                </button>
              )}
              <ImportActivity
                activity={activity}
                pending={intake.pending}
                onReview={() => document.getElementById('review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              />
            </div>
          </div>
          <ActivityLine activity={activity} pending={intake.pending} />
        </div>

        <TotalSpend totals={totals} allTime={allTime} period={period} />
        <MonthlyTrends data={data} view={all} totals={totals} allTime={allTime} period={period} leftOut={leftOut} />
        <CreditCards data={data} everything={everything} view={all} period={period} onChanged={refresh} />
        <UpiSpends data={data} all={upiAll} focused={upiFocused} category={category} setCategory={setCategory} refresh={refresh} notify={intake.notify} />
        <YourTransactions
          data={data}
          txns={focused.txns}
          period={period}
          category={category}
          leftOut={leftOut}
          request={request}
          onAllYears={() => setPeriod('all')}
          onShowUnnamed={() => show({ text: NO_NAME })}
          refresh={refresh}
          notify={intake.notify}
        />

        <Vault
          uploads={data.uploads}
          cards={data.cards}
          statements={[...data.statements, ...data.held]}
          txns={data.txns}
          onShowRows={(upload, label) => show({ upload, label })}
          onDelete={deleteUpload}
          onChanged={refresh}
          showCards={false}
        />
      </main>
    </div>
  )
}

/** What the files cover in the selected period, so a quiet month isn't mistaken for no spending; and any statement
 *  on hold, whose rows aren't counted yet. */
function Coverage({ view, held }: { view: PeriodView; held: CardStatement[] }) {
  const upi = spanLabel([...view.coverage.upi])
  const cards = spanLabel([...view.coverage.cards])
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
      <span className="inline-flex items-center gap-1.5">
        <CreditCard className="size-3.5" /> Card bills: <span className="text-zinc-300">{cards ?? 'none'}</span>
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Smartphone className="size-3.5" /> UPI: <span className="text-zinc-300">{upi ?? 'none'}</span>
      </span>
      {view.coverage.statements.size > 0 && (
        <span className="inline-flex items-center gap-1.5">
          <CreditCard className="size-3.5" /> Card statements: <span className="text-zinc-300">{spanLabel([...view.coverage.statements])}</span>
        </span>
      )}
      {held.length > 0 && (
        <a href="#your-vault" className="inline-flex items-center gap-1.5 text-amber-200/90 hover:text-amber-100" title="Check it in Your vault">
          <CirclePause className="size-3.5" /> {plural(held.length, 'statement')} on hold:{' '}
          <span>{plural(held.reduce((n, s) => n + s.held.length, 0), 'row')} not counted yet</span>
        </a>
      )}
      {view.leftOut.count > 0 && (
        <span className="inline-flex items-center gap-1.5" title="Turn on Count investments to include them">
          <TrendingUp className="size-3.5" /> Investments:{' '}
          <span className="text-zinc-300">
            {inr(view.leftOut.amount)} left out · {plural(view.leftOut.count, 'payment')}
          </span>
        </span>
      )}
    </p>
  )
}

// ---- credit cards ------------------------------------------------------------------------------

function CreditCards({ data, everything, view, period, onChanged }: { data: LedgerData; everything: LedgerData; view: PeriodView; period: PeriodKey; onChanged: () => void }) {
  const paid = new Map(view.cardBills.map((b) => [b.card, b]))
  const estimated = new Map(view.estimatedBills.map((b) => [b.card, b.amount]))
  // with the card's number: read one by one, or estimated from its bills; what was paid with it on UPI is UPI's
  const spentWith = (id: string) => (view.byCard.get(id)?.amount ?? 0) + (estimated.get(id) ?? 0)
  const weight = (id: string) => spentWith(id) + (view.byCard.get(id)?.viaUpi ?? 0) + (paid.get(id)?.amount ?? 0)
  const cards = [...data.cards].sort((a, b) => weight(b.id) - weight(a.id))
  // a card with nothing in the period (no spending, no UPI, no bill) can't be picked: there'd be nothing to show
  const active = new Set(cards.filter((c) => spentWith(c.id) > 0.5 || (view.byCard.get(c.id)?.viaUpi ?? 0) > 0.5 || paid.has(c.id)).map((c) => c.id))
  // the card picked by its face: the section below shows its spending
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => {
    if (picked && !active.has(picked)) setPicked(null) // another year, or its files were deleted
  }, [picked, active])
  const when = period === 'all' ? 'in total' : `in ${period}`
  const spentTotal = data.cards.reduce((s, c) => s + spentWith(c.id), 0)
  const everPaid = spanLabel(data.payments.map((p) => monthKey(p.at)))
  const glow = cards.slice(0, 3).map((c) => skinFor(c).glow)

  const setNetwork = async (id: string, network: string | null) => {
    await api.setCardNetwork(id, network)
    onChanged()
  }

  return (
    <section className="relative mt-14">
      <SectionHead
        icon={<CreditCard className="size-4" />}
        title="Credit cards"
        note={
          spentTotal > 0.5 || view.payments.length
            ? [
                spentTotal > 0.5 && `${inr(spentTotal)} spent with cards ${when}`,
                view.payments.length > 0 && `${inr(view.totals.cardBillsPaid)} in bills paid${spentTotal > 0.5 ? '' : ` ${when}`}`,
              ]
                .filter(Boolean)
                .join(' · ')
            : `Nothing on cards ${when} yet.${everPaid ? ` Your card bills cover ${everPaid}.` : ' Add a card statement or your CRED payment history.'}`
        }
      />

      {/* coloured light behind the glass */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-16 -z-10 h-80 overflow-hidden [mask-image:radial-gradient(ellipse_at_center,black_35%,transparent_72%)]">
        {glow.map((c, i) => (
          <span
            key={i}
            className="absolute size-72 rounded-full opacity-25 blur-[90px]"
            style={{ background: c, left: `${8 + i * 30}%`, top: i % 2 ? '10%' : '30%' }}
          />
        ))}
      </div>

      {cards.length ? (
        // each card is 80% of an even 2 / 3 / 4 / 5-per-row split, so wider screens fit one more per row
        <div className="flex flex-wrap gap-x-4 gap-y-6">
          {cards.map((card, i) => {
            const b = paid.get(card.id)
            const spent = spentWith(card.id)
            const viaUpi = view.byCard.get(card.id)?.viaUpi ?? 0
            const shown = spent > 0.5 ? spent : b?.amount
            const [whole, paise] = shown !== undefined ? rupees.format(shown).split('.') : ['', '']
            const detail = [
              spent > 0.5 && `${inr(spent)} spent with the card ${when}`,
              viaUpi > 0.5 && `${inr(viaUpi)} paid with it on UPI, counted in UPI spends`,
              b && `${plural(b.count, 'bill')} paid, ${inr(b.amount)}`,
            ].filter(Boolean)
            return (
              <figure
                key={card.id}
                className="w-[calc((100%_-_1rem)_*_0.4)] min-w-0 sm:w-[calc((100%_-_2rem)_/_3_*_0.8)] md:w-[calc((100%_-_3rem)_*_0.2)] lg:w-[calc((100%_-_4rem)_*_0.16)]"
              >
                <CardFace
                  card={card}
                  dim={!active.has(card.id)}
                  delay={i * 0.035}
                  onSetNetwork={(n) => setNetwork(card.id, n)}
                  onSelect={active.has(card.id) ? () => setPicked(picked === card.id ? null : card.id) : undefined}
                  selected={picked === card.id}
                />
                <figcaption className="mt-2.5 px-0.5" title={detail.join(' · ') || undefined}>
                  {shown !== undefined ? (
                    <p className="flex items-center gap-1.5 text-[15px] leading-tight font-semibold tracking-tight">
                      {!(spent > 0.5) && <CircleCheck className="size-3.5 shrink-0 text-[var(--color-status-good)]" aria-label="Paid" />}
                      ₹{whole}
                      <span className="-ml-1.5 font-normal text-zinc-500">.{paise}</span>
                    </p>
                  ) : (
                    <p className="text-[15px] leading-tight font-semibold text-zinc-600">—</p>
                  )}
                  <p className="mt-0.5 truncate text-xs text-zinc-500">
                    {card.product ?? card.issuer} ·{' '}
                    {spent > 0.5 ? 'spent' : b ? `${plural(b.count, 'bill')} paid` : viaUpi > 0.5 ? 'only on UPI' : `nothing ${when}`}
                  </p>
                  {viaUpi > 0.5 && <p className="mt-0.5 truncate text-xs text-zinc-500">+ {inr(viaUpi)} on UPI</p>}
                </figcaption>
              </figure>
            )
          })}
        </div>
      ) : (
        <Empty>No cards yet. Add a CRED payment history or a card statement and your cards appear here.</Empty>
      )}

      {cards.length > 0 && (
        <CardSpending data={data} everything={everything} all={view} period={period} card={picked} onCard={setPicked} />
      )}
    </section>
  )
}

// ---- UPI ---------------------------------------------------------------------------------------

function UpiSpends({
  data,
  all,
  focused,
  category,
  setCategory,
  refresh,
  notify,
}: {
  data: LedgerData
  all: PeriodView
  focused: PeriodView
  category: string | null
  setCategory: (c: string | null) => void
  refresh: () => void
  notify: (text: string) => void
}) {
  const categoryLabel = category ? data.categories.get(category)?.label : null
  const biggest = useMemo(
    () =>
      focused.txns
        .filter((t) => bucketOf(t) === 'spent' && (!category || t.category === category || t.category.startsWith(category + '.')))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5),
    [focused.txns, category],
  )
  const { totals, counts } = all
  const span = spanLabel([...all.coverage.upi])

  return (
    <section className="mt-14">
      <SectionHead icon={<Smartphone className="size-4" />} title="UPI spends" note={span ? `From your UPI history · ${span}` : 'No UPI history for this period yet'} />

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="rounded-3xl border border-white/[0.07] bg-gradient-to-br from-white/[0.06] to-white/[0.015] p-6 lg:col-span-5">
          <p className="text-sm text-zinc-400">Spent via UPI</p>
          {counts.spent ? (
            <>
              <motion.p key={totals.spent} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-2 text-[52px] leading-none font-semibold tracking-tight">
                {inr(totals.spent)}
              </motion.p>
              <p className="mt-3 text-sm text-zinc-500">
                {plural(counts.spent, 'payment')} for things and services{totals.refunded ? `, after ${inr(totals.refunded)} refunded` : ''}.
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-[44px] leading-none font-semibold tracking-tight text-zinc-600">—</p>
              <p className="mt-3 text-sm text-zinc-500">No UPI history for this period yet.</p>
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-4 lg:col-span-7">
          <Tile label="Sent to people" value={inr(totals.people)} caption={`${plural(counts.people, 'payment')} · label them to count as spending`} />
          <Tile
            label="Per month"
            value={all.coverage.upi.size ? inr(totals.spent / all.coverage.upi.size) : '—'}
            caption={`Average over the ${plural(all.coverage.upi.size, 'month')} your UPI history covers`}
          />
          <Tile label="Money in" value={inr(totals.in + totals.cashback)} caption={totals.cashback ? `incl. ${inr(totals.cashback)} cashback` : plural(counts.in, 'credit')} />
          <Tile
            label="Ignored"
            value={inr(totals.ignored)}
            caption={`${plural(counts.ignored, 'transaction')} left out, incl. transfers between your own accounts`}
            muted
          />
        </div>
      </div>

      {all.byCategory.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {all.byCategory.slice(0, 4).map((c, i) => {
            const Icon = categoryIcon(c.id)
            const active = category === c.id
            return (
              <motion.button
                key={c.id}
                type="button"
                onClick={() => setCategory(active ? null : c.id)}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`rounded-2xl border p-4 text-left transition ${
                  active ? 'border-white/40 bg-white/[0.08]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                }`}
              >
                <span className="flex items-center justify-between">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-white/[0.07] text-zinc-200">
                    <Icon className="size-4" />
                  </span>
                  <span className="text-xs text-zinc-500 tabular-nums">{Math.round((c.amount / totals.spent) * 100)}%</span>
                </span>
                <span className="mt-3 block text-xs text-zinc-400">UPI spends on</span>
                <span className="block truncate text-sm font-medium text-zinc-100">{c.label}</span>
                <span className="mt-1 block text-xl font-semibold tracking-tight">{inr(c.amount)}</span>
              </motion.button>
            )
          })}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <Panel className="lg:col-span-6" title="Month by month" note={categoryLabel ? `${categoryLabel} only` : 'UPI spending, excluding transfers'}>
          <MonthlyChart months={focused.months} title={categoryLabel ? `${categoryLabel} per month` : 'Spent per month'} covered={all.coverage.upi} source="UPI data" />
          {biggest.length > 0 && (
            <div className="mt-5 border-t border-white/[0.05] pt-4">
              <p className="mb-2 text-sm text-zinc-400">Biggest payments{categoryLabel ? ` in ${categoryLabel}` : ''}</p>
              <ul className="space-y-0.5">
                {biggest.map((t) => (
                  <li key={t.id} className="flex items-center gap-3 py-1 text-sm">
                    <span className="w-24 shrink-0 text-xs text-zinc-500 tabular-nums">{dayLabel(t.at)}</span>
                    <span className="min-w-0 flex-1 truncate text-zinc-200" title={t.payee}>
                      {t.payee}
                    </span>
                    <span className="hidden truncate text-xs text-zinc-500 sm:block">{data.categories.get(t.category)?.label}</span>
                    <span className="w-24 text-right text-zinc-100 tabular-nums">{inrExact(t.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
        <Panel className="lg:col-span-6" title="Where it went" note="Tap a row to focus on it">
          <CategoryBars rows={all.byCategory} total={totals.spent} selected={category} onSelect={setCategory} />
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Panel title="Paid from" note="Where UPI payments were debited">
          <SourceList rows={all.paidFrom} data={data} />
          <YourAccounts accounts={data.accounts} paidFrom={all.paidFrom} onChanged={refresh} notify={notify} />
        </Panel>
        <Panel title="Who you paid most" note="Excluding card bills, ignored payees and your own accounts">
          <ul className="space-y-0.5">
            {all.topPayees.slice(0, 8).map((p) => (
              <li key={p.payee} className="flex items-center gap-3 py-1.5 text-sm">
                <span className={`min-w-0 flex-1 truncate ${p.payee === NO_NAME ? 'text-zinc-500 italic' : 'text-zinc-200'}`} title={p.payee}>
                  {p.payee === NO_NAME ? 'No payee name' : p.payee}
                </span>
                <span className="hidden truncate text-xs text-zinc-500 sm:block">{data.categories.get(p.category)?.label}</span>
                <span className="w-24 text-right text-zinc-100 tabular-nums">{inr(p.amount)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

    </section>
  )
}

// ---- building blocks ---------------------------------------------------------------------------

function Tile({ label, value, caption, muted }: { label: string; value: string; caption: string; muted?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold tracking-tight ${muted ? 'text-zinc-500' : ''}`}>{value}</p>
      <p className="mt-1 text-xs leading-snug text-zinc-500">{caption}</p>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl border border-dashed border-white/10 px-5 py-8 text-center text-sm text-zinc-500">{children}</p>
}

function SourceList({ rows, data }: { rows: PeriodView['paidFrom']; data: LedgerData }) {
  const max = rows[0]?.amount ?? 1
  if (!rows.length) return <p className="text-sm text-zinc-500">No UPI payments in this period.</p>
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const card = r.card ? data.cards.find((c) => c.id === r.card) : undefined
        const d = card ? { title: `${card.name} ••${card.last4}`, detail: 'Credit card on UPI' } : describeSource(r.mask, data.cards, data.accounts)
        return (
          <li key={r.card ?? r.mask} className="text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-zinc-200">
                {d.title} <span className="text-xs text-zinc-500">{d.detail}</span>
              </span>
              <span className="text-zinc-100 tabular-nums">{inr(r.amount)}</span>
            </div>
            <div className="mt-1.5 h-1.5 rounded-r bg-white/[0.04]">
              <div className="h-full rounded-r bg-[var(--color-series-1)]" style={{ width: `${Math.max(1, (r.amount / max) * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-zinc-500">{plural(r.count, 'payment')}</p>
          </li>
        )
      })}
    </ul>
  )
}

/** Accounts you said are yours (data/accounts.json) that this period's payments don't already show: transfers to
 *  and from them are left out. "Not mine" undoes it, and their transfers count again. */
function YourAccounts({
  accounts,
  paidFrom,
  onChanged,
  notify,
}: {
  accounts: OwnAccount[]
  paidFrom: PeriodView['paidFrom']
  onChanged: () => void
  notify: (text: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const shown = new Set(paidFrom.filter((r) => !r.card).map((r) => r.mask.replace(/\D/g, '').slice(-4)))
  const rest = accounts.filter((a) => !shown.has(a.last4))
  if (!rest.length) return null

  const notMine = async (a: OwnAccount) => {
    setBusy(a.last4)
    try {
      const res = await api.forgetAccount(a.last4)
      notify(`••${a.last4} isn't one of your accounts now · ${plural(res.updated, 'payment')} counted again`)
      onChanged()
    } catch (err) {
      notify(`Couldn't change that: ${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mt-5 border-t border-white/[0.05] pt-4">
      <p className="mb-2 text-sm text-zinc-400">Also yours</p>
      <p className="mb-3 text-xs text-zinc-500">Transfers to and from these accounts are left out of every total.</p>
      <ul className="space-y-1.5">
        {rest.map((a) => (
          <li key={a.last4} className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate text-zinc-200" title={a.seenAs ? `Marked from "${a.seenAs}"` : undefined}>
              {a.label || 'Account'} ••{a.last4}
              {a.seenAs && <span className="ml-2 text-xs text-zinc-500">{a.seenAs}</span>}
            </span>
            <button
              type="button"
              onClick={() => notMine(a)}
              disabled={busy === a.last4}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs text-zinc-400 ring-1 ring-white/10 transition hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
            >
              Not mine
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---- your transactions: what needs an answer, and every payment -------------------------------------------

function YourTransactions({
  data,
  txns,
  period,
  category,
  leftOut,
  request,
  onAllYears,
  onShowUnnamed,
  refresh,
  notify,
}: {
  data: LedgerData
  /** Every payment in the period and category: UPI and card statements. */
  txns: PeriodView['txns']
  period: PeriodKey
  category: string | null
  leftOut: string[]
  request: ShowRequest | null
  onAllYears: () => void
  onShowUnnamed: () => void
  refresh: () => void
  notify: (text: string) => void
}) {
  const categoryLabel = category ? data.categories.get(category)?.label : null
  return (
    <section className="mt-14">
      <SectionHead icon={<ListChecks className="size-4" />} title="Your transactions" note="UPI and cards together" />
      <ReviewPanel
        id="review"
        className="scroll-mt-24"
        txns={data.txns}
        tree={data.tree}
        period={period}
        onAllYears={onAllYears}
        onShowUnnamed={onShowUnnamed}
        onChanged={refresh}
        notify={notify}
      />
      <Panel id="transactions" className="mt-4 scroll-mt-24" title="Transactions" note={categoryLabel ? `Showing ${categoryLabel}` : undefined}>
        <TransactionsTable
          txns={txns}
          everything={data.txns}
          payments={data.payments}
          tree={data.tree}
          cards={data.cards}
          accounts={data.accounts}
          category={category}
          leftOut={leftOut}
          request={request}
          onChanged={refresh}
          notify={notify}
        />
      </Panel>
    </section>
  )
}
