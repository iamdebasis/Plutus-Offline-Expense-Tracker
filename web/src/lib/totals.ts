import type { Instrument, Transaction } from '../types'
import { bucketOf, isLinkedRefund, topOf, type LedgerData, type PeriodView } from './ledger'
import { monthKey } from './periods'

/** Everything you spent in a period: cards and UPI together, counted once.
 *
 *  - UPI spending, by category (refunds already taken off), including payments made *with* a credit card on UPI
 *    (RuPay), whichever file they were learned from: an app's history or the card's statement.
 *  - Purchases with a card's number, read from your card statements one by one, in their categories, on the day
 *    you bought.
 *  - Card purchases estimated from the bills you paid (an app's history, or a statement's own payment row) that pay
 *    no statement you added. A bill also pays for what you paid with the card on UPI in its cycle, which is counted
 *    above already, so that comes off; what's left counts in the billing cycle the bill paid for
 *    (backend/app/billing.py places each bill).
 *
 *  Payments to people and anything ignored stay out, as in the UPI section; so do investments when you leave
 *  them out (lib/scope.ts). Those still come off their card's bills when paid with a card on UPI, or they'd be
 *  counted again as card purchases. */
export interface TotalSpend {
  total: number
  /** Spending seen by UPI (refunds taken off), a card used on UPI included. */
  upi: number
  /** Purchases and charges with a card's number, read one by one from your card statements. */
  cards: number
  /** Part of `upi` paid with a credit card. */
  upiOnCards: number
  /** Bills that pay no statement you added, their part in the period: what card purchases are estimated from. */
  cardBills: number
  /** Bills that pay a statement you added: its purchases are counted one by one, so these add nothing. */
  coveredBills: number
  /** What those bills paid for with the card on UPI, taken off so nothing counts twice. */
  cardOverlap: number
  /** Part of `cardOverlap` that was investments you left out. */
  cardOverlapLeftOut: number
  /** Card purchases estimated from bills. */
  cardPurchases: number
  /** Left out, for the footnote. */
  people: number
  invested: number
  byCategory: PeriodView['byCategory']
}

export const CARD_PURCHASES = 'cards'

export function totalSpendFor(data: LedgerData, view: PeriodView): TotalSpend {
  const children = view.estimatedBills
    .filter((b) => b.amount > 0.5)
    .map((b) => ({ id: `${CARD_PURCHASES}.${b.card}`, label: cardLabel(b.card, b.title, data.cards), amount: b.amount, count: b.count }))
  const cardPurchases = children.reduce((s, c) => s + c.amount, 0)

  const byCategory = view.byCategory.filter((c) => c.amount > 0.5).map((c) => ({ ...c, children: c.children.filter((k) => k.amount > 0.5) }))
  if (cardPurchases > 0) {
    byCategory.push({ id: CARD_PURCHASES, label: 'Card purchases', amount: cardPurchases, count: children.reduce((s, c) => s + c.count, 0), children })
  }
  byCategory.sort((a, b) => b.amount - a.amount)

  let upi = 0
  let cards = 0
  let upiOnCards = 0
  const byId = new Map(data.txns.map((t) => [t.id, t]))
  for (const t of view.txns) {
    if (bucketOf(t) !== 'spent') continue
    const amount = isLinkedRefund(t) ? -t.amount : t.amount
    const owner = (isLinkedRefund(t) && byId.get(t.refundOf!)) || t // a refund counts the way its payment was made
    if (owner.channel === 'card') cards += amount
    else upi += amount
    if (owner.card && owner.channel !== 'card') upiOnCards += amount
  }
  const sum = (key: 'paid' | 'counted' | 'countedLeftOut') => view.estimatedBills.reduce((s, b) => s + b[key], 0)
  return {
    total: upi + cards + cardPurchases,
    upi,
    cards,
    upiOnCards,
    cardBills: sum('paid'),
    coveredBills: view.coveredBills,
    cardOverlap: sum('counted'),
    cardOverlapLeftOut: sum('countedLeftOut'),
    cardPurchases,
    people: view.totals.people,
    invested: view.leftOut.amount,
    byCategory,
  }
}

function cardLabel(id: string, title: string, cards: Instrument[]): string {
  const card = cards.find((c) => c.id === id)
  return card ? `${card.product ?? card.issuer ?? 'Card'} ••${card.last4}` : title
}

/** Up to six categories get a colour of their own, the biggest across all your years, so a category keeps its
 *  colour whichever year you look at; the rest share "Other". Slot order is ring order, which is what the
 *  palette was validated for (neighbouring slices). */
export function colourSlots(allTime: TotalSpend, slots = 6): Map<string, string> {
  return new Map(allTime.byCategory.slice(0, slots).map((c, i) => [c.id, `var(--color-series-${i + 1})`]))
}

export const OTHER_COLOUR = 'var(--color-series-other)'


/** One line of a month-by-month chart (components/dash/Trends.tsx): a category in Total spend, a card in Credit cards. */
export interface Trend {
  id: string
  label: string
  /** Spent in the whole period: orders the chips and picks the default ticks. */
  amount: number
  /** One per month; null where no file covers the month (a gap in the line, not ₹0). */
  values: (number | null)[]
  /** Months whose figure is an estimate: drawn dashed, "≈" in the table and the tooltip. */
  estimated?: boolean[]
  /** The whole line is an estimate (card purchases from bills). */
  dashed?: boolean
  /** A note under a month's figure in the tooltip ("+ ₹2,100 on UPI, in UPI spends"). */
  notes?: (string | null)[]
}

/** Each Total spend category by month, so the lines add up to the same totals. UPI and card statement categories
 *  by payment date (a matched refund by its payment's); estimated card purchases over the cycles their bills paid. */
export function monthlyTrends(data: LedgerData, view: PeriodView, totals: TotalSpend): { months: string[]; trends: Trend[] } {
  const months = view.months.map((m) => m.key)
  const index = new Map(months.map((k, i) => [k, i]))
  const byId = new Map(data.txns.map((t) => [t.id, t]))
  const when = (t: Transaction) => (isLinkedRefund(t) && byId.get(t.refundOf!)?.at) || t.at

  const upi = new Map<string, number[]>()
  for (const t of view.txns) {
    if (bucketOf(t) !== 'spent') continue
    const i = index.get(monthKey(when(t)))
    if (i === undefined) continue
    const top = topOf(t.category)
    if (!upi.has(top)) upi.set(top, new Array(months.length).fill(0))
    upi.get(top)![i] += isLinkedRefund(t) ? -t.amount : t.amount
  }

  const cards = new Array<number>(months.length).fill(0)
  for (const bill of view.estimatedBills) {
    for (const [k, v] of bill.months) {
      const i = index.get(k)
      if (i !== undefined) cards[i] += v
    }
  }
  const itemized = (k: string) => view.coverage.upi.has(k) || view.coverage.statements.has(k)

  const trends = totals.byCategory.map((c) => ({
    id: c.id,
    label: c.label,
    amount: c.amount,
    values: months.map((k, i) => {
      if (c.id === CARD_PURCHASES) return view.coverage.estimated.has(k) ? Math.max(0, cards[i]) : view.coverage.statements.has(k) ? 0 : null
      return itemized(k) ? Math.max(0, upi.get(c.id)?.[i] ?? 0) : null
    }),
  }))
  return { months, trends }
}
