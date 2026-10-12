import type { Transaction } from '../types'
import { bucketOf, cycleShares, isLinkedRefund, NO_NAME, periodsIn, topOf, viewFor, type LedgerData, type PeriodView } from './ledger'
import { inPeriod, type PeriodKey } from './periods'
import { CARD_PURCHASES, monthlyTrends, totalSpendFor, type TotalSpend } from './totals'

/** What Total spend shows under its sum line (components/dash/SpendFocus.tsx): for a category you tap, where the money
 *  went, shop by shop, and its biggest payments; for Card purchases, the bills they're estimated from; with nothing
 *  tapped, a few highlights of the period. Worked out from the rows Where it went counts, so a category's shops add up
 *  to its figure there, and Ask Plutus names the same top payees (web/tests/focus.test.ts holds both). */

export const UNCATEGORIZED = 'uncategorized'

/** A shop and what you spent there: refunds taken off, one shop however its files spell it (`Transaction.shop`). */
export interface Shop {
  /** Its name; NO_NAME for payments whose files say no payee (many payees, never one shop). */
  shop: string
  amount: number
  payments: number
  /** How its files spell it. */
  names: string[]
  /** Its payments and their refunds. */
  ids: string[]
}

/** One payment, as big as it was paid; `refunded` is what came back on it. */
export interface Payment {
  id: string
  day: string
  shop: string
  category: string
  amount: number
  refunded: number
}

const under = (category: string, id: string) => category === id || topOf(category) === id

/** The rows Where it went counts under a category (every category: null), each with the payment it belongs to (a
 *  refund's is the payment it gives money back for). */
function spending(data: LedgerData, view: PeriodView, category: string | null) {
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  return view.txns
    .filter((t) => bucketOf(t) === 'spent' && (category === null || under(t.category, category)))
    .map((t) => ({ t, owner: (isLinkedRefund(t) && byId.get(t.refundOf!)) || t }))
}

/** Where a category's money went, biggest shop first (every shop, so they add up to the category's figure). */
export function shopsIn(data: LedgerData, view: PeriodView, category: string | null): Shop[] {
  const shops = new Map<string, Shop>()
  for (const { t, owner } of spending(data, view, category)) {
    const s = shops.get(owner.shop) ?? { shop: owner.shop, amount: 0, payments: 0, names: [], ids: [] }
    s.amount += isLinkedRefund(t) ? -t.amount : t.amount
    s.payments += isLinkedRefund(t) ? 0 : 1
    if (!s.names.includes(owner.payee)) s.names.push(owner.payee)
    s.ids.push(t.id)
    shops.set(owner.shop, s)
  }
  return [...shops.values()].sort((a, b) => b.amount - a.amount || a.shop.localeCompare(b.shop))
}

/** The top `n` of a category's shops (those it spent anything at), and the rest in one line: how many, and how much
 *  between them. The shown and the rest add up to the category's figure. */
export function topShops(shops: Shop[], n: number): { shown: Shop[]; rest: { count: number; amount: number } } {
  const spent = shops.filter((s) => s.amount > 0.5)
  const shown = spent.slice(0, n)
  const others = shops.filter((s) => !shown.includes(s)) // a shop refunded in full still comes off, here
  return { shown, rest: { count: spent.length - shown.length, amount: others.reduce((sum, s) => sum + s.amount, 0) } }
}

/** A category's biggest payments, as they were paid (the same as Ask Plutus's "biggest payments"), with what came back
 *  on each. */
export function biggestIn(data: LedgerData, view: PeriodView, category: string | null, limit = 5): Payment[] {
  const back = new Map<string, number>()
  for (const t of data.txns) if (isLinkedRefund(t)) back.set(t.refundOf!, (back.get(t.refundOf!) ?? 0) + t.amount)
  return spending(data, view, category)
    .filter(({ t }) => !isLinkedRefund(t))
    .sort((a, b) => b.t.amount - a.t.amount || a.t.at.localeCompare(b.t.at))
    .slice(0, limit)
    .map(({ t }) => ({ id: t.id, day: t.at.slice(0, 10), shop: t.shop, category: t.category, amount: t.amount, refunded: back.get(t.id) ?? 0 }))
}

/** A card's purchases estimated from its bills in the period, and each bill's part: a bill doesn't say what it paid
 *  for, so these are all there is to show of them. */
export interface CardEstimate {
  card: string
  /** As Where it went names it. */
  label: string
  amount: number
  /** The bills' part in the period, and what came off them for being paid with the card on UPI (counted there). */
  paid: number
  counted: number
  /** `share`: the part of its cycle's days in the period (a cycle can start in the year before). */
  bills: { id: string; paidOn: string; amount: number; from: string | null; to: string | null; share: number; estimate: number }[]
}

export function cardEstimates(data: LedgerData, view: PeriodView, totals: TotalSpend, period: PeriodKey): CardEstimate[] {
  const labels = new Map((totals.byCategory.find((c) => c.id === CARD_PURCHASES)?.children ?? []).map((c) => [c.id, c.label]))
  return view.estimatedBills
    .filter((e) => labels.has(`${CARD_PURCHASES}.${e.card}`)) // as Where it went lists them (a part under 50 paise isn't)
    .map((e) => ({
      card: e.card,
      label: labels.get(`${CARD_PURCHASES}.${e.card}`)!,
      amount: e.amount,
      paid: e.paid,
      counted: e.counted,
      // each bill whose cycle runs through the period, its estimate spread over the cycle's days as viewFor spreads it
      bills: data.payments
        .filter((p) => p.card === e.card && !p.coveredBy)
        .map((p) => ({ p, share: cycleShares(p).filter(([k]) => inPeriod(`${k}-01`, period)).reduce((s, [, v]) => s + v, 0) }))
        .filter(({ share }) => share > 0)
        .map(({ p, share }) => ({ id: p.id, paidOn: p.at.slice(0, 10), amount: p.amount, from: p.paysFrom ?? null, to: p.paysTo ?? null, share, estimate: (p.estimate ?? p.amount) * share }))
        .sort((a, b) => b.paidOn.localeCompare(a.paidOn)),
    }))
}

/** What's worth seeing about a period before you tap anything. */
export interface Highlights {
  biggest: Payment | null
  /** The shop you spent most at (never the payments without a payee name). */
  topShop: Shop | null
  /** The month you spent most in, as Month by month adds it up; `estimated` when card bills' estimates are in it. */
  busiest: { month: string; amount: number; estimated: boolean } | null
  /** This year against the one before, over the months both years' files cover alike (the same kinds of file:
   *  a month with only UPI history isn't set against one with your cards too). */
  before: { year: number; months: number; now: number; then: number } | null
  /** One thing to do that makes the figures fuller: the bigger of what's waiting for a category and what's only
   *  estimated from card bills; with no card in your files at all, adding one. */
  action: { kind: 'uncategorized'; amount: number; shops: number } | { kind: 'estimated'; amount: number; cards: number } | { kind: 'no-cards' } | null
}

export function highlights(data: LedgerData, view: PeriodView, totals: TotalSpend, period: PeriodKey): Highlights {
  const months = together(data, view, totals)
  let busiest: Highlights['busiest'] = null
  for (const m of months) if (m.amount > 0.5 && (!busiest || m.amount > busiest.amount)) busiest = m

  let before: Highlights['before'] = null
  if (period !== 'all' && periodsIn(data).includes(period - 1)) {
    const was = viewFor(data, period - 1, null)
    const then = new Map(together(data, was, totalSpendFor(data, was)).map((m) => [m.month.slice(5), m]))
    const kinds = (v: PeriodView, k: string) => `${v.coverage.upi.has(k)}/${v.coverage.cards.has(k) || v.coverage.statements.has(k)}`
    const alike = months.filter((m) => {
      const t = then.get(m.month.slice(5))
      return t && kinds(view, m.month) === kinds(was, t.month) && kinds(view, m.month) !== 'false/false'
    })
    const sumOf = (list: { amount: number }[]) => list.reduce((s, m) => s + m.amount, 0)
    const [now, earlier] = [sumOf(alike), sumOf(alike.map((m) => then.get(m.month.slice(5))!))]
    if (alike.length && earlier > 0.5) before = { year: period - 1, months: alike.length, now, then: earlier }
  }

  const uncategorized = totals.byCategory.find((c) => c.id === UNCATEGORIZED)?.amount ?? 0
  const waiting = { kind: 'uncategorized' as const, amount: uncategorized, shops: uncategorized > 0.5 ? shopsIn(data, view, UNCATEGORIZED).filter((s) => s.amount > 0.5).length : 0 }
  const estimated = { kind: 'estimated' as const, amount: totals.cardPurchases, cards: view.estimatedBills.filter((e) => e.amount > 0.5).length }
  const action = [waiting, estimated].filter((a) => a.amount > 0.5).sort((a, b) => b.amount - a.amount)[0]
    ?? (totals.cards <= 0.5 && totals.cardBills <= 0.5 && totals.coveredBills <= 0.5 ? { kind: 'no-cards' as const } : null)

  return {
    biggest: biggestIn(data, view, null, 1)[0] ?? null,
    topShop: shopsIn(data, view, null).find((s) => s.shop !== NO_NAME && s.amount > 0.5) ?? null,
    busiest,
    before,
    action,
  }
}

/** Each month the period's files cover, everything you spent in it, as Month by month's table adds it up
 *  ("Together"). */
function together(data: LedgerData, view: PeriodView, totals: TotalSpend) {
  const { months, trends } = monthlyTrends(data, view, totals)
  return months
    .map((month, i) => {
      const values = trends.map((t) => t.values[i])
      return {
        month,
        covered: values.some((v) => v !== null),
        amount: values.reduce<number>((s, v) => s + (v ?? 0), 0),
        estimated: trends.some((t) => t.id === CARD_PURCHASES && (t.values[i] ?? 0) > 0.5),
      }
    })
    .filter((m) => m.covered)
    .map(({ month, amount, estimated }) => ({ month, amount, estimated }))
}

/** The payments in your files to a shop that are waiting in Uncategorized, by how its files spell it: what one answer
 *  for the shop files, in every year, as the review list's answer would. */
export function namesWaiting(txns: Transaction[], shop: string): string[] {
  return [...new Set(txns.filter((t) => t.shop === shop && t.payee !== NO_NAME && under(t.category, UNCATEGORIZED)).map((t) => t.payee))].sort()
}
