import type { Instrument, Transaction } from '../types'
import { bucketOf, isLinkedRefund, topOf, viewFor, type LedgerData, type PeriodView } from './ledger'
import { inr } from './money'
import { monthKey, type PeriodKey } from './periods'
import type { Trend } from './totals'

/** Your cards as the card section sees them: purchases with a card's number only. What you paid with a card on UPI
 *  counts under UPI (a refund goes with its payment), so it's left out here and only noted beside each card.
 *  `card`: one card's, or all of them. Its bills and statements come along, so a view of this data has that card's
 *  estimates and coverage. */
export function cardsOnly(data: LedgerData, card: string | null): LedgerData {
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  const keep = (t: Transaction) => {
    const owner = (isLinkedRefund(t) && byId.get(t.refundOf!)) || t
    return owner.channel === 'card' && (!card || owner.card === card)
  }
  return {
    ...data,
    txns: data.txns.filter(keep),
    leftOut: data.leftOut.filter(keep),
    payments: card ? data.payments.filter((p) => p.card === card) : data.payments,
    statements: card ? data.statements.filter((s) => s.card === card) : data.statements,
  }
}

/** What a card's files say about each of its months, as spans of the month (0 = its first day, 1 = past its
 *  last): its statements' periods (read one by one) and the cycles its bills paid for without a statement
 *  (estimated). */
export interface CoverSpan {
  from: number
  to: number
  kind: 'itemized' | 'estimated'
}

const DAY = 86_400_000
const utcDay = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))

/** The part of each month a span of days covers ("2026-08-13".."2026-09-12" → Aug from 12/31 to 1, Sep 0 to 12/30). */
function spansOf(from: string, to: string): [string, number, number][] {
  const start = utcDay(from)
  const end = utcDay(to)
  const out: [string, number, number][] = []
  for (let at = start; at <= end; ) {
    const d = new Date(at)
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    const days = (next - first) / DAY
    const last = Math.min(end, next - DAY)
    out.push([`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, (at - first) / DAY / days, ((last - first) / DAY + 1) / days])
    at = next
  }
  return out
}

/** Card id → month → what covers it. */
export function coverageByCard(data: LedgerData): Map<string, Map<string, CoverSpan[]>> {
  const out = new Map<string, Map<string, CoverSpan[]>>()
  const add = (card: string, from: string, to: string, kind: CoverSpan['kind']) => {
    const months = out.get(card) ?? new Map<string, CoverSpan[]>()
    for (const [k, a, b] of spansOf(from, to)) months.set(k, [...(months.get(k) ?? []), { from: a, to: b, kind }])
    out.set(card, months)
  }
  for (const s of data.statements) if (s.card && s.periodStart && s.periodEnd) add(s.card, s.periodStart, s.periodEnd, 'itemized')
  for (const p of data.payments) if (!p.coveredBy && p.paysFrom && p.paysTo) add(p.card, p.paysFrom, p.paysTo, 'estimated')
  return out
}

/** One card's (or every card's) figures for a period, from a view of `cardsOnly` data and the whole dashboard's view
 *  (which knows what was paid with each card on UPI). */
export interface CardFigures {
  /** Purchases and charges with the card's number, read one by one, refunds taken off. */
  itemized: number
  itemizedCount: number
  /** Card purchases estimated from bills that pay no statement you added. */
  estimated: number
  /** Paid with the card on UPI: counted under UPI spends. */
  viaUpi: number
  viaUpiCount: number
  /** Of `itemized`: fees, interest and taxes the bank charged. */
  fees: number
  refunded: number
  cashback: number
  billsPaid: number
  billsCount: number
  /** Of `billsCount`: bills only a statement records (no app's history had them). */
  billsFromStatements: number
}

export function cardFigures(cardView: PeriodView, all: PeriodView, card: string | null): CardFigures {
  const via = card ? [all.byCard.get(card)].filter((c) => !!c) : [...all.byCard.values()]
  return {
    itemized: cardView.totals.spent,
    itemizedCount: cardView.counts.spent,
    estimated: cardView.estimatedBills.reduce((s, b) => s + b.amount, 0),
    viaUpi: via.reduce((s, c) => s + c.viaUpi, 0),
    viaUpiCount: via.reduce((s, c) => s + c.viaUpiCount, 0),
    fees: cardView.byCategory.find((c) => c.id === 'fees')?.amount ?? 0,
    refunded: cardView.totals.refunded,
    cashback: cardView.totals.cashback,
    billsPaid: cardView.totals.cardBillsPaid,
    billsCount: cardView.payments.length,
    billsFromStatements: cardView.payments.filter((p) => p.origin === 'statement').length,
  }
}


/** Where a period's bills paid were read: a payment app's history, the statements' own payment rows, or both. */
export const billsFrom = (f: CardFigures) =>
  f.billsFromStatements === 0 ? 'your CRED history' : f.billsFromStatements === f.billsCount ? 'your statements' : 'CRED and your statements'

/** A card's name where space is short: "Regalia ••1234" (its product, else its bank). */
export const cardName = (c: Instrument) => `${c.product ?? c.issuer ?? 'Card'} ••${c.last4}`

/** Each card's spending month by month, for the card section's chart: purchases with the card's number read from
 *  your statements (on the day you bought, refunds taken off) plus what its bills say for months without one
 *  (spread over the cycles they paid). A month is estimated when a bill speaks for more of it than a statement
 *  does; a month no file covers is a gap. With a category: only what statements say about it, since a bill doesn't
 *  say what you bought. What you paid with a card on UPI is UPI's, noted under the month. */
export function cardTrends(data: LedgerData, period: PeriodKey, category: string | null): { months: string[]; trends: Trend[] } {
  const view = viewFor(cardsOnly(data, null), period, null)
  const months = view.months.map((m) => m.key)
  const index = new Map(months.map((k, i) => [k, i]))
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  const zeros = () => new Array<number>(months.length).fill(0)
  const add = (to: Map<string, number[]>, card: string, i: number, v: number) => {
    const row = to.get(card) ?? zeros()
    row[i] += v
    to.set(card, row)
  }

  const read = new Map<string, number[]>()
  const onUpi = new Map<string, number[]>()
  for (const t of data.txns) {
    if (bucketOf(t) !== 'spent' || (category && t.category !== category && topOf(t.category) !== category)) continue
    const owner = (isLinkedRefund(t) && byId.get(t.refundOf!)) || t // a refund counts where its payment does
    const i = index.get(monthKey(owner.at))
    if (!owner.card || i === undefined) continue
    add(owner.channel === 'card' ? read : onUpi, owner.card, i, isLinkedRefund(t) ? -t.amount : t.amount)
  }
  const billed = new Map<string, number[]>()
  if (!category) {
    for (const b of view.estimatedBills) for (const [k, v] of b.months) if (index.has(k)) add(billed, b.card, index.get(k)!, v)
  }

  const cover = coverageByCard(data)
  const trends = data.cards.map((card) => {
    const values: (number | null)[] = []
    const estimated: boolean[] = []
    const notes: (string | null)[] = []
    months.forEach((k, i) => {
      const spans = cover.get(card.id)?.get(k) ?? []
      const share = (kind: CoverSpan['kind']) => spans.filter((s) => s.kind === kind).reduce((n, s) => n + s.to - s.from, 0)
      const fromStatements = share('itemized')
      const fromBills = category ? 0 : share('estimated')
      const r = read.get(card.id)?.[i] ?? 0
      const known = fromStatements > 0 || fromBills > 0 || Math.abs(r) > 0.005
      values.push(known ? r + (billed.get(card.id)?.[i] ?? 0) : null)
      estimated.push(known && fromBills > fromStatements)
      const upi = onUpi.get(card.id)?.[i] ?? 0
      notes.push(upi > 0.5 ? `+ ${inr(upi)} on UPI, in UPI spends` : null)
    })
    return { id: card.id, label: cardName(card), amount: values.reduce<number>((t, v) => t + (v ?? 0), 0), values, estimated, notes }
  })
  return { months, trends: trends.filter((t) => t.values.some((v) => v !== null)).sort((a, b) => b.amount - a.amount) }
}

/** Up to seven cards get a colour of their own, the most spent with across all your years (unscoped), so a card
 *  keeps its colour whichever year you pick; the rest are grey and named at their line's end. */
export function cardColours(everything: LedgerData): Map<string, string> {
  return new Map(cardTrends(everything, 'all', null).trends.slice(0, 7).map((t, i) => [t.id, `var(--color-series-${i + 1})`]))
}
