import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, ChevronRight, CircleDashed, CreditCard, Tags } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { biggestIn, cardEstimates, highlights, namesWaiting, shopsIn, topShops, UNCATEGORIZED, type Shop } from '../../lib/focus'
import { formatSpan, plural } from '../../lib/format'
import { NO_NAME, topOf, type LedgerData, type PeriodView } from '../../lib/ledger'
import { inr, inrExact } from '../../lib/money'
import { dayLabel, dayMonthLabel, monthLongLabel, monthYearLabel, type PeriodKey } from '../../lib/periods'
import { CARD_PURCHASES, type TotalSpend } from '../../lib/totals'
import { CategorySelect } from './CategorySelect'

/** What Total spend shows under its sum line (the numbers: lib/focus.ts): for what you tapped, where its money went,
 *  shop by shop, and its biggest payments (Uncategorized: each shop with its answer; Card purchases: the bills they're
 *  estimated from; Other: what's in it); with nothing tapped, the period's highlights and one thing to do. */

export const OTHER = 'other'
const SHOPS = 6

export interface FocusProps {
  data: LedgerData
  view: PeriodView
  totals: TotalSpend
  period: PeriodKey
  /** A category or sub-category, Card purchases (or one card's: "cards.<card>"), or Other. */
  selected: string
  /** The categories the ring folds into Other. */
  others: { id: string; label: string; amount: number }[]
  colourOf: (id: string) => string
  onSelect: (id: string | null) => void
  onShow: (ids: string[], label: string) => void
  onChanged: () => void
  notify: (text: string) => void
}

const when = (period: PeriodKey) => (period === 'all' ? 'across all years' : `in ${period}`)
const Label = ({ children }: { children: ReactNode }) => <p className="mt-5 mb-2 text-xs font-medium tracking-wide text-muted uppercase">{children}</p>

/** What you tapped, changing with it. */
export function FocusDetail(props: FocusProps) {
  const { selected } = props
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={selected}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        role="region"
        aria-label="What you tapped, in detail"
      >
        {selected === OTHER ? (
          <OtherDetail {...props} />
        ) : topOf(selected) === CARD_PURCHASES ? (
          <CardsDetail {...props} />
        ) : (
          <CategoryDetail {...props} />
        )}
      </motion.div>
    </AnimatePresence>
  )
}

function Head({ colour, title, sub, line, action }: { colour: string; title: string; sub?: string; line: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <div className="min-w-0 flex-1 basis-52">
        <p className="flex min-w-0 items-center gap-2 text-[15px] font-medium text-zinc-100">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: colour }} />
          <span className="truncate">{title}</span>
          {sub && (
            <>
              <ChevronRight className="size-3.5 shrink-0 text-muted" />
              <span className="truncate">{sub}</span>
            </>
          )}
        </p>
        <p className="mt-0.5 text-xs text-muted tabular-nums">{line}</p>
      </div>
      {action}
    </div>
  )
}

function ShowAll({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tap inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
    >
      Show all {count} <ArrowRight className="size-3.5" />
    </button>
  )
}

function CategoryDetail({ data, view, totals, period, selected, colourOf, onShow, onChanged, notify }: FocusProps) {
  const top = totals.byCategory.find((c) => c.id === topOf(selected))
  const child = selected !== top?.id ? top?.children.find((c) => c.id === selected) : undefined // a top row's own payments share its id
  const row = child ?? top
  const shops = useMemo(() => shopsIn(data, view, selected), [data, view, selected])
  const { shown, rest } = useMemo(() => topShops(shops, SHOPS), [shops])
  const biggest = useMemo(() => biggestIn(data, view, selected), [data, view, selected])
  if (!top || !row) return null

  const waiting = top.id === UNCATEGORIZED
  const ids = shops.flatMap((s) => s.ids)
  const share = totals.total > 0 ? (row.amount / totals.total) * 100 : 0
  const named = `${child ? child.label : top.label} ${when(period)}`
  const max = shown[0]?.amount ?? 0
  const subOf = (category: string) => (!child && top.children.length > 1 ? (category === top.id ? 'general' : data.categories.get(category)?.label) : undefined)

  return (
    <div>
      <Head
        colour={colourOf(top.id)}
        title={top.label}
        sub={child?.label}
        line={`${inr(row.amount)} · ${plural(row.count, 'payment')} · ${share > 0 && share < 1 ? '<1' : Math.round(share)}% of your spending ${when(period)}`}
        action={ids.length > 0 && <ShowAll count={row.count} onClick={() => onShow(ids, named)} />}
      />

      <Label>{waiting ? 'Waiting for a category' : 'Top payees'}</Label>
      {waiting && <p className="-mt-1 mb-3 text-xs leading-relaxed text-muted">One answer files every payment to a payee, in every year, as Needs your eyes does.</p>}
      <ul className="space-y-3" aria-label={waiting ? 'Waiting for a category' : 'Top payees'}>
        {shown.map((s) => (
          <li key={s.shop}>
            <ShopLine shop={s} max={max} colour={colourOf(top.id)} />
            {waiting && (s.shop === NO_NAME
              ? <Unnamed shop={s} onShow={() => onShow(s.ids, 'payments with no payee name')} />
              : <Answer shop={s} data={data} onChanged={onChanged} notify={notify} />)}
          </li>
        ))}
      </ul>
      {rest.count > 0 && <p className="mt-2.5 text-xs text-muted">and {plural(rest.count, 'more payee')}, {inr(rest.amount)} between them</p>}
      {!shown.length && <p className="text-sm text-muted">Nothing spent here {when(period)}.</p>}

      {biggest.length > 0 && (
        <>
          <Label>Biggest payments</Label>
          <ul className="-mx-2" aria-label="Biggest payments">
            {biggest.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onShow([p.id], `${p.shop === NO_NAME ? 'a payment with no payee name' : p.shop}, ${dayLabel(p.day)}`)}
                  title="Show it in Your transactions"
                  className="flex w-full items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-white/[0.04]"
                >
                  <span className={`shrink-0 text-xs text-muted tabular-nums ${period === 'all' ? 'w-[5.5rem]' : 'w-14'}`}>{period === 'all' ? dayLabel(p.day) : dayMonthLabel(p.day)}</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-200">
                    {p.shop === NO_NAME ? <span className="text-muted italic">No payee name</span> : p.shop}
                    {subOf(p.category) && <span className="hidden text-muted sm:inline"> · {subOf(p.category)}</span>}
                  </span>
                  {p.refunded > 0.005 && <span className="shrink-0 text-xs text-emerald-300 tabular-nums">{inrExact(p.refunded)} back</span>}
                  <span className="shrink-0 text-zinc-100 tabular-nums">{inrExact(p.amount)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** A shop: what you spent there, a bar against the biggest, and how else its files spell it. */
function ShopLine({ shop: s, max, colour }: { shop: Shop; max: number; colour: string }) {
  const others = s.names.filter((n) => n !== s.shop)
  return (
    <div>
      <div className="flex items-baseline gap-3 text-sm">
        <span className={`min-w-0 flex-1 truncate ${s.shop === NO_NAME ? 'text-muted italic' : 'text-zinc-200'}`} title={s.names.join(' · ')}>
          {s.shop === NO_NAME ? 'No payee name' : s.shop}
        </span>
        <span className="shrink-0 text-zinc-100 tabular-nums">{inr(s.amount)}</span>
      </div>
      <span className="mt-1.5 block h-1.5">
        <motion.span
          className="block h-full rounded-r"
          style={{ background: colour }}
          initial={{ width: 0 }}
          animate={{ width: `${Math.max(1.5, (s.amount / max) * 100)}%` }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
      </span>
      <p className="mt-1 truncate text-xs text-muted tabular-nums" title={s.names.join(' · ')}>
        {plural(s.payments, 'payment')}
        {others.length > 0 && (others.length === 1 ? ` · also spelt “${others[0]}”` : ` · spelt ${s.names.length} ways in your files`)}
      </p>
    </div>
  )
}

/** A shop waiting in Uncategorized, answered here: each of its spellings filed as the review list files a payee. */
function Answer({ shop, data, onChanged, notify }: { shop: Shop; data: LedgerData; onChanged: () => void; notify: (text: string) => void }) {
  const [category, setCategory] = useState(UNCATEGORIZED)
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const res = await api.categorizeBulk(namesWaiting(data.txns, shop.shop).map((payee) => ({ payee, category })))
      const mine = res.accounts ? ` · saved as one of your accounts` : ''
      notify(`${shop.shop} filed under ${data.categories.get(category)?.label ?? category}${mine} · ${plural(res.updated, 'payment')} updated`)
      onChanged()
    } catch (err) {
      notify(`Couldn't save it: ${(err as Error).message}`)
      setSaving(false)
    }
  }
  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <CategorySelect tree={data.tree} value={category} onChange={setCategory} compact label={`Category for ${shop.shop}`} />
      </div>
      <button
        type="button"
        onClick={save}
        disabled={saving || category === UNCATEGORIZED}
        className="tap shrink-0 rounded-full bg-white px-3.5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}

function Unnamed({ shop, onShow }: { shop: Shop; onShow: () => void }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 basis-48 text-xs leading-relaxed text-muted">Their files don't say who was paid, so each one needs its own answer.</p>
      <button
        type="button"
        onClick={onShow}
        className="tap shrink-0 rounded-full bg-white/[0.06] px-3.5 py-1.5 text-sm text-zinc-100 ring-1 ring-white/10 transition hover:bg-white/[0.1]"
      >
        Show {shop.payments === 1 ? 'it' : 'them'}
      </button>
    </div>
  )
}

/** Card purchases known only from bills: the cards, and a card's bills. A bill doesn't say what it paid for. */
function CardsDetail({ data, view, totals, period, selected, colourOf, onSelect }: FocusProps) {
  const cards = useMemo(() => cardEstimates(data, view, totals, period), [data, view, totals, period])
  const one = selected === CARD_PURCHASES ? null : cards.find((c) => `${CARD_PURCHASES}.${c.card}` === selected)
  const shown = one ? [one] : cards
  const amount = shown.reduce((s, c) => s + c.amount, 0)
  const bills = shown.reduce((s, c) => s + c.bills.length, 0)
  return (
    <div>
      <Head
        colour={colourOf(CARD_PURCHASES)}
        title="Card purchases"
        sub={one?.label}
        line={`≈ ${inr(amount)} · estimated from ${plural(bills, 'bill')} ${when(period)}`}
      />
      <p className="mt-3 flex gap-2.5 rounded-2xl px-3.5 py-3 text-xs leading-relaxed text-zinc-400 ring-1 ring-white/[0.08] ring-inset">
        <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted" />
        A bill doesn't say what it paid for, so these purchases have no payees. Add {one ? "this card's" : 'a card’s'} statements and they show here, payee by payee.
      </p>
      <Label>{one ? 'Its bills' : 'From your bills'}</Label>
      {one ? (
        <ul className="divide-y divide-white/[0.05]" aria-label="Its bills">
          {one.bills.map((b) => (
            <li key={b.id} className="flex items-baseline gap-3 py-2 text-sm">
              <span className="shrink-0 text-xs text-muted tabular-nums">Paid {period === 'all' ? dayLabel(b.paidOn) : dayMonthLabel(b.paidOn)}</span>
              <span className="min-w-0 flex-1 text-zinc-400">
                {b.from && b.to ? `for ${formatSpan(b.from, b.to)}` : 'its cycle not known'} · bill {inr(b.amount)}
                {b.share < 0.999 && ` · its days ${when(period)}`}
              </span>
              <span className="shrink-0 text-zinc-100 tabular-nums">≈ {inr(b.estimate)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="-mx-2 space-y-0.5" aria-label="From your bills">
          {cards.map((c) => (
            <li key={c.card}>
              <button
                type="button"
                onClick={() => onSelect(`${CARD_PURCHASES}.${c.card}`)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.04]"
              >
                <CreditCard className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-zinc-200">{c.label}</span>
                  <span className="block truncate text-xs text-muted tabular-nums">
                    {plural(c.bills.length, 'bill')}, {inr(c.paid)}
                    {c.counted > 0.5 ? `, less ${inr(c.counted)} paid with it on UPI (counted there)` : ''}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-zinc-100 tabular-nums">≈ {inr(c.amount)}</span>
                <ChevronRight className="size-3.5 shrink-0 text-muted" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The categories too small for a colour of their own, folded into Other on the ring. */
function OtherDetail({ totals, period, others, colourOf, onSelect }: FocusProps) {
  const amount = others.reduce((s, c) => s + c.amount, 0)
  return (
    <div>
      <Head colour={colourOf(OTHER)} title="Other" line={`${inr(amount)} · ${plural(others.length, 'category', 'categories')} ${when(period)}, ${Math.round((amount / totals.total) * 100)}% of your spending`} />
      <Label>What's in it</Label>
      <ul className="-mx-2 space-y-0.5" aria-label="What's in Other">
        {others.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onSelect(c.id)}
              className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left text-sm transition hover:bg-white/[0.04]"
            >
              <span className="min-w-0 flex-1 truncate text-zinc-200">{c.label}</span>
              <span className="shrink-0 text-zinc-100 tabular-nums">{inr(c.amount)}</span>
              <ChevronRight className="size-3.5 shrink-0 text-muted" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Nothing tapped: the period at a glance, and the one thing that would make its figures fuller. */
export function Highlights({ data, view, totals, period, onSelect, onShow }: Omit<FocusProps, 'selected' | 'others' | 'colourOf' | 'onChanged' | 'notify'>) {
  const h = useMemo(() => highlights(data, view, totals, period), [data, view, totals, period])
  const change = h.before ? Math.round(((h.before.now - h.before.then) / h.before.then) * 100) : 0
  return (
    <div>
      <div className="grid gap-2.5 sm:grid-cols-2 sm:[&>*:last-child:nth-child(odd)]:col-span-2">
        {h.biggest && (
          <Tile
            label="Biggest payment"
            value={inrExact(h.biggest.amount)}
            caption={`${h.biggest.shop === NO_NAME ? 'No payee name' : h.biggest.shop} · ${dayLabel(h.biggest.day)}`}
            onClick={() => onShow([h.biggest!.id], `your biggest payment ${when(period)}`)}
          />
        )}
        {h.topShop && (
          <Tile
            label="Top payee"
            value={h.topShop.shop}
            caption={`${inr(h.topShop.amount)} · ${plural(h.topShop.payments, 'payment')}`}
            onClick={() => onShow(h.topShop!.ids, `${h.topShop!.shop} ${when(period)}`)}
          />
        )}
        {h.busiest && (
          <Tile
            label="Busiest month"
            value={period === 'all' ? monthYearLabel(h.busiest.month) : monthLongLabel(h.busiest.month).split(' ')[0]}
            caption={`${h.busiest.estimated ? '≈ ' : ''}${inr(h.busiest.amount)} spent`}
          />
        )}
        {h.before && (
          <Tile
            label={`Against ${h.before.year}`}
            value={`${change > 0 ? '+' : change < 0 ? '−' : ''}${Math.abs(change)}%`}
            caption={`${inr(Math.abs(h.before.now - h.before.then))} ${h.before.now >= h.before.then ? 'more' : 'less'}, over the same ${plural(h.before.months, 'month')}`}
            title={`${inr(h.before.now)} against ${inr(h.before.then)}, over the ${plural(h.before.months, 'month')} both years' files cover alike`}
          />
        )}
      </div>
      {h.action && <Action action={h.action} onSelect={onSelect} />}
    </div>
  )
}

function Tile({ label, value, caption, title, onClick }: { label: string; value: string; caption: string; title?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="block text-xs text-zinc-400">{label}</span>
      <span className="mt-1 block truncate text-lg font-semibold tracking-tight text-zinc-50 tabular-nums">{value}</span>
      <span className="mt-0.5 block truncate text-xs text-muted">{caption}</span>
    </>
  )
  const box = 'min-w-0 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 text-left'
  return onClick ? (
    <button type="button" onClick={onClick} title={title ?? 'Show it in Your transactions'} className={`${box} transition hover:border-white/[0.12] hover:bg-white/[0.04]`}>
      {body}
    </button>
  ) : (
    <div className={box} title={title}>
      {body}
    </div>
  )
}

function Action({ action, onSelect }: { action: NonNullable<ReturnType<typeof highlights>['action']>; onSelect: (id: string) => void }) {
  const [text, sub, target] =
    action.kind === 'uncategorized'
      ? [`${inr(action.amount)} waits for a category`, `${plural(action.shops, 'payee')} · sort them here, one answer each`, UNCATEGORIZED]
      : action.kind === 'estimated'
        ? [`${inr(action.amount)} is estimated from card bills`, `See which ${action.cards === 1 ? 'card' : 'cards'}; add their statements to see where it went`, CARD_PURCHASES]
        : ["Your cards aren't counted yet", 'Add a card statement, or your CRED payment history, to count them', null]
  const body = (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-status-warning)]/10 text-[var(--color-status-warning)] ring-1 ring-[var(--color-status-warning)]/20">
        {action.kind === 'uncategorized' ? <Tags className="size-4" /> : <CreditCard className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-zinc-100 tabular-nums">{text}</span>
        <span className="block text-xs text-muted">{sub}</span>
      </span>
      {target && <ArrowRight className="size-4 shrink-0 text-muted" />}
    </>
  )
  const box = 'mt-2.5 flex w-full items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3 text-left'
  return target ? (
    <button type="button" onClick={() => onSelect(target)} className={`${box} transition hover:border-white/[0.12] hover:bg-white/[0.04]`}>
      {body}
    </button>
  ) : (
    <div className={box}>{body}</div>
  )
}
