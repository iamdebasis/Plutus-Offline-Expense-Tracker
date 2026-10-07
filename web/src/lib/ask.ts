import type { CardPayment, Transaction } from '../types'
import { plural } from './format'
import { bucketOf, cycleShares, isLinkedRefund, NO_NAME, periodsIn, topOf, viewFor, type Bucket, type LedgerData } from './ledger'
import { inr, inrExact } from './money'
import { dayLabel, monthLongLabel, monthYearLabel } from './periods'

/** "Ask Plutus": a question becomes a query of a fixed shape (lib/askRules.ts reads it, or the local AI does, through
 *  POST /api/ask), and the answer is computed here, from the ledger, with the dashboard's own rules: the same buckets,
 *  refunds dated with their payments, investments left out when you chose so, and card spending estimated from bills
 *  spread over the cycles they paid for. Nothing here guesses a number; every figure is a sum of payments the
 *  dashboard counts the same way, and `ids` says which. */

export type AskKind = 'total' | 'count' | 'average' | 'top' | 'largest' | 'compare' | 'trend' | 'list' | 'last'

/** A span of days, both ends included ("2025-01-01" … "2025-12-31"), and how to say it ("2025", "March 2026"). */
export interface AskPeriod {
  from: string
  to: string
  label: string
}

export interface AskQuery {
  kind: AskKind
  /** Category ids; a top-level one ("bills") takes in its children. Empty: everything the measure covers. */
  categories: string[]
  /** Words a payee's name must contain ("swiggy"), matched against your payees here on this Mac. */
  payees: string[]
  /** Card ids, for "on my … card". */
  cards: string[]
  channel: 'all' | 'upi' | 'cards'
  /** "out": what you spent (and, when you name someone, paid to people); "in": money that came in. */
  money: 'out' | 'in'
  /** null: all your files. */
  period: AskPeriod | null
  /** compare: the period to set against `period`. */
  compareTo: AskPeriod | null
  /** top: what to rank. */
  by: 'payee' | 'category'
  /** average: per payment or per month. */
  per: 'payment' | 'month'
  limit: number
}

export const emptyQuery = (kind: AskKind = 'total'): AskQuery => ({
  kind, categories: [], payees: [], cards: [], channel: 'all', money: 'out', period: null, compareTo: null, by: 'payee',
  per: 'payment', limit: 5,
})

export interface AskLine {
  label: string
  amount: number
  /** "12 payments", a date, a payee: said under the label. */
  detail?: string
  /** A month key, for a trend's bars. */
  month?: string
}

export interface AskAnswer {
  query: AskQuery
  /** The figure in large type ("₹14,850", "12 payments", "1 Oct 2026"); null when the answer is a list. */
  figure: string | null
  /** The figure's money, unrounded (a total, an average, one payment); null when it isn't money. */
  amount: number | null
  /** How many payments the answer counts. */
  payments: number
  sentence: string
  lines: AskLine[]
  /** The payments the answer is made of, for "Show these payments". */
  ids: string[]
  /** The payee names your words matched, so you can see who was counted. */
  matchedPayees: string[]
  /** What the answer leaves out, and why. */
  notes: string[]
}

// ---- periods ------------------------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
export const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
}
export const yearPeriod = (y: number): AskPeriod => ({ from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) })
export const monthPeriod = (month: string): AskPeriod => ({ from: `${month}-01`, to: lastDayOf(month), label: monthLongLabel(month) })
/** India's financial year: April to March ("FY 2024–25"). */
export const fyPeriod = (startYear: number): AskPeriod => ({
  from: `${startYear}-04-01`, to: `${startYear + 1}-03-31`, label: `FY ${startYear}–${String(startYear + 1).slice(2)}`,
})
export function rangePeriod(from: string, to: string): AskPeriod {
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  if (from.slice(8) === '01' && to === lastDayOf(to.slice(0, 7))) {
    const [a, b] = [from.slice(0, 7), to.slice(0, 7)]
    if (a === b) return monthPeriod(a)
    if (sameYear && a.endsWith('-01') && b.endsWith('-12')) return yearPeriod(Number(a.slice(0, 4)))
    return { from, to, label: `${monthYearLabel(a)} – ${monthYearLabel(b)}` }
  }
  return { from, to, label: `${dayLabel(from)} – ${dayLabel(to)}` }
}

/** "in 2025", "in March 2026", "from 1 Nov 2025 to 28 Feb 2026", "in all your files". */
export function periodPhrase(p: AskPeriod | null): string {
  if (!p) return 'in all your files'
  return /^\d{1,2} /.test(p.label) ? `from ${dayLabel(p.from)} to ${dayLabel(p.to)}` : `in ${p.label}`
}

const inPeriodOf = (p: AskPeriod | null, day: string) => !p || (p.from <= day && day <= p.to)

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.slice(0, 7).split('-').map(Number)
  const [ey, em] = to.slice(0, 7).split('-').map(Number)
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}`)
    if (m === 12) [y, m] = [y + 1, 1]
    else m += 1
  }
  return out
}

// ---- the rows, as the dashboard counts them ------------------------------------------------------------------------

interface Row {
  t: Transaction
  /** The day it counts on: a refund taken off its payment counts on the payment's day (as in viewFor). */
  day: string
  /** Signed: such a refund is negative. */
  amount: number
  /** 1 for a payment, 0 for such a refund: counts are of payments. */
  payments: number
  bucket: Bucket
  /** The payment itself (a refund's, for a refund): who was paid, with what, how. */
  owner: Transaction
}

function rowsOf(txns: Transaction[], all: Transaction[]): Row[] {
  const byId = new Map(all.map((t) => [t.id, t]))
  return txns.map((t) => {
    const payment = isLinkedRefund(t) ? byId.get(t.refundOf!) : undefined
    return {
      t,
      day: (payment?.at ?? t.at).slice(0, 10),
      amount: isLinkedRefund(t) ? -t.amount : t.amount,
      payments: isLinkedRefund(t) ? 0 : 1,
      bucket: bucketOf(t),
      owner: payment ?? t,
    }
  })
}

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

/** Whether a payee's name has the word ("swig" finds "SWIGGY BANGALORE"; "bigbasket" finds "BIG BASKET"). */
export function payeeMatches(name: string, word: string): boolean {
  if (name === NO_NAME || !word.trim()) return false
  if (words(name).includes(` ${words(word).trim()}`)) return true
  return compact(word).length >= 5 && compact(name).includes(compact(word))
}

const isUnder = (category: string, id: string) => category === id || topOf(category) === id
const CARD_BILL = 'transfers.card_bill'
const INVESTMENTS = 'investments'

/** What the query measures, in the dashboard's buckets. */
function bucketsFor(q: AskQuery): Set<Bucket> {
  if (q.money === 'in') return new Set(['in', 'cashback'])
  const out = new Set<Bucket>(['spent'])
  if (q.payees.length || q.categories.some((c) => c === 'transfers' || c === 'transfers.p2p')) out.add('people')
  if (q.categories.some((c) => c === 'ignored')) out.add('ignored')
  return out
}

/** The rows a query adds up, for one period. */
function select(data: LedgerData, q: AskQuery, period: AskPeriod | null): Row[] {
  const investments = q.categories.some((c) => c === INVESTMENTS)
  const source = investments ? [...data.txns, ...data.leftOut] : data.txns
  const buckets = bucketsFor(q)
  return rowsOf(source, [...data.txns, ...data.leftOut]).filter(
    (r) =>
      buckets.has(r.bucket) &&
      inPeriodOf(period, r.day) &&
      (!q.categories.length || q.categories.some((c) => isUnder(r.t.category, c))) &&
      (!q.payees.length || q.payees.some((w) => payeeMatches(r.owner.payee, w))) &&
      (!q.cards.length || (!!r.owner.card && q.cards.includes(r.owner.card))) &&
      (q.channel === 'all' || (q.channel === 'cards') === (r.owner.channel === 'card')),
  )
}

/** Card spending known only from bills (a cycle no statement lists), per month, as Total spend counts it: the bill's
 *  estimate spread over the days of the cycle it paid for; a card's part under 50 paise left out, as there. Only a
 *  question about all your spending (or a card's) takes it in: it has no category or payee. */
function estimates(data: LedgerData, q: AskQuery, period: AskPeriod | null) {
  const months = new Map<string, number>()
  const partial = new Set<string>()
  const perCard = new Map<string, number>()
  if (q.money !== 'out' || q.categories.length || q.payees.length || q.channel === 'upi') return { amount: 0, months, partial }
  const placed: [string, string, number][] = []
  for (const p of data.payments) {
    if (p.coveredBy || (q.cards.length && !q.cards.includes(p.card))) continue
    const estimate = p.estimate ?? p.amount
    for (const [month, share] of cycleShares(p)) {
      const [from, to] = [`${month}-01`, lastDayOf(month)]
      if (!period || (period.from <= from && to <= period.to)) placed.push([p.card, month, estimate * share])
      else if (period.from <= to && from <= period.to && estimate * share > 0.5) partial.add(month)
    }
  }
  for (const [card, , v] of placed) perCard.set(card, (perCard.get(card) ?? 0) + v)
  for (const [card, month, v] of placed) if ((perCard.get(card) ?? 0) > 0.5) months.set(month, (months.get(month) ?? 0) + v)
  return { amount: [...months.values()].reduce((s, v) => s + v, 0), months, partial }
}

/** The same card spending, whatever the query: for the note saying it isn't in a narrower answer. */
function estimatedAnyway(data: LedgerData, period: AskPeriod | null): number {
  return estimates(data, emptyQuery(), period).amount
}

// ---- saying it -----------------------------------------------------------------------------------------------------

function categoryLabel(data: LedgerData, id: string): string {
  return data.categories.get(id)?.label ?? id
}

function cardLabel(data: LedgerData, id: string): string {
  const c = data.cards.find((card) => card.id === id)
  return c ? `${c.product ?? c.issuer ?? 'card'} ••${c.last4}` : 'that card'
}

const listOf = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/** "on Electricity", "to Swiggy", "with your Fake Bank ••1141 card", "by UPI": what the answer is about. */
function about(data: LedgerData, q: AskQuery): string {
  const parts: string[] = []
  if (q.categories.length) parts.push(`on ${listOf(q.categories.map((c) => categoryLabel(data, c)))}`)
  if (q.payees.length) parts.push(`to ${listOf(q.payees.map((p) => `“${p}”`))}`)
  if (q.cards.length) parts.push(`with ${listOf(q.cards.map((c) => cardLabel(data, c)))}`)
  if (q.channel === 'upi') parts.push('by UPI')
  if (q.channel === 'cards' && !q.cards.length) parts.push('with your cards')
  return parts.join(' ')
}

const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.amount, 0)
const count = (rows: Row[]) => rows.reduce((s, r) => s + r.payments, 0)
const ids = (rows: Row[]) => rows.map((r) => r.t.id)
const round2 = (n: number) => Math.round(n * 100) / 100

// ---- answering -----------------------------------------------------------------------------------------------------

/** The answer to a query, from `data` as the dashboard sees it (lib/scope.ts applied). */
export function answer(data: LedgerData, q: AskQuery): AskAnswer {
  const query = normalize(q)
  if (query.categories.includes(CARD_BILL)) return billsAnswer(data, query)
  const rows = select(data, query, query.period)
  const est = estimates(data, query, query.period)
  const matchedPayees = [...new Set(rows.map((r) => r.owner.payee))].filter((n) => query.payees.some((w) => payeeMatches(n, w))).sort()
  const notes = notesFor(data, query, rows, est)
  const base = { query, ids: ids(rows), matchedPayees, notes, lines: [] as AskLine[], amount: null as number | null, payments: count(rows) }
  const what = about(data, query)
  const when = periodPhrase(query.period)
  const total = round2(sum(rows) + est.amount)
  const n = count(rows)
  const across = n ? `, across ${plural(n, 'payment')}` : ''
  const estimatedPart = est.amount > 0.5 ? `, ${inr(est.amount)} of it estimated from card bills` : ''

  if (!rows.length && est.amount <= 0.5 && !['compare', 'trend'].includes(query.kind)) {
    const zero = ['total', 'count', 'average'].includes(query.kind) ? 0 : null // nothing spent is an answer: ₹0
    return { ...base, amount: zero, figure: null, sentence: nothingSentence(data, query), notes }
  }

  switch (query.kind) {
    case 'total': {
      if (query.money === 'in') return { ...base, amount: total, figure: inr(total), sentence: `${inr(total)} came in${what ? ` ${what.replace(/^on /, 'as ')}` : ''} ${when}${across}.` }
      if (what) return { ...base, amount: total, figure: inr(total), sentence: `${inr(total)} ${what} ${when}${across}${estimatedPart}.` }
      const parts = [n ? `${plural(n, 'payment')} counted one by one` : '', est.amount > 0.5 ? `${inr(est.amount)} estimated from card bills` : ''].filter(Boolean)
      return { ...base, amount: total, figure: inr(total), sentence: `You spent ${inr(total)} ${when}${parts.length ? `: ${parts.join(', and ')}` : ''}.` }
    }
    case 'count':
      return { ...base, amount: round2(sum(rows)), figure: plural(n, 'payment'), sentence: `${plural(n, 'payment')}${what ? ` ${what}` : ''} ${when}, ${inr(sum(rows))} in all.` }
    case 'average': {
      if (query.per === 'month') {
        const months = query.period ? monthsBetween(query.period.from, query.period.to).length : monthsWithData(data, rows).length
        const per = months ? total / months : 0
        return { ...base, amount: round2(per), figure: inr(per), sentence: `${inr(per)} a month${what ? ` ${what}` : ''} ${when}: ${inr(total)} over ${plural(months, 'month')}.` }
      }
      const per = n ? sum(rows) / n : 0
      const left = est.amount > 0.5 ? [`Card spending estimated from bills (${inr(est.amount)}) has no payments to divide by, so it isn't in this average.`] : []
      return { ...base, amount: round2(per), figure: inrExact(round2(per)), sentence: `${inrExact(round2(per))} a payment${what ? ` ${what}` : ''} ${when} (${plural(n, 'payment')}, ${inr(sum(rows))} in all).`, notes: [...left, ...notes] }
    }
    case 'top': {
      const { lines, rows: shown } = topLines(data, query, rows)
      const noun = query.by === 'category' ? 'categories' : 'payees'
      return { ...base, ids: ids(shown), payments: count(shown), figure: null, lines, sentence: `Your top ${lines.length === 1 ? (query.by === 'category' ? 'category' : 'payee') : `${lines.length} ${noun}`}${what ? ` ${what}` : ''} ${when}:` }
    }
    case 'largest': {
      const biggest = rows
        .filter((r) => r.payments)
        .sort((a, b) => b.t.amount - a.t.amount)
        .slice(0, query.limit)
      const lines = biggest
        .map((r) => ({ label: r.owner.payee === NO_NAME ? 'No payee name' : r.owner.payee, amount: r.t.amount, detail: `${dayLabel(r.day)} · ${categoryLabel(data, r.t.category)}`, day: r.day, category: categoryLabel(data, r.t.category) }))
      const one = lines.length === 1
      return {
        ...base, ids: ids(biggest), payments: biggest.length, amount: one ? lines[0].amount : null, figure: one ? inrExact(lines[0].amount) : null,
        sentence: one
          ? `Your biggest payment${what ? ` ${what}` : ''} ${when}: ${inrExact(lines[0].amount)} to ${lines[0].label}, on ${dayLabel(lines[0].day)} (${lines[0].category}).`
          : `Your ${lines.length} biggest payments${what ? ` ${what}` : ''} ${when}:`,
        lines: one ? [] : lines.map(({ label, amount, detail }) => ({ label, amount, detail })),
      }
    }
    case 'compare':
      return compareAnswer(data, query, base)
    case 'trend': {
      const period = query.period ?? spanOf(data, rows)
      if (!period) return { ...base, figure: null, sentence: nothingSentence(data, query) }
      const byMonth = new Map<string, number>()
      for (const r of rows) byMonth.set(r.day.slice(0, 7), (byMonth.get(r.day.slice(0, 7)) ?? 0) + r.amount)
      for (const [m, v] of est.months) byMonth.set(m, (byMonth.get(m) ?? 0) + v)
      const [first, last] = coverage(data)
      const lines = monthsBetween(period.from, period.to)
        .filter((m) => first && m >= first && m <= last) // a month your files don't reach isn't a ₹0 month
        .map((m) => ({ label: monthLongLabel(m), amount: round2(byMonth.get(m) ?? 0), month: m }))
      if (!lines.length) return { ...base, figure: null, sentence: nothingSentence(data, query) }
      const top = lines.reduce((a, b) => (b.amount > a.amount ? b : a), lines[0])
      const sentence = total > 0.5
        ? `${what ? `${capitalize(what)}, by month` : 'Your spending by month'} ${periodPhrase(period)}: ${inr(total)} in all, the most in ${top.label} (${inr(top.amount)}).`
        : nothingSentence(data, query)
      return { ...base, figure: null, lines: total > 0.5 ? lines : [], sentence }
    }
    case 'list': {
      const sorted = [...rows].sort((a, b) => b.day.localeCompare(a.day) || b.t.amount - a.t.amount)
      const lines = sorted.slice(0, query.limit > 5 ? query.limit : 20).map((r) => ({
        label: r.owner.payee === NO_NAME ? 'No payee name' : r.owner.payee,
        amount: r.amount,
        detail: `${dayLabel(r.day)} · ${categoryLabel(data, r.t.category)}${r.payments ? '' : ' · refund'}`,
      }))
      const more = sorted.length > lines.length ? ` (the ${lines.length} latest shown)` : ''
      return { ...base, figure: null, lines, sentence: `${plural(n, 'payment')}${what ? ` ${what}` : ''} ${when}, ${inr(sum(rows))} in all${more}:` }
    }
    case 'last': {
      const latest = [...rows].filter((r) => r.payments).sort((a, b) => b.t.at.localeCompare(a.t.at))[0]
      const who = latest.owner.payee === NO_NAME ? 'a payee with no name' : latest.owner.payee
      return {
        ...base, ids: [latest.t.id], amount: latest.t.amount, payments: 1, figure: dayLabel(latest.day),
        sentence: `Your last payment${what ? ` ${what}` : ''} ${query.period ? `${when} ` : ''}was ${inrExact(latest.t.amount)} to ${who}, on ${dayLabel(latest.day)}.`,
      }
    }
  }
}

/** The words on "Show these payments", as the list will show them: the payments counted, and the refunds taken off
 *  them (a row of their own there). */
export function showLabel(a: AskAnswer): string {
  const refunds = a.ids.length - a.payments
  const paid = a.payments === 1 ? 'this payment' : `these ${a.payments} payments`
  if (refunds <= 0) return `Show ${paid}`
  if (a.payments === 0) return `Show ${refunds === 1 ? 'this refund' : `these ${refunds} refunds`}`
  return `Show ${paid} and ${plural(refunds, 'refund')}`
}

/** A query made consistent: categories under "Money in" ask about money in; limits sensible. */
function normalize(q: AskQuery): AskQuery {
  const categories = [...new Set(q.categories)]
  // money in is what the "Money in" categories hold; asked about any other category, it's spending
  const money = categories.length ? (categories.every((c) => topOf(c) === 'income') ? 'in' : 'out') : q.money
  return { ...q, categories, payees: [...new Set(q.payees.map((p) => p.trim()).filter(Boolean))], money, limit: Math.min(Math.max(Math.round(q.limit) || 5, 1), 50) }
}

/** The biggest payees or categories, and the rows behind them (what "Show these payments" shows). */
function topLines(data: LedgerData, q: AskQuery, rows: Row[]): { lines: AskLine[]; rows: Row[] } {
  const groups = new Map<string, { amount: number; count: number }>()
  // by category: the top-level ones, or the children of the one category asked about
  const one = q.categories.length === 1 && !q.categories[0].includes('.') ? q.categories[0] : null
  const keyOf = (r: Row) => (q.by === 'category' ? (one ? r.t.category : topOf(r.t.category)) : r.owner.payee)
  for (const r of rows) {
    const g = groups.get(keyOf(r)) ?? { amount: 0, count: 0 }
    g.amount += r.amount
    g.count += r.payments
    groups.set(keyOf(r), g)
  }
  const kept = [...groups]
    .filter(([, g]) => g.amount > 0.5)
    .sort((a, b) => b[1].amount - a[1].amount)
    .slice(0, q.limit)
  const keys = new Set(kept.map(([key]) => key))
  return {
    lines: kept.map(([key, g]) => ({
      label: q.by === 'category' ? categoryLabel(data, key) : key === NO_NAME ? 'No payee name' : key,
      amount: round2(g.amount),
      detail: plural(g.count, 'payment'),
    })),
    rows: rows.filter((r) => keys.has(keyOf(r))),
  }
}

function compareAnswer(data: LedgerData, q: AskQuery, base: Omit<AskAnswer, 'figure' | 'sentence'>): AskAnswer {
  const what = about(data, q)
  if (!q.period || !q.compareTo) return { ...base, figure: null, sentence: 'Which two periods? Try “2024 vs 2025”.' }
  const side = (p: AskPeriod) => {
    const rows = select(data, q, p)
    return { rows, total: round2(sum(rows) + estimates(data, q, p).amount) }
  }
  const [a, b] = [side(q.period), side(q.compareTo)]
  const diff = round2(a.total - b.total)
  const pct = b.total > 0.5 ? Math.round((Math.abs(diff) / b.total) * 100) : null
  const change = Math.abs(diff) < 0.5 ? 'the same' : `${diff > 0 ? 'up' : 'down'} ${inr(Math.abs(diff))}${pct !== null ? ` (${pct}%)` : ''}`
  return {
    ...base,
    ids: [...ids(a.rows), ...ids(b.rows)],
    payments: count(a.rows) + count(b.rows),
    figure: null,
    lines: [
      { label: q.period.label, amount: a.total, detail: plural(count(a.rows), 'payment') },
      { label: q.compareTo.label, amount: b.total, detail: plural(count(b.rows), 'payment') },
    ],
    sentence: `${what ? capitalize(what.replace(/^on /, '')) : 'Your spending'}: ${inr(a.total)} in ${q.period.label}, against ${inr(b.total)} in ${q.compareTo.label}, ${change}.`,
  }
}

/** Card bills paid, as the Credit cards section counts them: from your payment-app history and your statements, by
 *  the day paid. */
function billsAnswer(data: LedgerData, q: AskQuery): AskAnswer {
  const bills = data.payments.filter((p) => inPeriodOf(q.period, p.at.slice(0, 10)) && (!q.cards.length || q.cards.includes(p.card)))
  const total = round2(bills.reduce((s, p) => s + p.amount, 0))
  const when = periodPhrase(q.period)
  const notes = ['Card bills are counted from your payment-app history (CRED and similar) and the payments your card statements list. They pay for purchases already counted, so they’re never added to your spending.']
  const base = { query: q, ids: [], matchedPayees: [], notes, lines: [] as AskLine[], amount: null as number | null, payments: bills.length }
  // the card as the chat names it everywhere, whichever file the bill was read from (each words a card its own way)
  const cardOf = (p: CardPayment) => (data.cards.some((c) => c.id === p.card) ? cardLabel(data, p.card) : p.cardTitle)
  if (!bills.length) return { ...base, figure: null, sentence: `No card bills paid ${when} in your files.` }
  if (q.kind === 'last') {
    const last = [...bills].sort((a, b) => b.at.localeCompare(a.at))[0]
    return { ...base, amount: last.amount, payments: 1, figure: dayLabel(last.at), sentence: `Your last card bill was ${inrExact(last.amount)} for ${cardOf(last)}, paid on ${dayLabel(last.at)}.` }
  }
  if (q.kind === 'list' || q.kind === 'largest' || q.kind === 'trend' || q.kind === 'top') {
    const lines = [...bills].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map((p) => ({ label: cardOf(p), amount: p.amount, detail: dayLabel(p.at) }))
    return { ...base, figure: null, lines, sentence: `${plural(bills.length, 'card bill')} paid ${when}, ${inr(total)} in all:` }
  }
  return { ...base, amount: total, figure: inr(total), sentence: `${inr(total)} paid in card bills ${when}, across ${plural(bills.length, 'bill')}.` }
}

function notesFor(data: LedgerData, q: AskQuery, rows: Row[], est: ReturnType<typeof estimates>): string[] {
  const notes: string[] = []
  const periods = [q.period, ...(q.kind === 'compare' ? [q.compareTo] : [])]
  const totals = ['total', 'count', 'average', 'top', 'trend', 'compare'].includes(q.kind)
  // a statement on hold: read, not counted
  const held = data.held.filter((s) => periods.some((p) => !p || ((s.periodStart ?? '') <= p.to && p.from <= (s.periodEnd ?? s.periodStart ?? ''))))
  if (held.length) notes.push(`${held.length === 1 ? 'A statement on hold isn’t' : `${held.length} statements on hold aren’t`} counted yet: check ${held.length === 1 ? 'it' : 'them'} in Your vault.`)
  // a period that starts before your files do: its total covers only part of it (the months after your last file are
  // still to come, so they need no saying)
  const [first] = coverage(data)
  if (first && periods.some((p) => p && p.from.slice(0, 7) < first)) notes.push(`Your files start in ${monthYearLabel(first)}.`)
  // card spending known only from bills: in an answer about all your spending, out of one about a category or payee
  const notBought = q.categories.length && q.categories.every((c) => ['investments', 'transfers', 'ignored', 'income'].includes(topOf(c)))
  if (totals && q.money === 'out' && q.channel !== 'upi' && est.amount <= 0.5 && (q.categories.length || q.payees.length) && !notBought) {
    const anyway = periods.reduce((s, p) => s + estimatedAnyway(data, p), 0)
    if (anyway > 0.5) notes.push(`Not included: ${inr(anyway)} of card spending known only from card bills, which have no categories.`)
  }
  if (est.partial.size) notes.push(`Card spending estimated from bills is counted by whole months; part of ${[...est.partial].sort().map(monthLongLabel).join(', ')} isn’t included.`)
  const asksInvestments = q.categories.includes(INVESTMENTS)
  // lib/scope.ts sets investments aside (`leftOut`) when you leave them out, saved or just switched
  if (asksInvestments && data.leftOut.length) notes.push('Investments are left out of your spending (your setting); this is what you put into them.')
  else if (['total', 'average', 'trend', 'compare'].includes(q.kind) && q.money === 'out' && data.leftOut.length && !q.payees.length && !q.categories.length) {
    const out = rowsOf(data.leftOut, [...data.txns, ...data.leftOut]).filter((r) => periods.some((p) => inPeriodOf(p, r.day)))
    if (sum(out) > 0.5) notes.push(`Investments are left out (your setting): ${inr(sum(out))} ${periodPhrase(q.period)}.`)
  }
  if (q.payees.length) {
    const unmatched = q.payees.filter((w) => !rows.some((r) => payeeMatches(r.owner.payee, w)))
    if (unmatched.length && rows.length) notes.push(`No payee matched ${listOf(unmatched.map((w) => `“${w}”`))}.`)
  }
  return notes
}

/** The first and last month your files reach (payments of any kind, and card bills): the months an answer can speak for. */
function coverage(data: LedgerData): [string, string] | [null, null] {
  const months = [...data.txns, ...data.leftOut].map((t) => t.at.slice(0, 7)).concat(data.payments.map((p) => p.at.slice(0, 7))).sort()
  return months.length ? [months[0], months[months.length - 1]] : [null, null]
}

/** Nothing matched: whether your files cover the period at all, so a quiet month isn't mistaken for no spending. */
function nothingSentence(data: LedgerData, q: AskQuery): string {
  const what = about(data, q)
  const onFile = data.txns.some((t) => inPeriodOf(q.period, t.at.slice(0, 10))) || data.payments.some((p) => inPeriodOf(q.period, p.at.slice(0, 10)))
  if (!onFile) return `Your files have nothing ${periodPhrase(q.period)} yet.`
  if (q.payees.length && !data.txns.some((t) => q.payees.some((w) => payeeMatches(t.payee, w)))) {
    return `No payee matches ${listOf(q.payees.map((w) => `“${w}”`))} in your files.`
  }
  return `No payments${what ? ` ${what}` : ''} ${periodPhrase(q.period)}.`
}

function monthsWithData(data: LedgerData, rows: Row[]): string[] {
  const days = rows.length ? rows.map((r) => r.day) : data.txns.map((t) => t.at.slice(0, 10))
  if (!days.length) return []
  const sorted = [...days].sort()
  return monthsBetween(sorted[0], sorted[sorted.length - 1])
}

function spanOf(data: LedgerData, rows: Row[]): AskPeriod | null {
  const months = monthsWithData(data, rows)
  return months.length ? rangePeriod(`${months[0]}-01`, lastDayOf(months[months.length - 1])) : null
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Questions to start with, from your own files: the latest year's biggest category, who you paid most, that year
 *  against the one before, and month by month. Worded so the rules read them. */
export function suggestions(data: LedgerData): string[] {
  const years = periodsIn(data)
  if (!years.length) return []
  const year = years[years.length - 1]
  const top = viewFor(data, year, null).byCategory.find((c) => c.amount > 0.5 && c.id !== 'uncategorized')
  const child = top?.children.find((c) => c.amount > 0.5 && c.id.includes('.'))
  const name = (child && child.amount >= (top?.amount ?? 0) / 2 ? child.label : top?.label)?.toLowerCase()
  return [
    name ? `How much on ${name} in ${year}?` : `How much did I spend in ${year}?`,
    `Top 5 payees in ${year}`,
    years.includes(year - 1) ? `Compare ${year - 1} and ${year}` : `Biggest payments in ${year}`,
    `${name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}` : 'Spending'} by month in ${year}`,
  ]
}
