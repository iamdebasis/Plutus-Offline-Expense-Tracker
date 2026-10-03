// The dashboard's money adds up: UPI + cards = Total spend, each card's line = its figure, every year, investments
// counted or left out. On fake ledgers only (tests/fixtures.ts).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cardFigures, cardTrends, cardsOnly } from '../src/lib/cards'
import { periodsIn, upiOnly, viewFor, type LedgerData } from '../src/lib/ledger'
import { scoped } from '../src/lib/scope'
import { totalSpendFor } from '../src/lib/totals'
import { bill, byNumber, card, ledger, onUpi, statement, txn } from './fixtures'

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.01, `${what}: ${a.toFixed(2)} vs ${b.toFixed(2)}`)

/** Everything the dashboard shows must agree, whatever the year and the investments switch. */
function holds(data: LedgerData) {
  for (const counting of [true, false]) {
    const d = scoped(data, counting)
    for (const period of [...periodsIn(data), 'all' as const]) {
      const tag = `${period}${counting ? '' : ', investments left out'}`
      const all = viewFor(d, period, null)
      const totals = totalSpendFor(d, all)
      const upi = viewFor(upiOnly(d), period, null).totals.spent
      const cards = cardFigures(viewFor(cardsOnly(d, null), period, null), all, null)
      near(upi + cards.itemized + cards.estimated, totals.total, `${tag}: UPI + cards = Total spend`)
      near(upi, totals.upi, `${tag}: the UPI section = Total spend's UPI`)

      const { months, trends } = cardTrends(d, period, null)
      let lines = 0
      for (const t of trends) {
        const one = cardFigures(viewFor(cardsOnly(d, t.id), period, null), all, t.id)
        near(t.amount, one.itemized + one.estimated, `${tag}: ${t.id}'s line = its figure`)
        lines += t.amount
      }
      near(lines, cards.itemized + cards.estimated, `${tag}: the card lines add up to all cards`)
      const byMonth = viewFor(cardsOnly(d, null), period, null)
      months.forEach((k, i) => {
        const shown = (byMonth.months.find((m) => m.key === k)?.spent ?? 0) + byMonth.estimatedBills.reduce((s, b) => s + (b.months.get(k) ?? 0), 0)
        near(trends.reduce((s, t) => s + (t.values[i] ?? 0), 0), shown, `${tag}: ${k}, the lines = the month`)
      })
    }
  }
}

const RUPAY = card('card-fake-1141', '1141', 'RuPay')
const VISA = card('card-fake-2222', '2222', 'Visa')

describe('total spend', () => {
  test('a bill whose cycle crosses the new year counts in both years, by its days', () => {
    const sweets = txn('2026-12-20', 1000, onUpi(RUPAY.id))
    const data = ledger({
      cards: [RUPAY],
      txns: [sweets, txn('2027-01-03', 700)],
      // 13 Dec – 12 Jan: 19 days of it in 2026, 12 in 2027; the server took off what was paid on UPI in it
      payments: [bill('across', RUPAY.id, '2027-01-25', 10_000, { paysFrom: '2026-12-13', paysTo: '2027-01-12', cycle: 'card', counted: 1000, estimate: 9000 })],
    })
    holds(data)
    const est = (period: number) => cardFigures(viewFor(cardsOnly(data, null), period, null), viewFor(data, period, null), null).estimated
    near(est(2026), (9000 * 19) / 31, 'December')
    near(est(2027), (9000 * 12) / 31, 'January')
  })

  test('investments paid by card or on UPI leave every figure when left out, and come back when counted', () => {
    const insured = txn('2026-11-20', 3000, { ...byNumber(RUPAY.id), category: 'investments.insurance' })
    const sip = txn('2026-12-05', 2000, { ...onUpi(RUPAY.id), category: 'investments.sip' })
    const data = ledger({ cards: [RUPAY], txns: [insured, sip, txn('2026-11-25', 4000, byNumber(RUPAY.id))], statements: [statement('u_stmt', RUPAY.id, '2026-11-13', '2026-12-12')] })
    holds(data)
    const cardsIn = (counting: boolean) => {
      const d = scoped(data, counting)
      return cardFigures(viewFor(cardsOnly(d, null), 2026, null), viewFor(d, 2026, null), null)
    }
    near(cardsIn(true).itemized, 7000, 'counted')
    near(cardsIn(false).itemized, 4000, 'left out')
    near(cardsIn(false).viaUpi, 0, 'the SIP on UPI is left out too')
  })

  test('a refund back to the card goes with the UPI payment it refunds', () => {
    const sweets = txn('2026-12-20', 1000, onUpi(RUPAY.id))
    const refund = txn('2026-12-28', 400, { ...byNumber(RUPAY.id), direction: 'credit', kind: 'refund', refundOf: sweets.id })
    const data = ledger({ cards: [RUPAY], txns: [sweets, refund] })
    holds(data)
    near(viewFor(upiOnly(data), 2026, null).totals.spent, 600, 'UPI, after the refund')
  })

  test('a bill that pays a statement you added adds nothing; one that pays no statement is its estimate', () => {
    const data = ledger({
      cards: [RUPAY, VISA],
      txns: [txn('2026-08-20', 2500, byNumber(RUPAY.id)), txn('2026-09-02', 500, onUpi(RUPAY.id)), txn('2026-08-10', 800, byNumber(VISA.id, 'u_export'))],
      statements: [statement('u_stmt', RUPAY.id, '2026-08-13', '2026-09-12'), statement('u_export', VISA.id, '2026-07-01', '2026-09-30', 'export')],
      payments: [
        bill('covered', RUPAY.id, '2026-09-25', 2500, { coveredBy: 'u_stmt', paysFrom: '2026-08-13', paysTo: '2026-09-12', cycle: 'statement', estimate: 0 }),
        bill('estimated', RUPAY.id, '2026-10-25', 3000, { paysFrom: '2026-09-13', paysTo: '2026-10-12', cycle: 'card', counted: 0, estimate: 3000 }),
        bill('guessed', VISA.id, '2026-11-05', 1200, { paysFrom: '2026-09-27', paysTo: '2026-10-26', cycle: 'guess', counted: 0, estimate: 1200 }),
      ],
    })
    holds(data)
    const totals = totalSpendFor(data, viewFor(data, 2026, null))
    near(totals.cards, 3300, 'read one by one')
    near(totals.cardPurchases, 4200, 'estimated')
    near(totals.coveredBills, 2500, 'bills that pay a statement you added')
    near(totals.upi, 500, 'paid with the card on UPI')
  })

  test('only UPI, only cards, and nothing at all', () => {
    holds(ledger({ txns: [txn('2026-03-01', 120), txn('2026-04-01', 80, { category: 'transfers.p2p' })] }))
    holds(ledger({ cards: [VISA], txns: [txn('2026-03-01', 99, byNumber(VISA.id))], statements: [statement('u_stmt', VISA.id, '2026-02-13', '2026-03-12')] }))
    holds(ledger({}))
  })
})
