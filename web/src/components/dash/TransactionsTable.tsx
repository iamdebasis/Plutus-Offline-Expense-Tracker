import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Check, CornerDownRight, Search, Sparkles, X } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { NO_NAME, isIgnored, paidFromLabel, topOf } from '../../lib/ledger'
import { plural } from '../../lib/format'
import { inrExact } from '../../lib/money'
import { dayLabel, timeLabel } from '../../lib/periods'
import type { CardPayment, CategoryNode, Instrument, OwnAccount, Transaction } from '../../types'
import { CategorySelect } from './CategorySelect'

const PAGE = 60

/** A request from elsewhere on the page to show some payments: a search ("Show them": no payee name), or one
 *  file's rows ("Show these rows": a card statement in the vault). `at` makes each request new. */
export type ShowRequest = { text?: string; upload?: string; label?: string; at: number }
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
  const [file, setFile] = useState<{ upload: string; label: string } | null>(null)
  useEffect(() => {
    if (!request) return
    setQuery(request.text ?? '')
    setFile(request.upload ? { upload: request.upload, label: request.label ?? 'this file' } : null)
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
    const base = file ? everything.filter((t) => t.sources.some((s) => s.upload === file.upload)) : txns
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

  const setOne = async (t: Transaction, next: string) => {
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-zinc-500">
            <tr className="border-b border-white/[0.06]">
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
              <tr className={`border-b border-white/[0.04] transition hover:bg-white/[0.02] ${isIgnored(t) || leavesView(t.category) ? 'opacity-50' : ''}`}>
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
                    {t.kind === 'refund' && (
                      <span
                        title={t.refundOf ? 'Taken off the payment it refunds' : "Its payment isn't in your files, so it counts as money in"}
                        className="shrink-0 rounded bg-emerald-400/10 px-1.5 py-px text-[10px] font-medium tracking-wide text-emerald-300 uppercase"
                      >
                        Refund
                      </span>
                    )}
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
                <td className="max-w-40 truncate py-2 pr-4 text-xs text-zinc-500" title={paidFromLabel(t, cards, accounts).detail || undefined}>
                  {paidFromLabel(t, cards, accounts).title}
                </td>
                <td className={`py-2 text-right whitespace-nowrap tabular-nums ${t.direction === 'credit' ? 'text-emerald-300' : 'text-zinc-100'}`}>
                  {t.direction === 'credit' ? '+' : ''}
                  {inrExact(t.amount)}
                </td>
              </tr>
              <AnimatePresence initial={false}>
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
      <td colSpan={5} className="p-0">
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
function labelOf(tree: CategoryNode[], id: string): string {
  for (const top of tree) {
    if (top.id === id) return top.children?.length ? `${top.label} (general)` : top.label
    const child = top.children?.find((c) => c.id === id)
    if (child) return child.label
  }
  return id
}
