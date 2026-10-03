import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { CardPayment, CardStatement, CategoryNode, Instrument, OwnAccount, Preferences, Transaction, UploadRecord } from '../types'
import { inPeriod, monthKey, monthsOf, yearOf, type PeriodKey } from './periods'

export interface Category {
  id: string
  label: string
  parent: string | null
  excludeFromSpend: boolean
}

export interface LedgerData {
  txns: Transaction[]
  payments: CardPayment[]
  categories: Map<string, Category>
  tree: CategoryNode[]
  cards: Instrument[]
  uploads: UploadRecord[]
  /** Your own bank accounts, marked by you (data/accounts.json). */
  accounts: OwnAccount[]
  /** Your choices about what the numbers include (data/settings.json). */
  preferences: Preferences
  /** The credit card statements you added: periods, the bank's figures, whether the rows add up. */
  statements: CardStatement[]
  /** Payments the dashboard leaves out (investments, when you choose so; see lib/scope.ts). Out of every view,
   *  kept only so card bills still know what they paid for. */
  leftOut: Transaction[]
}

export function useLedger() {
  const [data, setData] = useState<LedgerData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [txns, payments, tree, cards, uploads, accounts, preferences, statements] = await Promise.all([
        api.transactions(), api.cardPayments(), api.categories(), api.instruments(), api.uploads(), api.accounts(), api.preferences(),
        api.cardStatements(),
      ])
      setData({ txns, payments, categories: flatten(tree), tree, cards, uploads, accounts, preferences, statements, leftOut: [] })
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return { data, error, refresh }
}

function flatten(tree: CategoryNode[]): Map<string, Category> {
  const out = new Map<string, Category>()
  for (const top of tree) {
    out.set(top.id, { id: top.id, label: top.label, parent: null, excludeFromSpend: !!top.excludeFromSpend })
    for (const c of top.children ?? []) {
      out.set(c.id, { id: c.id, label: c.label, parent: top.id, excludeFromSpend: !!(c.excludeFromSpend ?? top.excludeFromSpend) })
    }
  }
  return out
}

export const topOf = (id: string) => id.split('.')[0]

/** What counts where. "Spent" is money that bought something; people, card bills and money coming in
 *  are tracked separately so nothing is counted twice. Transfers between your own accounts are ignored
 *  like anything else you chose to leave out. */
export type Bucket = 'spent' | 'people' | 'cardBill' | 'in' | 'cashback' | 'ignored'

// 'transfers.self' is how older imports marked your own accounts; they're ignored now too.
export const isIgnored = (t: Transaction) => topOf(t.category) === 'ignored' || t.category === 'transfers.self'

/** A refund matched to its payment. It counts where that payment counts, as a minus, so a refunded order
 *  isn't spending and isn't money in either. Unmatched refunds stay in money in. */
export const isLinkedRefund = (t: Transaction) => t.direction === 'credit' && !!t.refundOf

export function bucketOf(t: Transaction): Bucket {
  if (isIgnored(t)) return 'ignored'
  if (t.category === 'transfers.card_bill') return 'cardBill' // either side of paying a card: never spending, never money in
  if (t.direction === 'credit' && !t.refundOf) return t.kind === 'cashback' || t.category === 'income.cashback' ? 'cashback' : 'in'
  if (t.category === 'transfers.p2p') return 'people'
  return 'spent'
}

/** The data as UPI saw it: card statement rows left out. A card used on UPI stays (it was a UPI payment), and so
 *  does a refund of a UPI payment, even when it came back on the card's statement: it goes with its payment. */
export function upiOnly(data: LedgerData): LedgerData {
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  const upi = (t: Transaction) => ((isLinkedRefund(t) && byId.get(t.refundOf!)) || t).channel !== 'card'
  return { ...data, txns: data.txns.filter(upi), leftOut: data.leftOut.filter(upi) }
}

/** Calendar years that have any data, oldest first (read left to right like a timeline). */
export function periodsIn(data: LedgerData): number[] {
  const years = new Set<number>([...data.txns.map((t) => yearOf(t.at)), ...data.payments.map((p) => yearOf(p.at))])
  return [...years].sort((a, b) => a - b)
}

/** Land on the year the files say most about: the one with the most months of data (card bills or UPI),
 *  the later one on a tie. A year with a single stray screenshot shouldn't be the first thing you see. */
export function bestPeriod(data: LedgerData): PeriodKey {
  const months = new Map<number, Set<string>>()
  for (const at of [...data.txns.map((t) => t.at), ...data.payments.map((p) => p.at)]) {
    const y = yearOf(at)
    if (!months.has(y)) months.set(y, new Set())
    months.get(y)!.add(monthKey(at))
  }
  let best: PeriodKey = 'all'
  let most = 0
  for (const [year, set] of [...months].sort(([a], [b]) => a - b)) {
    if (set.size >= most) [best, most] = [year, set.size]
  }
  return best
}

export interface PeriodView {
  txns: Transaction[]
  payments: CardPayment[]
  /** `refunded`: matched refunds already taken off `spent`. */
  totals: Record<Bucket, number> & { cardBillsPaid: number; refunded: number }
  counts: Record<Bucket, number>
  months: { key: string; spent: number; count: number }[]
  cardMonths: { key: string; spent: number; count: number }[]
  byCategory: { id: string; label: string; amount: number; count: number; children: { id: string; label: string; amount: number; count: number }[] }[]
  topPayees: { payee: string; amount: number; count: number; category: string }[]
  /** Where payments were paid from: an account, a wallet, or a card of yours (`card`, when the server knows which). */
  paidFrom: { mask: string; card: string | null; amount: number; count: number }[]
  /** Bills paid in the period (by the day they were paid), per card. */
  cardBills: { card: string; title: string; amount: number; count: number; months: Map<string, number> }[]
  /** Card purchases estimated from bills that pay no statement you added, per card, counted in the billing cycle
   *  each bill paid for (spread over its days): `amount` is the estimate, `paid` the bills' part in the period and
   *  `counted` what came off them for being paid with the card on UPI. */
  estimatedBills: {
    card: string
    title: string
    amount: number
    paid: number
    counted: number
    /** Part of `counted` that was investments you left out. */
    countedLeftOut: number
    count: number
    months: Map<string, number>
  }[]
  /** Bills that pay a statement you added: their part in the period (its purchases are counted one by one). */
  coveredBills: number
  /** What you spent with each card: `amount` with the card itself (its number, read from statements or an app),
   *  `viaUpi` paid with it on UPI, which counts under UPI. Card id → totals. */
  byCard: Map<string, { amount: number; count: number; viaUpi: number; viaUpiCount: number }>
  /** The card statements in the period. */
  statements: CardStatement[]
  /** Months in the period your files speak for: UPI history (an app's records, not a card statement's UPI rows), the
   *  cycles your card bills paid for, the cycles of those that are estimated, and your card statements. */
  coverage: { upi: Set<string>; cards: Set<string>; estimated: Set<string>; statements: Set<string> }
  /** The period's left-out payments: net of their refunds, and how many. */
  leftOut: { txns: Transaction[]; amount: number; count: number }
}

export function viewFor(data: LedgerData, period: PeriodKey, category: string | null): PeriodView {
  // A matched refund is dated with its payment: refunding December's order in January lowers December.
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  const paymentOf = (t: Transaction) => (isLinkedRefund(t) ? byId.get(t.refundOf!) : undefined)
  const when = (t: Transaction) => paymentOf(t)?.at ?? t.at
  const signed = (t: Transaction) => (isLinkedRefund(t) ? -t.amount : t.amount)
  const payment = (t: Transaction) => (isLinkedRefund(t) ? 0 : 1) // counts are of payments, not refunds

  const txns = data.txns.filter((t) => inPeriod(when(t), period))
  const payments = data.payments.filter((p) => inPeriod(p.at, period))
  // a bill counts where the purchases it paid for were made: spread over the days of the cycle it pays
  const placed = data.payments
    .map((p) => ({ p, shares: cycleShares(p).filter(([k]) => inPeriod(`${k}-01`, period)) }))
    .filter((b) => b.shares.length > 0)
  const leftOutTxns = data.leftOut.filter((t) => inPeriod(when(t), period))
  const leftOut = {
    txns: leftOutTxns,
    amount: leftOutTxns.reduce((s, t) => s + (t.direction === 'debit' ? t.amount : isLinkedRefund(t) ? -t.amount : 0), 0),
    count: leftOutTxns.filter((t) => t.direction === 'debit').length,
  }

  const totals = { spent: 0, people: 0, cardBill: 0, in: 0, cashback: 0, ignored: 0, cardBillsPaid: 0, refunded: 0 }
  const counts = { spent: 0, people: 0, cardBill: 0, in: 0, cashback: 0, ignored: 0 }
  for (const t of txns) {
    const b = bucketOf(t)
    totals[b] += signed(t)
    counts[b] += payment(t)
    if (isLinkedRefund(t) && b === 'spent') totals.refunded += t.amount
  }
  totals.cardBillsPaid = payments.reduce((s, p) => s + p.amount, 0)

  const spent = txns.filter((t) => bucketOf(t) === 'spent')
  const inCategory = (t: Transaction) => !category || t.category === category || topOf(t.category) === category

  const monthTotals = new Map<string, { spent: number; count: number }>()
  for (const t of spent.filter(inCategory)) {
    const m = monthTotals.get(monthKey(when(t))) ?? { spent: 0, count: 0 }
    m.spent += signed(t)
    m.count += payment(t)
    monthTotals.set(monthKey(when(t)), m)
  }
  const cycleMonths = placed.flatMap((b) => b.shares.map(([k]) => `${k}-01`))
  const months = monthsOf(period, [...txns.map(when), ...leftOutTxns.map(when), ...payments.map((p) => p.at), ...cycleMonths]).map((key) => ({
    key,
    ...(monthTotals.get(key) ?? { spent: 0, count: 0 }),
  }))

  const tops = new Map<string, PeriodView['byCategory'][number]>()
  for (const t of spent) {
    const topId = topOf(t.category)
    const top = tops.get(topId) ?? { id: topId, label: data.categories.get(topId)?.label ?? topId, amount: 0, count: 0, children: [] }
    top.amount += signed(t)
    top.count += payment(t)
    let child = top.children.find((c) => c.id === t.category)
    if (!child) {
      child = { id: t.category, label: data.categories.get(t.category)?.label ?? t.category, amount: 0, count: 0 }
      top.children.push(child)
    }
    child.amount += signed(t)
    child.count += payment(t)
    tops.set(topId, top)
  }
  const byCategory = [...tops.values()].sort((a, b) => b.amount - a.amount)
  byCategory.forEach((c) => c.children.sort((a, b) => b.amount - a.amount))

  const paidOut = txns.filter((t) => (t.direction === 'debit' || isLinkedRefund(t)) && !isIgnored(t))
  const payees = new Map<string, PeriodView['topPayees'][number]>()
  for (const t of paidOut.filter((t) => bucketOf(t) !== 'cardBill')) { // a bill pays your own card: no payee
    const name = paymentOf(t)?.payee ?? t.payee // a refund is netted against who you paid
    const p = payees.get(name) ?? { payee: name, amount: 0, count: 0, category: t.category }
    p.amount += signed(t)
    p.count += payment(t)
    payees.set(name, p)
  }
  const topPayees = [...payees.values()].sort((a, b) => b.amount - a.amount)

  const sources = new Map<string, PeriodView['paidFrom'][number]>()
  for (const t of paidOut) {
    const owner = paymentOf(t) ?? t // refunds go back where the money came from
    const mask = owner.paidFrom ?? 'Unknown'
    const key = owner.card ? `card:${owner.card}` : mask // a card, however each file writes it
    const s = sources.get(key) ?? { mask, card: owner.card ?? null, amount: 0, count: 0 }
    s.amount += signed(t)
    s.count += payment(t)
    sources.set(key, s)
  }
  const paidFrom = [...sources.values()].sort((a, b) => b.amount - a.amount)

  const billsOf = (list: CardPayment[]) => {
    const bills = new Map<string, PeriodView['cardBills'][number]>()
    for (const p of list) {
      const b = bills.get(p.card) ?? { card: p.card, title: p.cardTitle, amount: 0, count: 0, months: new Map() }
      b.amount += p.amount
      b.count += 1
      b.months.set(monthKey(p.at), (b.months.get(monthKey(p.at)) ?? 0) + p.amount)
      bills.set(p.card, b)
    }
    return [...bills.values()].sort((a, b) => b.amount - a.amount)
  }
  const cardBills = billsOf(payments)

  const estimates = new Map<string, PeriodView['estimatedBills'][number]>()
  let coveredBills = 0
  // what came off a bill for being paid with the card on UPI, and how much of that was investments you left out
  const onCard = (list: Transaction[]) => list.filter((t) => t.card && t.channel !== 'card')
  const [onCardAll, onCardOut] = [onCard([...data.txns, ...data.leftOut]), onCard(data.leftOut)]
  const leftOutShare = (p: CardPayment) => {
    if (!onCardOut.length || !p.counted || !p.paysFrom || !p.paysTo) return 0
    const sum = (list: Transaction[]) =>
      list
        .filter((t) => t.card === p.card && t.at.slice(0, 10) >= p.paysFrom! && t.at.slice(0, 10) <= p.paysTo!)
        .reduce((s, t) => s + (t.direction === 'debit' ? t.amount : -t.amount), 0)
    const all = sum(onCardAll)
    return all > 0 ? Math.min(1, Math.max(0, sum(onCardOut) / all)) : 0
  }
  for (const { p, shares } of placed) {
    const share = shares.reduce((s, [, v]) => s + v, 0)
    if (p.coveredBy) {
      coveredBills += p.amount * share
      continue
    }
    const estimate = p.estimate ?? p.amount // a bill read before cycles were worked out
    const e = estimates.get(p.card) ?? { card: p.card, title: p.cardTitle, amount: 0, paid: 0, counted: 0, countedLeftOut: 0, count: 0, months: new Map() }
    e.amount += estimate * share
    e.paid += p.amount * share
    e.counted += (p.counted ?? 0) * share
    e.countedLeftOut += (p.counted ?? 0) * share * leftOutShare(p)
    e.count += 1
    for (const [k, v] of shares) e.months.set(k, (e.months.get(k) ?? 0) + estimate * v)
    estimates.set(p.card, e)
  }
  const estimatedBills = [...estimates.values()].sort((a, b) => b.amount - a.amount)

  const byCard = new Map<string, PeriodView['byCard'] extends Map<string, infer V> ? V : never>()
  for (const t of spent) {
    const owner = paymentOf(t) ?? t // a refund goes back the way its payment was made
    if (!owner.card) continue
    const c = byCard.get(owner.card) ?? { amount: 0, count: 0, viaUpi: 0, viaUpiCount: 0 }
    if (owner.channel === 'card') {
      c.amount += signed(t)
      c.count += payment(t)
    } else {
      c.viaUpi += signed(t)
      c.viaUpiCount += payment(t)
    }
    byCard.set(owner.card, c)
  }

  const billTotals = new Map<string, { spent: number; count: number }>()
  for (const p of payments) {
    const m = billTotals.get(monthKey(p.at)) ?? { spent: 0, count: 0 }
    m.spent += p.amount
    m.count += 1
    billTotals.set(monthKey(p.at), m)
  }
  const cardMonths = months.map(({ key }) => ({ key, ...(billTotals.get(key) ?? { spent: 0, count: 0 }) }))

  // what your files cover, left-out payments included: a month with only an SIP in it is still a month on file
  const statements = data.statements.filter((s) => statementMonths(s).some((k) => inPeriod(`${k}-01`, period)))
  const fromStatements = new Set(data.statements.map((s) => s.id))
  const fromApp = (t: Transaction) => t.channel !== 'card' && t.sources.some((s) => !fromStatements.has(s.upload))
  const coverage = {
    upi: new Set([...txns, ...leftOutTxns].filter(fromApp).map((t) => monthKey(when(t)))),
    cards: new Set(placed.flatMap((b) => b.shares.map(([k]) => k))),
    estimated: new Set(placed.filter((b) => !b.p.coveredBy).flatMap((b) => b.shares.map(([k]) => k))),
    statements: new Set(statements.flatMap(statementMonths).filter((k) => inPeriod(`${k}-01`, period))),
  }

  return { txns, payments, totals, counts, months, cardMonths, byCategory, topPayees, paidFrom, cardBills, estimatedBills, coveredBills,
           byCard, statements, coverage, leftOut }
}

const DAY = 86_400_000
const utcDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))

/** Each month a span of days runs through, with its share of the days ("2026-08" → 0.61, "2026-09" → 0.39). */
export function monthShares(from: string, to: string): [string, number][] {
  const start = utcDay(from)
  const end = utcDay(to)
  if (!(end >= start)) return []
  const days = (end - start) / DAY + 1
  const out: [string, number][] = []
  for (let at = start; at <= end; ) {
    const d = new Date(at)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    out.push([`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, ((Math.min(end, next - DAY) - at) / DAY + 1) / days])
    at = next
  }
  return out
}

/** Where a card bill counts: over the cycle it paid for (a bill read before cycles were worked out: the month it
 *  was paid). */
export function cycleShares(p: CardPayment): [string, number][] {
  const shares = p.paysFrom && p.paysTo ? monthShares(p.paysFrom, p.paysTo) : []
  return shares.length ? shares : [[monthKey(p.at), 1]]
}

/** The months a statement's period runs through ("2026-08", "2026-09"). */
export function statementMonths(s: CardStatement): string[] {
  const start = s.periodStart ?? s.statementDate
  const end = s.periodEnd ?? s.statementDate
  if (!start || !end) return []
  const out: string[] = []
  let [y, m] = start.slice(0, 7).split('-').map(Number)
  const [ey, em] = end.slice(0, 7).split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    if (++m > 12) [y, m] = [y + 1, 1]
  }
  return out
}

/** What a payment's payee is when its file doesn't say who was paid (the server's NO_NAME): many different
 *  payees under one label, so never answered as one payee. */
export const NO_NAME = 'Unknown'

/** Payees waiting for you in a period, biggest first. Their figures are the period's; `elsewhere` counts their
 *  payments waiting in other years, which the same answer settles too. */
export function reviewQueue(txns: Transaction[], period: PeriodKey = 'all') {
  const groups = new Map<string, { payee: string; amount: number; count: number; category: string; first: string; last: string; elsewhere: number }>()
  const outside = new Map<string, number>()
  for (const t of txns) {
    if (!t.needsReview || t.payee === NO_NAME) continue // unnamed payments are answered one by one
    if (!inPeriod(t.at, period)) {
      outside.set(t.payee, (outside.get(t.payee) ?? 0) + 1)
      continue
    }
    const g = groups.get(t.payee) ?? { payee: t.payee, amount: 0, count: 0, category: t.category, first: t.at, last: t.at, elsewhere: 0 }
    g.amount += t.amount
    g.count += 1
    if (t.at < g.first) g.first = t.at
    if (t.at > g.last) g.last = t.at
    groups.set(t.payee, g)
  }
  for (const g of groups.values()) g.elsewhere = outside.get(g.payee) ?? 0
  return [...groups.values()].sort((a, b) => b.amount - a.amount)
}

/** Payments out in a period whose file doesn't say who was paid, still waiting for an answer. */
export function unnamedWaiting(txns: Transaction[], period: PeriodKey = 'all') {
  const waiting = txns.filter((t) => t.payee === NO_NAME && t.needsReview && t.direction === 'debit' && inPeriod(t.at, period))
  return { count: waiting.length, amount: waiting.reduce((s, t) => s + t.amount, 0) }
}

/** The card of yours an app's "XXXX99" on UPI is, as the server decides it (backend/app/billing.py): the one ending
 *  that way, the RuPay one if more than one does (only RuPay credit cards work on UPI), never a card on another
 *  network. */
export function cardsOnUpi(mask: string, cards: Instrument[]): Instrument[] {
  const digits = mask.replace(/\D/g, '')
  const ending = cards.filter((c) => c.last4.endsWith(digits))
  const rupay = ending.filter((c) => c.network?.toLowerCase() === 'rupay')
  return rupay.length ? rupay : ending.filter((c) => !c.network)
}

/** How a payment was paid, in words: the card of yours it was charged to, when known, or its account's mask. */
export function paidFromLabel(t: Transaction, cards: Instrument[], accounts: OwnAccount[] = []): { title: string; detail: string } {
  const card = t.card ? cards.find((c) => c.id === t.card) : undefined
  if (card) return { title: `${card.name} ••${card.last4}`, detail: t.channel === 'card' ? 'Credit card' : 'Credit card on UPI' }
  return t.paidFrom ? describeSource(t.paidFrom, cards, accounts) : { title: '—', detail: '' }
}

/** "XX4321" → Account ••4321, "XXXX99" → Card ••99 (+ which card of yours it is), "XXXX4321" → that card. */
export function describeSource(mask: string, cards: Instrument[], accounts: OwnAccount[] = []): { title: string; detail: string } {
  if (/^gift card$/i.test(mask)) return { title: 'PhonePe gift card', detail: 'Cashback balance' }
  const digits = mask.replace(/\D/g, '')
  if (/^X{4}\d{2}$/i.test(mask)) {
    const matches = cardsOnUpi(mask, cards)
    return {
      title: matches.length === 1 ? `${matches[0].name} ••${matches[0].last4}` : `Card ••${digits}`,
      detail:
        matches.length === 1
          ? 'Credit card on UPI'
          : matches.length > 1
            ? `Credit card on UPI · ${matches.length} of your cards end in ${digits}: set the RuPay one's network on its card`
            : 'RuPay credit card on UPI',
    }
  }
  if (/^X{4}\d{4}$/i.test(mask)) {
    const card = cards.find((c) => c.last4 === digits) // a card statement's row: the card itself
    if (card) return { title: `${card.name} ••${digits}`, detail: 'Credit card' }
  }
  if (digits.length >= 4) {
    const yours = accounts.find((a) => a.last4 === digits.slice(-4))
    return { title: `${yours?.label || 'Account'} ••${digits.slice(-4)}`, detail: 'Bank account' }
  }
  return { title: mask, detail: '' }
}
