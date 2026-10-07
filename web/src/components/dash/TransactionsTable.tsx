import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Check, CornerDownRight, Search, Sparkles, Undo2, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { NO_NAME, countsAs, isCardBill, isIgnored, paidFromLabel, rowTag, topOf, type Bucket } from '../../lib/ledger'
import { plural } from '../../lib/format'
import { inrExact } from '../../lib/money'
import { dayLabel, timeLabel } from '../../lib/periods'
import { keepShown, tick, tickedTotal } from '../../lib/selection'
import type { CardPayment, CategoryNode, Instrument, OwnAccount, PaymentState, Transaction } from '../../types'
import { CategorySelect } from './CategorySelect'

const PAGE = 60

/** A request from elsewhere on the page to show some payments: a search ("Show them": no payee name), one file's rows
 *  ("Show these rows": a card statement in the vault), or exactly these payments (`ids`: an answer in Ask Plutus).
 *  `at` makes each request new. */
export type ShowRequest = { text?: string; upload?: string; ids?: string[]; label?: string; at: number }
type Source = 'all' | 'upi' | 'cards'

/** After re-filing one payment: the same shop's other payments, offered to change too. Nothing else changes
 *  unless you choose "Change all". */
type Offer = {
  txnId: string
  payee: string
  category: string
  /** `pending`: payments to this name not already in that category. */
  names: { payee: string; pending: number; ticked: boolean }[]
  /** Set when you ignored a transfer to a bank account not known to be yours: its last four digits, to ask whether
   *  it's yours (then every transfer to and from it is left out). Asked instead of the shop's other payments. */
  account?: string
  state: 'ask' | 'saving' | 'done'
  done?: string
}

/** A change to several ticked payments: saving, then what happened, with a way back for a little while. */
type Bulk = { state: 'saving' | 'done'; text: string; before?: PaymentState[] }

const CARD_BILL = 'transfers.card_bill'
const COUNTS_AS: Record<Bucket, string> = {
  spent: 'spending',
  people: 'a payment to a person',
  cardBill: 'a card bill',
  in: 'money in',
  cashback: 'cashback',
  ignored: 'nothing',
}

/** Filing a payment to your card under this category would start counting it (as spending or money in): the page asks
 *  first. Moving it to Ignored counts it nowhere either, so that needs no asking. */
const movesCardBill = (t: Transaction, category: string) => isCardBill(t) && category !== CARD_BILL && countsAs(t, category) !== 'ignored'

export function TransactionsTable({
  txns,
  everything = txns,
  payments,
  tree,
  cards = [],
  accounts = [],
  category,
  leftOut,
  request,
  onChanged,
  notify,
}: {
  /** The period's payments (and the category's, when one is focused). */
  txns: Transaction[]
  /** Every payment, whatever the period: a statement's rows are shown whole, even across the year's end. */
  everything?: Transaction[]
  cards?: Instrument[]
  accounts?: OwnAccount[]
  /** Card bills from CRED, to say which card a UPI payment to CRED paid. */
  payments: CardPayment[]
  tree: CategoryNode[]
  category: string | null
  /** Top-level categories the dashboard leaves out (investments, when switched off). */
  leftOut: string[]
  request?: ShowRequest | null
  onChanged: () => void
  notify: (text: string) => void
}) {
  const bills = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments])
  const detail = (t: Transaction) => {
    const bill = t.settles ? bills.get(t.settles) : undefined
    if (!bill) return t.payeeHandle ?? (t.note && t.note !== t.payee ? t.note : '') // a card's own wording, when it says more
    const rewards = bill.amount - t.amount // what CRED coins or cashback paid
    return `Bill for ${bill.cardTitle}, via CRED${rewards >= 0.01 ? ` · ${inrExact(rewards)} covered by CRED rewards` : ''}`
  }
  const [query, setQuery] = useState('')
  const [onlyReview, setOnlyReview] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const ignoredCount = useMemo(() => txns.filter(isIgnored).length, [txns])
  const [shown, setShown] = useState(PAGE)
  const [source, setSource] = useState<Source>('all')
  // one file's rows, or exactly the payments an answer is made of: all of them, whatever the period, category or source
  const [file, setFile] = useState<{ upload?: string; ids?: Set<string>; label: string } | null>(null)
  useEffect(() => {
    if (!request) return
    setQuery(request.text ?? '')
    setFile(request.upload || request.ids ? { upload: request.upload, ids: request.ids && new Set(request.ids), label: request.label ?? 'this file' } : null)
    setSource('all')
    setShown(PAGE)
  }, [request])
  const hasCards = useMemo(() => txns.some((t) => t.channel === 'card'), [txns])
  const [offer, setOffer] = useState<Offer | null>(null)
  // The payment an open offer is about stays on screen until the offer closes, even once it no longer fits
  // the filters (moved out of the focused category, or into one the dashboard leaves out).
  const [held, setHeld] = useState<Transaction | null>(null)
  useEffect(() => {
    if (!offer) setHeld(null)
  }, [offer])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    // one file's rows: all of them, whatever the period, category or source
    const base = file ? everything.filter((t) => (file.ids ? file.ids.has(t.id) : t.sources.some((s) => s.upload === file.upload))) : txns
    const out = base
      .filter((t) => file || !category || t.category === category || topOf(t.category) === category)
      .filter((t) => file || source === 'all' || (source === 'cards') === (t.channel === 'card'))
      .filter((t) => !onlyReview || t.needsReview)
      .filter((t) => showIgnored || category === 'ignored' || !isIgnored(t))
      .filter((t) => !q || t.payee.toLowerCase().includes(q) || (t.payeeHandle ?? '').toLowerCase().includes(q) || String(t.amount).includes(q))
    if (held && !out.some((t) => t.id === held.id)) out.push(txns.find((t) => t.id === held.id) ?? held)
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }, [txns, everything, file, source, category, onlyReview, showIgnored, query, held])

  const leavesView = (id: string) => leftOut.includes(topOf(id))

  // Ticking payments to change several at once ("these four are electricity"): only what's shown can be ticked, so
  // a change never reaches a payment you can't see; each takes the category as if set alone, and their payee learns
  // nothing (one payee can stand for several kinds of bill).
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [lastTicked, setLastTicked] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [bulk, setBulk] = useState<Bulk | null>(null)
  // Card bills among the ticked ones: asked about before they're changed, until the ticks or the category change.
  const [warnBills, setWarnBills] = useState(false)
  useEffect(() => setWarnBills(false), [ticked, target])
  const visible = useMemo(() => rows.slice(0, shown).map((t) => t.id), [rows, shown])
  useEffect(() => setTicked((s) => keepShown(s, visible)), [visible])
  const total = useMemo(() => tickedTotal(rows, ticked), [rows, ticked])
  const allTicked = visible.length > 0 && visible.every((id) => ticked.has(id))
  const headerBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = ticked.size > 0 && !allTicked
  }, [ticked, allTicked])

  const tickedBills = rows.filter((t) => ticked.has(t.id) && movesCardBill(t, target))

  /** `choice`, once asked about the card bills among them: change them too, or leave them as they are. */
  const applyTicked = async (choice?: 'all' | 'skipBills') => {
    if (!target || !ticked.size) return
    if (tickedBills.length && !choice) {
      setWarnBills(true)
      return
    }
    const skip = new Set(choice === 'skipBills' ? tickedBills.map((t) => t.id) : [])
    const ids = [...ticked].filter((id) => !skip.has(id))
    setWarnBills(false)
    if (!ids.length) return
    setBulk({ state: 'saving', text: 'Saving…' })
    try {
      const res = await api.categorizePayments(ids, target)
      const gone = leavesView(target) ? ', now left out of the dashboard' : ''
      setBulk({ state: 'done', text: `${plural(res.updated, 'payment')} → ${labelOf(tree, target)}${gone}`, before: res.before })
      setTicked(new Set())
      setLastTicked(null)
      setTarget('')
      onChanged()
    } catch (err) {
      setBulk({ state: 'done', text: `Couldn't change them: ${(err as Error).message}` })
    }
  }

  const undoTicked = async () => {
    if (!bulk?.before) return
    const before = bulk.before
    setBulk({ state: 'saving', text: 'Putting them back…' })
    try {
      await api.undoPayments(before)
      setBulk({ state: 'done', text: `${plural(before.length, 'payment')} back as they were` })
      onChanged()
    } catch (err) {
      setBulk({ state: 'done', text: `Couldn't undo it: ${(err as Error).message}` })
    }
  }

  // what happened stays long enough to undo it, then the bar closes
  useEffect(() => {
    if (bulk?.state !== 'done') return
    const timer = setTimeout(() => setBulk(null), bulk.before ? 10000 : 3000)
    return () => clearTimeout(timer)
  }, [bulk])

  // A payment to your card filed as something else would start counting: the row asks first (`guard`).
  const [guard, setGuard] = useState<{ txnId: string; category: string } | null>(null)
  const setOne = (t: Transaction, next: string) => {
    if (movesCardBill(t, next)) {
      setOffer(null)
      setHeld(null)
      setGuard({ txnId: t.id, category: next })
      return
    }
    setGuard(null)
    return fileOne(t, next)
  }

  const fileOne = async (t: Transaction, next: string) => {
    const res = await api.categorize({ transactionId: t.id, category: next })
    const names = (res.related ?? []).map((n) => ({ payee: n.payee, pending: n.count - n.already, ticked: true })).filter((n) => n.pending > 0)
    const account = res.account && typeof res.account === 'object' ? res.account.last4 : undefined
    const ask = !!account || names.length > 0
    setOffer(ask ? { txnId: t.id, payee: t.payee, category: next, names: account ? [] : names, account, state: 'ask' } : null)
    setHeld(ask ? { ...t, category: next } : null)
    if (leavesView(next) && !names.length) notify(`Moved to ${labelOf(tree, next)}. It's off the dashboard while investments are left out.`)
    onChanged()
  }

  const changeAll = async () => {
    if (!offer) return
    const picked = offer.names.filter((n) => n.ticked)
    setOffer({ ...offer, state: 'saving' })
    try {
      const res = await api.categorizeShop(picked.map((n) => n.payee), offer.category)
      const gone = leavesView(offer.category) ? ', now left out of the dashboard' : ''
      setOffer({ ...offer, state: 'done', done: `${plural(res.updated + 1, `${offer.payee} payment`)} → ${labelOf(tree, offer.category)}${gone}` })
      onChanged()
    } catch (err) {
      setOffer({ ...offer, state: 'done', done: `Couldn't change them: ${(err as Error).message}` })
    }
  }

  const claimAccount = async () => {
    if (!offer?.account) return
    setOffer({ ...offer, state: 'saving' })
    try {
      const res = await api.claimAccount({ transactionId: offer.txnId })
      const more = res.updated ? ` · ${plural(res.updated, 'other payment')} left out too` : ''
      setOffer({ ...offer, state: 'done', done: `••${offer.account} saved as one of your accounts${more}` })
      onChanged()
    } catch (err) {
      setOffer({ ...offer, state: 'done', done: `Couldn't save it: ${(err as Error).message}` })
    }
  }

  // the confirmation shows for a moment, then the row closes
  useEffect(() => {
    if (offer?.state !== 'done') return
    const timer = setTimeout(() => setOffer(null), 2600)
    return () => clearTimeout(timer)
  }, [offer])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex min-w-56 flex-1 items-center gap-2 rounded-full bg-white/[0.04] px-3 py-1.5 ring-1 ring-white/10 focus-within:ring-white/40">
          <Search className="size-4 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search payee, UPI id or amount"
            className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
          />
        </label>
        {file ? (
          <button
            type="button"
            onClick={() => setFile(null)}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] px-3 py-1.5 text-sm text-zinc-100 ring-1 ring-white/15"
          >
            From {file.label} <X className="size-3.5" />
          </button>
        ) : (
          hasCards && (
            <div role="radiogroup" aria-label="Paid how" className="flex rounded-full p-0.5 ring-1 ring-white/10">
              {(['all', 'upi', 'cards'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={source === s}
                  onClick={() => setSource(s)}
                  className={`rounded-full px-3 py-1 text-sm transition ${source === s ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'}`}
                >
                  {{ all: 'All', upi: 'UPI', cards: 'Cards' }[s]}
                </button>
              ))}
            </div>
          )
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} className="accent-white" />
          Needs review only
        </label>
        {ignoredCount > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-zinc-400" title="Payments you chose to leave out of every total">
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="accent-white" />
            Show {ignoredCount} ignored
          </label>
        )}
        <span className="text-sm text-zinc-500 tabular-nums">{rows.length} shown</span>
      </div>

      <AnimatePresence initial={false}>
        {(ticked.size > 0 || bulk) && (
          <motion.div
            key="ticked"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
            role="toolbar"
            aria-label="Change the ticked payments"
            className="sticky top-3 z-20 mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl bg-zinc-900/95 px-4 py-2.5 shadow-lg ring-1 ring-white/15 backdrop-blur"
          >
            {ticked.size > 0 && warnBills ? (
              <BillsWarning
                bills={tickedBills}
                count={total.count}
                category={target}
                label={labelOf(tree, target)}
                onBack={() => setWarnBills(false)}
                onSkip={() => applyTicked('skipBills')}
                onAll={() => applyTicked('all')}
              />
            ) : ticked.size > 0 ? (
              <>
                <p className="text-sm text-zinc-100 tabular-nums" aria-live="polite">
                  {plural(total.count, 'payment')} ticked <span className="text-zinc-500">· {inrExact(total.net)}</span>
                  {total.cardBills > 0 && (
                    <span className="text-zinc-500" title="Paying your card is neither money out nor money in">
                      {' '}
                      · {plural(total.cardBills, 'card bill')} not in that
                    </span>
                  )}
                </p>
                <div className="w-60">
                  <CategorySelect tree={tree} value={target} onChange={setTarget} placeholder="Choose their category" label="Category for the ticked payments" />
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setTicked(new Set())
                      setLastTicked(null)
                    }}
                    className="rounded-full px-3 py-1.5 text-[13px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    onClick={() => applyTicked()}
                    disabled={!target || bulk?.state === 'saving'}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {bulk?.state === 'saving' && <span className="size-3 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" />}
                    Change {total.count}
                  </button>
                </div>
              </>
            ) : (
              bulk && (
                <>
                  <p className="flex items-center gap-2 text-sm text-zinc-200" aria-live="polite">
                    {bulk.state === 'saving' ? (
                      <span className="size-3.5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                    ) : (
                      <Check className="size-4 text-emerald-400" strokeWidth={2.6} />
                    )}
                    {bulk.text}
                  </p>
                  {bulk.before && bulk.state === 'done' && (
                    <button
                      type="button"
                      onClick={undoTicked}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06]"
                    >
                      <Undo2 className="size-3.5" /> Undo
                    </button>
                  )}
                </>
              )
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="text-left text-xs text-zinc-500">
            <tr className="border-b border-white/[0.06]">
              <th className="w-7 py-2 pr-2 font-normal">
                <input
                  ref={headerBox}
                  type="checkbox"
                  checked={allTicked}
                  onChange={() => setTicked(allTicked ? new Set() : new Set(visible))}
                  disabled={!visible.length}
                  aria-label="Tick every payment shown"
                  title="Tick every payment shown, to change them together"
                  className="size-3.5 cursor-pointer accent-white"
                />
              </th>
              <th className="py-2 pr-4 font-normal">Date</th>
              <th className="py-2 pr-4 font-normal">Payee</th>
              <th className="py-2 pr-4 font-normal">Category</th>
              <th className="py-2 pr-4 font-normal">Paid from</th>
              <th className="py-2 text-right font-normal">Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((t) => (
              <Fragment key={t.id}>
              <tr
                className={`border-b border-white/[0.04] transition hover:bg-white/[0.02] ${ticked.has(t.id) ? '[&>td]:bg-white/[0.04]' : ''} ${isIgnored(t) || leavesView(t.category) ? 'opacity-50' : ''}`}
              >
                <td className="py-2 pr-2">
                  <input
                    type="checkbox"
                    checked={ticked.has(t.id)}
                    onChange={(e) => {
                      const shift = (e.nativeEvent as MouseEvent).shiftKey // shift-click ticks the run since the last one
                      setTicked((s) => tick(s, t.id, visible, lastTicked, shift))
                      setLastTicked(t.id)
                    }}
                    aria-label={`Tick the payment to ${t.payee === NO_NAME ? 'no payee name' : t.payee} on ${dayLabel(t.at)}, ${inrExact(t.amount)}`}
                    className="size-3.5 cursor-pointer accent-white"
                  />
                </td>
                <td className="py-2 pr-4 whitespace-nowrap text-zinc-400 tabular-nums">
                  {dayLabel(t.at)}
                  {/* card statements give the day only */}
                  {!('cardRow' in t.refs && t.at.slice(11, 16) === '00:00') && <span className="ml-1.5 text-xs text-zinc-600">{timeLabel(t.at)}</span>}
                </td>
                <td className="max-w-72 py-2 pr-4">
                  <div className="flex items-center gap-1.5">
                    {t.payee === NO_NAME ? (
                      <span className="truncate text-zinc-500 italic" title="The file this came from doesn't say who was paid">
                        No payee name
                      </span>
                    ) : (
                      <span className="truncate text-zinc-100" title={t.payee}>
                        {t.payee}
                      </span>
                    )}
                    {t.channel === 'card' && (
                      <span
                        title="From a credit card statement"
                        className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-[10px] font-medium tracking-wide text-zinc-400 uppercase"
                      >
                        Card
                      </span>
                    )}
                    {tag(t)}
                    {t.needsReview && <AlertCircle aria-label="Needs review" className="size-3.5 shrink-0 text-[var(--color-status-warning)]" />}
                    {t.categorizedBy === 'llm' && <Sparkles aria-label="Categorised by the local AI" className="size-3.5 shrink-0 text-zinc-500" />}
                  </div>
                  {detail(t) && <div className="truncate text-xs text-zinc-500">{detail(t)}</div>}
                </td>
                <td className="py-2 pr-4">
                  <div className="w-44">
                    <CategorySelect tree={tree} value={t.category} onChange={(c) => setOne(t, c)} compact />
                  </div>
                </td>
                <td className="py-2 pr-4 text-xs text-zinc-500">
                  <div className="max-w-40 truncate" title={paidFromLabel(t, cards, accounts).detail || undefined}>
                    {paidFromLabel(t, cards, accounts).title}
                  </div>
                </td>
                {/* a card bill is neither money in nor spending: no sign, no colour */}
                <td
                  className={`py-2 text-right whitespace-nowrap tabular-nums ${isCardBill(t) ? 'text-zinc-400' : t.direction === 'credit' ? 'text-emerald-300' : 'text-zinc-100'}`}
                  title={isCardBill(t) ? 'Paying your card: counted neither as spending nor as money in' : undefined}
                >
                  {t.direction === 'credit' && !isCardBill(t) ? '+' : ''}
                  {inrExact(t.amount)}
                </td>
              </tr>
              <AnimatePresence initial={false}>
                {guard?.txnId === t.id && (
                  <GuardRow
                    key="guard"
                    label={labelOf(tree, guard.category)}
                    countsAs={COUNTS_AS[countsAs(t, guard.category)]}
                    credit={t.direction === 'credit'}
                    onKeep={() => setGuard(null)}
                    onChange={() => {
                      setGuard(null)
                      void fileOne(t, guard.category)
                    }}
                  />
                )}
                {offer?.txnId === t.id && (
                  <OfferRow
                    key="offer"
                    offer={offer}
                    leaves={leavesView(offer.category)}
                    onChange={setOffer}
                    onChangeAll={changeAll}
                    onClaim={claimAccount}
                    onDismiss={() => setOffer(null)}
                  />
                )}
              </AnimatePresence>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-3 w-full rounded-xl py-2 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show more ({rows.length - shown} left)
        </button>
      )}
    </div>
  )
}

function OfferRow({
  offer,
  leaves,
  onChange,
  onChangeAll,
  onClaim,
  onDismiss,
}: {
  offer: Offer
  /** The new category is one the dashboard leaves out: these payments leave the view once you're done. */
  leaves: boolean
  onChange: (o: Offer) => void
  onChangeAll: () => void
  onClaim: () => void
  onDismiss: () => void
}) {
  const ticked = offer.names.filter((n) => n.ticked)
  const total = 1 + ticked.reduce((s, n) => s + n.pending, 0)
  const flip = (payee: string) => onChange({ ...offer, names: offer.names.map((n) => (n.payee === payee ? { ...n, ticked: !n.ticked } : n)) })

  return (
    <tr>
      <td colSpan={6} className="p-0">
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          <div className="my-2 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl bg-white/[0.035] px-3.5 py-2.5 ring-1 ring-white/[0.07]">
            {offer.state === 'done' ? (
              <p className="flex items-center gap-2 text-sm text-zinc-200">
                <Check className="size-4 text-emerald-400" strokeWidth={2.6} />
                {offer.done}
              </p>
            ) : offer.account ? (
              <>
                <p className="flex items-center gap-2 text-sm text-zinc-300">
                  <CornerDownRight className="size-4 shrink-0 text-zinc-500" />
                  Is ••{offer.account} your own account? Then every transfer to and from it is left out, however it's named.
                </p>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={onDismiss} disabled={offer.state === 'saving'} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                    Just this one
                  </button>
                  <button
                    type="button"
                    onClick={onClaim}
                    disabled={offer.state === 'saving'}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:opacity-50"
                  >
                    {offer.state === 'saving' && <span className="size-3 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" />}
                    Yes, it's mine
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-sm text-zinc-300">
                  <CornerDownRight className="size-4 shrink-0 text-zinc-500" />
                  {leaves ? 'Moved to investments, which are left out of the dashboard.' : 'Changed this payment.'} Also change the other {offer.payee} payments?
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  {offer.names.map((n) => (
                    <button
                      key={n.payee}
                      type="button"
                      role="checkbox"
                      aria-checked={n.ticked}
                      onClick={() => flip(n.payee)}
                      disabled={offer.state === 'saving'}
                      className={`inline-flex items-center gap-2 rounded-full py-1 pr-3 pl-1.5 text-[13px] ring-1 transition ${n.ticked ? 'bg-white/[0.06] text-zinc-100 ring-white/15' : 'text-zinc-400 ring-white/[0.08] hover:ring-white/20'}`}
                    >
                      <span className={`flex size-4 items-center justify-center rounded-[5px] transition-colors ${n.ticked ? 'bg-white text-zinc-950' : 'ring-1 ring-white/30 ring-inset'}`}>
                        {n.ticked && <Check className="size-3" strokeWidth={3.2} />}
                      </span>
                      {n.payee}
                      <span className="text-xs text-zinc-500 tabular-nums">· {plural(n.pending, n.payee === offer.payee ? 'more payment' : 'payment')}</span>
                    </button>
                  ))}
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={onDismiss} disabled={offer.state === 'saving'} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
                    Just this one
                  </button>
                  <button
                    type="button"
                    onClick={onChangeAll}
                    disabled={!ticked.length || offer.state === 'saving'}
                    className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {offer.state === 'saving' && <span className="size-3 animate-spin rounded-full border-2 border-zinc-950/25 border-t-zinc-950" />}
                    Change all {total}
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </td>
    </tr>
  )
}

/** A category's name as the dropdown shows it: a top-level category with sub-categories reads "Groceries (general)". */
/** A row's tag (rowTag): green where money comes in, neutral otherwise. */
function tag(t: Transaction) {
  const it = rowTag(t)
  if (!it) return null
  return (
    <span
      title={it.title}
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${
        it.inward ? 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-300/20' : 'bg-white/[0.06] text-zinc-400'
      }`}
    >
      {it.text}
    </span>
  )
}

/** Before a payment to your card is filed as something else: it would start counting. Yours to decide (the reader can
 *  take a payment for one, and a payment through a bill app can be rent), but never by a slip of the menu. */
function GuardRow({ label, countsAs, credit, onKeep, onChange }: { label: string; countsAs: string; credit: boolean; onKeep: () => void; onChange: () => void }) {
  return (
    <tr>
      <td colSpan={6} className="p-0">
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden"
        >
          <div role="alertdialog" aria-label="Change a card bill payment?" className="my-2 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl bg-amber-200/[0.05] px-3.5 py-2.5 ring-1 ring-amber-200/20">
            <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-zinc-300">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-200" />
              <span>
                This is a payment {credit ? 'to your credit card' : 'of a credit card bill'}, so it counts as neither spending nor money in.
                Under {label} it would count as {countsAs}. Change it only if it isn't really a card bill payment.
              </span>
            </p>
            <div className="ml-auto flex items-center gap-2">
              <button type="button" onClick={onKeep} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100">
                Keep it as a card bill
              </button>
              <button type="button" onClick={onChange} className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200">
                Change it anyway
              </button>
            </div>
          </div>
        </motion.div>
      </td>
    </tr>
  )
}

/** In the ticked-payments bar: some of the ticked ones are payments to your card, which the change would start counting. */
function BillsWarning({ bills, count, category, label, onBack, onSkip, onAll }: {
  bills: Transaction[]
  count: number
  category: string
  label: string
  onBack: () => void
  onSkip: () => void
  onAll: () => void
}) {
  const k = bills.length
  const as = [...new Set(bills.map((t) => COUNTS_AS[countsAs(t, category)]))].join(' or ')
  return (
    <>
      <p role="alert" className="flex min-w-0 flex-1 items-start gap-2 text-sm text-zinc-200">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-200" />
        <span>
          {k === 1 ? 'One of these is a credit card bill payment' : `${k} of these are credit card bill payments`}, counted as neither spending nor money in.
          Under {label} {k === 1 ? 'it' : 'they'} would count as {as}.
        </span>
      </p>
      <div className="ml-auto flex items-center gap-2">
        <button type="button" onClick={onBack} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100">
          Back
        </button>
        {k < count && (
          <button type="button" onClick={onSkip} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-200 ring-1 ring-white/15 transition hover:bg-white/[0.06]">
            Leave {k === 1 ? 'it' : 'them'} out, change {count - k}
          </button>
        )}
        <button type="button" onClick={onAll} className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200">
          Change all {count}
        </button>
      </div>
    </>
  )
}

function labelOf(tree: CategoryNode[], id: string): string {
  for (const top of tree) {
    if (top.id === id) return top.children?.length ? `${top.label} (general)` : top.label
    const child = top.children?.find((c) => c.id === id)
    if (child) return child.label
  }
  return id
}
