import { AnimatePresence, motion } from 'motion/react'
import { AlertCircle, Check, ChevronDown, CornerDownRight, MapPin, Search, Sparkles, Undo2, X } from 'lucide-react'
import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../../api'
import { cardName } from '../../lib/cards'
import { categoriesMatching, categoriesNamed } from '../../lib/categoryWords'
import { NO_NAME, accountLine, billNote, billSides, cardSide, countsAs, flatten, howPaid, isCardBill, isIgnored, moneyFrom, moneyIn, oneRowPerPayment, paidFromLabel, rowTag, topOf, type Bucket } from '../../lib/ledger'
import { plural } from '../../lib/format'
import { inrExact } from '../../lib/money'
import { dayLabel, dayMonthLabel, timeLabel } from '../../lib/periods'
import { placeLabel, placeTitle, samePlace } from '../../lib/places'
import { keepShown, tick, tickedTotal } from '../../lib/selection'
import { useFits } from '../../lib/useFits'
import type { CardPayment, CategoryNode, Instrument, OwnAccount, PaymentState, Stay, Transaction } from '../../types'
import { CategorySelect } from './CategorySelect'

const PAGE = 60
/** The table's width with every column readable; in a narrower box (a phone, a tablet) each payment is a list item. */
const TABLE_MIN = 760
/** The Location column, once you've told Plutus where you were: the table needs this much more before it fits. */
const PLACE_COL = 128
/** How many columns the table has, for a row that spans them all (an offer, a warning). */
const Columns = createContext(6)

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
  placeOf = new Map(),
  placeNames = [],
  onChanged,
  notify,
}: {
  /** The period's payments (and the category's, when one is focused). */
  txns: Transaction[]
  /** Every payment, whatever the period: a statement's rows are shown whole, even across the year's end. */
  everything?: Transaction[]
  cards?: Instrument[]
  accounts?: OwnAccount[]
  /** Card bills (from CRED, or a statement's own payment row), to say what each side of a bill payment is. */
  payments: CardPayment[]
  tree: CategoryNode[]
  category: string | null
  /** Top-level categories the dashboard leaves out (investments, when switched off). */
  leftOut: string[]
  request?: ShowRequest | null
  /** Where you were when each payment was made, as you told Plutus (lib/places.ts `staysOf`), by payment id. */
  placeOf?: Map<string, Stay>
  /** Every place you told, as shown ("Darjeeling, WB"): with any, the list has a Location column and a Place filter. */
  placeNames?: string[]
  onChanged: () => void
  notify: (text: string) => void
}) {
  const bills = useMemo(() => new Map(payments.map((p) => [p.id, p])), [payments])
  // one payment, one row: the sides of a card bill payment (the UPI payment, the statement's "PAYMENT RECEIVED") are
  // shown once, and changed together
  const sides = useMemo(() => billSides(everything), [everything])
  const sidesOf = (t: Transaction) => (t.settles && sides.get(t.settles)) || [t]
  const names = {
    card: (id: string) => {
      const c = cards.find((c) => c.id === id)
      return c ? cardName(c) : (bills.get(id)?.cardTitle ?? 'your card')
    },
    paidFrom: (t: Transaction) => paidFromLabel(t, cards, accounts).title,
  }
  const detail = (t: Transaction) =>
    billNote(t, t.settles ? bills.get(t.settles) : undefined, sides, names) ??
    (t.payeeHandle ?? (t.note && t.note !== t.payee ? t.note : '')) // a card's own wording, when it says more
  const [query, setQuery] = useState('')
  // the search finds payments by category too (lib/categoryWords.ts): those in every category its words name ("food" is
  // all of Food & Dining); each named one with payments here is a chip, which narrows this list to it (`only`)
  const categories = useMemo(() => flatten(tree), [tree])
  const named = useMemo(() => categoriesNamed(query, categories), [query, categories])
  const inNamed = useMemo(() => categoriesMatching(query, categories), [query, categories])
  const [only, setOnly] = useState<string | null>(null)
  const [onlyReview, setOnlyReview] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const ignoredCount = useMemo(() => txns.filter(isIgnored).length, [txns])
  const [shown, setShown] = useState(PAGE)
  const [source, setSource] = useState<Source>('all')
  const [place, setPlace] = useState('') // '': every place, and none
  const places = placeNames.length > 0
  // a payment's place, shown "Darjeeling, WB"; searched by that and by its state's name too
  const placeName = (t: Transaction) => { const s = placeOf.get(t.id); return s && placeLabel(s) }
  const placeWords = (t: Transaction) => { const s = placeOf.get(t.id); return s ? `${placeLabel(s)} ${placeTitle(s)}`.toLowerCase() : '' }
  // one file's rows, or exactly the payments an answer is made of: all of them, whatever the period, category or source
  const [file, setFile] = useState<{ upload?: string; ids?: Set<string>; label: string } | null>(null)
  useEffect(() => {
    if (!request) return
    setQuery(request.text ?? '')
    setFile(request.upload || request.ids ? { upload: request.upload, ids: request.ids && new Set(request.ids), label: request.label ?? 'this file' } : null)
    setSource('all')
    setPlace('')
    setOnly(null)
    setShown(PAGE)
  }, [request])
  useEffect(() => {
    if (place && !placeNames.some((p) => samePlace(p, place))) setPlace('') // a place you just removed
  }, [place, placeNames])
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
      .filter((t) => file || !only || t.category === only || topOf(t.category) === only)
      .filter((t) => file || source === 'all' || (source === 'cards') === (t.channel === 'card'))
      .filter((t) => file || !place || samePlace(placeName(t) ?? '', place))
      .filter((t) => !onlyReview || t.needsReview)
      // ignored payments show when you ask for them: the box ticked, the category focused or picked, or searched by name
      .filter((t) => showIgnored || category === 'ignored' || only === 'ignored' || (!!q && inNamed.has('ignored')) || !isIgnored(t))
      .filter((t) => !q || t.payee.toLowerCase().includes(q) || (t.payeeHandle ?? '').toLowerCase().includes(q) || String(t.amount).includes(q) || placeWords(t).includes(q) || inNamed.has(t.category))
    if (held && !out.some((t) => t.id === held.id)) out.push(txns.find((t) => t.id === held.id) ?? held)
    // a file's own rows, or an answer's exact payments, are shown as they are; otherwise each payment once
    return (file ? out : oneRowPerPayment(out, sides)).sort((a, b) => b.at.localeCompare(a.at))
  }, [txns, everything, file, source, place, placeOf, category, only, onlyReview, showIgnored, query, inNamed, held, sides])
  // the categories the search names, with how many of the rows shown are in each (none: no chip); and whether it names
  // one the dashboard leaves out (investments, switched off), which this list can't show
  const chips = useMemo(
    () => named.map((id) => [id, rows.filter((t) => t.category === id || topOf(t.category) === id).length] as const).filter(([, n]) => n > 0),
    [named, rows],
  )
  const namesLeftOut = !file && [...inNamed].some((id) => leftOut.includes(topOf(id)))
  const nameOf = (id: string) => categories.get(id)?.label ?? id
  const pathOf = (id: string) => {
    const c = categories.get(id)
    return c?.parent ? `${nameOf(c.parent)} › ${c.label}` : nameOf(id)
  }

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
  const [box, wide] = useFits<HTMLDivElement>(TABLE_MIN + (places ? PLACE_COL : 0))
  const headerBox = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (headerBox.current) headerBox.current.indeterminate = ticked.size > 0 && !allTicked
  }, [ticked, allTicked, wide])

  const tickedBills = rows.filter((t) => ticked.has(t.id) && movesCardBill(t, target))

  /** `choice`, once asked about the card bills among them: change them too, or leave them as they are. */
  const applyTicked = async (choice?: 'all' | 'skipBills') => {
    if (!target || !ticked.size) return
    if (tickedBills.length && !choice) {
      setWarnBills(true)
      return
    }
    const skip = new Set(choice === 'skipBills' ? tickedBills.map((t) => t.id) : [])
    const picked = rows.filter((t) => ticked.has(t.id) && !skip.has(t.id))
    setWarnBills(false)
    if (!picked.length) return
    setBulk({ state: 'saving', text: 'Saving…' })
    try {
      // a bill payment's every side goes with it (one payment, one row)
      const ids = [...new Set(picked.flatMap((t) => sidesOf(t).map((s) => s.id)))]
      const res = await api.categorizePayments(ids, target)
      const gone = leavesView(target) ? ', now left out of the dashboard' : ''
      setBulk({ state: 'done', text: `${plural(picked.length, 'payment')} → ${labelOf(tree, target)}${gone}`, before: res.before })
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
    if (sidesOf(t).length > 1) {
      // one payment seen from both sides (your account's, the card's): both take the category
      await api.categorizePayments(sidesOf(t).map((s) => s.id), next)
      setOffer(null)
      onChanged()
      return
    }
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

  // A payment's parts, the same in the table (a wide box) and the list (a narrow one)
  const tickBox = (t: Transaction) => (
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
  )
  const tickAll = (
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
  )
  // the list leaves the year off when every payment shown is in the same one (a year's view, as it opens)
  const oneYear = useMemo(() => new Set(rows.map((t) => t.at.slice(0, 4))).size <= 1, [rows])
  // card statements give the day only
  const time = (t: Transaction) => ('cardRow' in t.refs && t.at.slice(11, 16) === '00:00' ? null : timeLabel(t.at))
  const payeeName = (t: Transaction) =>
    t.payee === NO_NAME ? (
      <span className="truncate text-muted italic" title={`The file this came from doesn't say who ${t.direction === 'credit' ? 'sent it' : 'was paid'}`}>
        No payee name
      </span>
    ) : (
      <span className="truncate text-zinc-100" title={t.payee}>
        {t.payee}
      </span>
    )
  const marks = (t: Transaction) => (
    <>
      {statementChip(cardSide(t, sides), names.card)}
      {t.needsReview && <AlertCircle aria-label="Needs review" className="size-3.5 shrink-0 text-[var(--color-status-warning)]" />}
      {t.categorizedBy === 'llm' && <Sparkles aria-label="Categorised by the local AI" className="size-3.5 shrink-0 text-muted" />}
    </>
  )
  // money in reads as a bank's statement says it: its tag on top, then "from" whom (a cashback, its own wording), the way
  // "Paid with" has its chips on top and the account it was credited to under them (lib/ledger.ts `moneyIn`,
  // `moneyFrom`); the card's own wording beside the name, in the room the name leaves (cut before the name ever is, and
  // never widening the table), so money in is two lines like any row. A payment out, its payee and any tag beside it
  const payee = (t: Transaction) =>
    moneyIn(t) ? (
      <div className="min-w-0">
        <div className="flex h-4 items-center gap-1.5">
          {tag(t)}
          {marks(t)}
        </div>
        <div className="flex min-w-0 items-baseline gap-1">
          {t.payee !== NO_NAME && moneyFrom(t) && <span className="shrink-0 text-muted">from</span>}
          {payeeName(t)}
          {detail(t) && (
            <span className="ml-1 w-0 min-w-0 flex-1 truncate text-xs text-muted" title={detail(t) || undefined}>
              {detail(t)}
            </span>
          )}
        </div>
      </div>
    ) : (
      <div className="flex min-w-0 items-center gap-1.5">
        {payeeName(t)}
        {tag(t)}
        {marks(t)}
      </div>
    )
  // the card's own wording under a payment out's payee (money in has it beside the name)
  const subline = (t: Transaction) => !moneyIn(t) && detail(t) && <div className="truncate text-xs text-muted" title={detail(t) || undefined}>{detail(t)}</div>
  const categoryOf = (t: Transaction) => <CategorySelect tree={tree} value={t.category} onChange={(c) => setOne(t, c)} compact />
  // a card bill is neither money in nor spending: no sign, no colour
  const amount = (t: Transaction) => ({
    className: `whitespace-nowrap tabular-nums ${isCardBill(t) ? 'text-zinc-400' : t.direction === 'credit' ? 'text-emerald-300' : 'text-zinc-100'}`,
    title: isCardBill(t) ? 'Paying your card: counted neither as spending nor as money in' : undefined,
    text: `${t.direction === 'credit' && !isCardBill(t) ? '+' : ''}${inrExact(t.amount)}`,
  })
  const dimmed = (t: Transaction) => isIgnored(t) || leavesView(t.category)
  // what a payment opens under itself: the card bill guard, or the offer to change the same shop's other payments
  const unfolded = (t: Transaction, inTable: boolean) => (
    <AnimatePresence initial={false}>
      {guard?.txnId === t.id && (
        <GuardRow
          key="guard"
          inTable={inTable}
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
          inTable={inTable}
          offer={offer}
          leaves={leavesView(offer.category)}
          onChange={setOffer}
          onChangeAll={changeAll}
          onClaim={claimAccount}
          onDismiss={() => setOffer(null)}
        />
      )}
    </AnimatePresence>
  )

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="tap flex min-w-56 flex-1 items-center gap-2 rounded-full bg-white/[0.04] px-3 ring-1 ring-white/10 focus-within:ring-white/40">
          <Search className="size-4 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search payee, category, UPI id or amount"
            aria-label="Search payee, category, UPI id or amount"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-zinc-100 outline-none placeholder:text-muted"
          />
        </label>
        {only && !file && (
          <button
            type="button"
            onClick={() => setOnly(null)}
            title={`Showing only ${pathOf(only)}: show every category again`}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.08] px-3 py-1.5 text-sm text-zinc-100 ring-1 ring-white/15"
          >
            Only {nameOf(only)} <X className="size-3.5" />
          </button>
        )}
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
                  className={`tap rounded-full px-3 py-1 text-sm transition ${source === s ? 'bg-white text-zinc-950' : 'text-zinc-400 hover:text-zinc-100'}`}
                >
                  {{ all: 'All', upi: 'UPI', cards: 'Cards' }[s]}
                </button>
              ))}
            </div>
          )
        )}
        {places && !file && (
          <label className="tap relative flex items-center rounded-full ring-1 ring-white/10 focus-within:ring-white/40">
            <MapPin className="pointer-events-none absolute left-3 size-3.5 text-muted" aria-hidden />
            <select
              value={place}
              onChange={(e) => setPlace(e.target.value)}
              aria-label="Place"
              className="cursor-pointer appearance-none bg-transparent py-1 pr-8 pl-8 text-sm text-zinc-200 outline-none"
            >
              <option value="" className="bg-zinc-900">All places</option>
              {placeNames.map((p) => (
                <option key={p} value={p} className="bg-zinc-900">{p}</option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 size-3.5 text-muted" aria-hidden />
          </label>
        )}
        <label className="tap flex min-h-6 cursor-pointer items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={onlyReview} onChange={(e) => setOnlyReview(e.target.checked)} className="accent-white" />
          Needs review only
        </label>
        {ignoredCount > 0 && (
          <label className="tap flex min-h-6 cursor-pointer items-center gap-2 text-sm text-zinc-400" title="Payments you chose to leave out of every total">
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} className="accent-white" />
            Show {ignoredCount} ignored
          </label>
        )}
        <span className="text-sm text-muted tabular-nums">{rows.length} shown</span>
      </div>
      {(chips.length > 0 || namesLeftOut) && (
        <div className="-mt-1 mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Categories your search names">
          {chips.length > 0 && <span className="mr-0.5 text-xs text-zinc-400">Categories</span>}
          {chips.map(([id, n]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setOnly(id)
                setQuery('')
              }}
              title={`Show only ${pathOf(id)}`}
              className="inline-flex min-h-6 items-center gap-1.5 rounded-full bg-white/[0.04] py-1 pr-2.5 pl-3 text-xs text-zinc-200 ring-1 ring-white/10 transition hover:bg-white/[0.08] hover:text-zinc-50"
            >
              {nameOf(id)} <span className="text-zinc-400 tabular-nums">{n}</span>
            </button>
          ))}
          {namesLeftOut && <span className="text-xs text-zinc-400">Investments are left out: switch on Count investments, at the top, to see them here.</span>}
        </div>
      )}

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
                  {plural(total.count, 'payment')} ticked <span className="text-muted">· {inrExact(total.net)}</span>
                  {total.cardBills > 0 && (
                    <span className="text-muted" title="Paying your card is neither money out nor money in">
                      {' '}
                      · {plural(total.cardBills, 'card bill')} not in that
                    </span>
                  )}
                </p>
                <div className="w-60">
                  <CategorySelect tree={tree} value={target} onChange={setTarget} placeholder="Choose their category" label="Category for the ticked payments" />
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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

      <Columns.Provider value={places ? 7 : 6}>
      <div ref={box} className={wide ? 'overflow-x-auto' : undefined}>
        {wide ? (
          <table className="w-full text-sm" style={{ minWidth: TABLE_MIN + (places ? PLACE_COL : 0) }}>
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-white/[0.06]">
                <th className="w-7 py-2 pr-2 font-normal">
                  <label className="-m-1.5 flex w-fit cursor-pointer p-1.5">{tickAll}</label>
                </th>
                <th className="py-2 pr-4 font-normal">Date</th>
                <th className="py-2 pr-4 font-normal">Payee</th>
                {places && <th className="py-2 pr-4 font-normal">Location</th>}
                <th className="py-2 pr-4 font-normal">Paid with</th>
                <th className="py-2 pr-4 font-normal">Category</th>
                <th className="py-2 text-right font-normal">Amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((t) => {
                const money = amount(t)
                return (
                  <Fragment key={t.id}>
                    <tr
                      className={`border-b border-white/[0.04] transition hover:bg-white/[0.02] ${ticked.has(t.id) ? '[&>td]:bg-white/[0.04]' : ''} ${dimmed(t) ? 'opacity-50' : ''}`}
                    >
                      <td className="py-2 pr-2">
                        <label className="-m-1.5 flex w-fit cursor-pointer p-1.5">{tickBox(t)}</label>
                      </td>
                      <td className="py-2 pr-4 whitespace-nowrap text-zinc-400 tabular-nums">
                        {dayLabel(t.at)}
                        {time(t) && <span className="ml-1.5 text-xs text-muted">{time(t)}</span>}
                      </td>
                      {/* two lines tall whatever it holds, so every row is the same height */}
                      <td className="max-w-[28rem] py-2 pr-4">
                        <div className="min-h-9">
                          {payee(t)}
                          {subline(t)}
                        </div>
                      </td>
                      {places && (
                        <td className="max-w-[10rem] py-2 pr-4">
                          {placeName(t) && (
                            <span className="flex min-w-0 items-center gap-1.5 text-zinc-300" title={`You told Plutus you were in ${placeTitle(placeOf.get(t.id)!)} that day`}>
                              <MapPin className="size-3.5 shrink-0 text-muted" aria-hidden />
                              <span className="truncate">{placeName(t)}</span>
                            </span>
                          )}
                        </td>
                      )}
                      <td className="py-2 pr-4">{paidWith(t, accountLine(t, cards, accounts))}</td>
                      <td className="py-2 pr-4">
                        <div className="w-44">{categoryOf(t)}</div>
                      </td>
                      <td className={`py-2 text-right ${money.className}`} title={money.title}>
                        {money.text}
                      </td>
                    </tr>
                    {unfolded(t, true)}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        ) : (
          // a narrow box: each payment an item, payee and amount on top, how it was paid, then when and its category
          <>
            <label className="tap flex w-fit cursor-pointer items-center gap-2.5 py-1.5 text-xs text-muted">
              {tickAll}
              Tick all shown
            </label>
            <ul className="border-t border-white/[0.06]">
              {rows.slice(0, shown).map((t) => {
                const money = amount(t)
                return (
                  <li key={t.id} className={`border-b border-white/[0.04] py-3 text-sm ${ticked.has(t.id) ? 'bg-white/[0.04]' : ''}`}>
                    <div className={`flex gap-2.5 ${dimmed(t) ? 'opacity-50' : ''}`}>
                      {/* the box keeps its look; the space around it takes the tap */}
                      <label className="tap -m-1.5 flex shrink-0 cursor-pointer self-start p-1.5 pt-[0.4375rem]">{tickBox(t)}</label>
                      <div className="min-w-0 flex-1">
                        {/* money in: the amount level with its tag, a line as tall as the tag's, so the item is no taller */}
                        <div className={`flex gap-3 ${moneyIn(t) ? 'items-start' : 'items-baseline'}`}>
                          <div className="min-w-0 flex-1">{payee(t)}</div>
                          <div className={`shrink-0 ${moneyIn(t) ? 'leading-4' : ''} ${money.className}`} title={money.title}>
                            {money.text}
                          </div>
                        </div>
                        {subline(t)}
                        <div className="mt-1.5">{paidWith(t, accountLine(t, cards, accounts), true)}</div>
                        {/* nothing cut: on a very narrow screen the category moves under the day */}
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            <span className="whitespace-nowrap tabular-nums">
                              {oneYear ? dayMonthLabel(t.at) : dayLabel(t.at)}
                              {time(t) && ` · ${time(t)}`}
                            </span>
                            {placeName(t) && (
                              <span className="flex min-w-0 items-center gap-1" title={`You told Plutus you were in ${placeTitle(placeOf.get(t.id)!)} that day`}>
                                <MapPin className="size-3 shrink-0" aria-hidden />
                                <span className="truncate text-zinc-300">{placeName(t)}</span>
                              </span>
                            )}
                          </span>
                          <div className="ml-auto w-40">{categoryOf(t)}</div>
                        </div>
                      </div>
                    </div>
                    {unfolded(t, false)}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
      </Columns.Provider>
      {rows.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="tap mt-3 w-full rounded-xl py-2 text-sm text-zinc-400 transition hover:bg-white/[0.04] hover:text-zinc-200"
        >
          Show more ({rows.length - shown} left)
        </button>
      )}
    </div>
  )
}

/** What a payment opens under itself (an offer, a warning): it unfolds, and folds away. In the table it's a row of its
 *  own across every column; in the list, part of the payment's item. */
function Unfold({ inTable, children }: { inTable: boolean; children: ReactNode }) {
  const columns = useContext(Columns)
  const body = (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="overflow-hidden"
    >
      {children}
    </motion.div>
  )
  return inTable ? (
    <tr>
      <td colSpan={columns} className="p-0">
        {body}
      </td>
    </tr>
  ) : (
    body
  )
}

function OfferRow({
  inTable,
  offer,
  leaves,
  onChange,
  onChangeAll,
  onClaim,
  onDismiss,
}: {
  inTable: boolean
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
    <Unfold inTable={inTable}>
      <div className="my-2 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl bg-white/[0.035] px-3.5 py-2.5 ring-1 ring-white/[0.07]">
        {offer.state === 'done' ? (
          <p className="flex items-center gap-2 text-sm text-zinc-200">
            <Check className="size-4 text-emerald-400" strokeWidth={2.6} />
            {offer.done}
          </p>
        ) : offer.account ? (
          <>
            <p className="flex items-center gap-2 text-sm text-zinc-300">
              <CornerDownRight className="size-4 shrink-0 text-muted" />
              Is ••{offer.account} your own account? Then every transfer to and from it is left out, however it's named.
            </p>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
              <CornerDownRight className="size-4 shrink-0 text-muted" />
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
                  <span className="text-xs text-muted tabular-nums">· {plural(n.pending, n.payee === offer.payee ? 'more payment' : 'payment')}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
    </Unfold>
  )
}

/** A category's name as the dropdown shows it: a top-level category with sub-categories reads "Groceries (general)". */
/** A row's tag (rowTag): green where money comes in, neutral otherwise. */
/** "Paid with": how the payment was made, a chip each (a card in blue, UPI and its apps in violet; their tooltip says it
 *  in words), and under them the account or card on your side (lib/ledger.ts `accountLine`): the one it was paid from,
 *  or, for money in, "Credited to" the one it went to (the whole of a long name, and what it is, on hover). Nothing
 *  under them when the file doesn't say. `inline` (the narrow list): the account or card beside the chips, on one line. */
function paidWith(t: Transaction, side: { text: string; title: string } | null, inline = false) {
  const how = howPaid(t)
  return (
    <div className={inline ? 'flex min-w-0 items-center gap-2' : 'max-w-60'}>
      {how && (
        <div data-how={how.parts.join('|')} title={how.title} className={`flex gap-1 ${inline ? 'shrink-0' : 'flex-wrap'}`}>
          {how.parts.map((part) => (
            <span
              key={part}
              className={`shrink-0 rounded px-1.5 py-px text-[10px] leading-3.5 font-medium tracking-wide whitespace-nowrap uppercase ${part === 'Card' ? 'chip-card' : 'chip-upi'}`}
            >
              {part}
            </span>
          ))}
        </div>
      )}
      {side && (
        <div className={`${inline ? 'min-w-0' : 'mt-1'} truncate text-xs text-muted`} title={side.title}>
          {side.text}
        </div>
      )}
    </div>
  )
}

/** "+ Statement" on the row of a bill payment whose card's side (the statement's "PAYMENT RECEIVED") is folded into it:
 *  one payment, shown once. */
function statementChip(onCard: Transaction | undefined, card: (id: string) => string) {
  if (!onCard) return null
  return (
    <span
      title={`Also on your ${card(onCard.card ?? '')} statement, ${dayLabel(onCard.at)}: the same payment, shown once`}
      className="shrink-0 rounded bg-white/[0.06] px-1.5 py-px text-[10px] leading-3.5 font-medium tracking-wide whitespace-nowrap text-zinc-400 uppercase"
    >
      + Statement
    </span>
  )
}

function tag(t: Transaction) {
  const it = rowTag(t)
  if (!it) return null
  return (
    <span
      title={it.title}
      className={`shrink-0 rounded px-1.5 py-px text-[10px] leading-3.5 font-medium tracking-wide uppercase ${
        it.inward ? 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-300/20' : 'bg-white/[0.06] text-zinc-400'
      }`}
    >
      {it.text}
    </span>
  )
}

/** Before a payment to your card is filed as something else: it would start counting. Yours to decide (the reader can
 *  take a payment for one, and a payment through a bill app can be rent), but never by a slip of the menu. */
function GuardRow({ inTable, label, countsAs, credit, onKeep, onChange }: { inTable: boolean; label: string; countsAs: string; credit: boolean; onKeep: () => void; onChange: () => void }) {
  return (
    <Unfold inTable={inTable}>
      <div role="alertdialog" aria-label="Change a card bill payment?" className="my-2 flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-xl bg-amber-200/[0.05] px-3.5 py-2.5 ring-1 ring-amber-200/20">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-zinc-300">
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-200" />
          <span>
            This is a payment {credit ? 'to your credit card' : 'of a credit card bill'}, so it counts as neither spending nor money in.
            Under {label} it would count as {countsAs}. Change it only if it isn't really a card bill payment.
          </span>
        </p>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <button type="button" onClick={onKeep} className="rounded-full px-3 py-1.5 text-[13px] text-zinc-300 transition hover:bg-white/[0.06] hover:text-zinc-100">
            Keep it as a card bill
          </button>
          <button type="button" onClick={onChange} className="rounded-full bg-white px-3.5 py-1.5 text-[13px] font-semibold text-zinc-950 transition hover:bg-zinc-200">
            Change it anyway
          </button>
        </div>
      </div>
    </Unfold>
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
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
