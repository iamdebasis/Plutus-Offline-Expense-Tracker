// "Ask Plutus" answers with the dashboard's own numbers: every total a question can ask equals what the dashboard
// shows for it, every year, with investments counted or left out. Then what an answer says about what it leaves out.
// Fake ledgers only.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { answer, emptyQuery, fyPeriod, monthPeriod, payeeMatches, rangePeriod, showLabel, suggestions, yearPeriod, type AskQuery } from '../src/lib/ask'
import { readQuestion } from '../src/lib/askRules'
import { periodsIn, viewFor, type LedgerData } from '../src/lib/ledger'
import { scoped } from '../src/lib/scope'
import { totalSpendFor } from '../src/lib/totals'
import type { PeriodKey } from '../src/lib/periods'
import { bill, byNumber, card, ledger, onUpi, statement, txn } from './fixtures'

const near = (a: number | null, b: number, what: string) => assert.ok(a !== null && Math.abs(a - b) < 0.01, `${what}: ${a} vs ${b.toFixed(2)}`)

const categories = new Map(
  [
    ['bills', 'Bills & Utilities', null], ['bills.electricity', 'Electricity', 'bills'], ['bills.mobile', 'Mobile', 'bills'],
    ['food', 'Food & Dining', null], ['food.delivery', 'Food delivery', 'food'],
    ['shopping', 'Shopping', null], ['shopping.online', 'Online shopping', 'shopping'],
    ['investments', 'Investments', null], ['transfers', 'Transfers', null], ['transfers.p2p', 'To people', 'transfers'],
    ['transfers.card_bill', 'Credit card bills', 'transfers'], ['income', 'Money in', null], ['income.received', 'Received', 'income'],
    ['income.cashback', 'Cashback & rewards', 'income'], ['income.refund', 'Refunds', 'income'], ['ignored', 'Ignored', null],
  ].map(([id, label, parent]) => [id!, { id: id!, label: label!, parent, excludeFromSpend: false }]),
)

const CARD = card('fakebank-1141', '1141')

/** Two years of everything a question can touch: UPI and card purchases in several categories, a person, a refund
 *  taken off its payment across the new year, money in, cashback, an investment, an ignored transfer, both sides of
 *  a card bill, and a bill whose cycle no statement covers (estimated, spread over two months). */
function fake(): LedgerData {
  const order = txn('2025-12-28', 1200, { id: 'order', payee: 'FAKE FOOD APP', category: 'food.delivery' })
  return ledger({
    categories,
    cards: [CARD],
    txns: [
      txn('2025-01-10', 1650, { payee: 'FAKE POWER CO', category: 'bills.electricity' }),
      txn('2025-02-10', 1720.5, { payee: 'FAKE POWER CO', category: 'bills.electricity' }),
      txn('2026-01-10', 1810, { payee: 'FAKE POWER CO', category: 'bills.electricity' }),
      txn('2025-03-03', 299, { payee: 'FAKE MOBILE', category: 'bills.mobile', ...onUpi(CARD.id) }),
      order,
      txn('2026-01-04', 400, { id: 'refund', direction: 'credit', kind: 'refund', payee: 'FAKE FOOD APP', category: 'food.delivery', refundOf: 'order' }),
      txn('2026-02-14', 650, { payee: 'FAKE FOOD APP', category: 'food.delivery' }),
      txn('2025-06-20', 4999, { payee: 'FAKEMART ONLINE', category: 'shopping.online', ...byNumber(CARD.id) }),
      txn('2026-03-02', 2500, { payee: 'BIGBASKET FAKE', category: 'shopping.online', ...byNumber(CARD.id) }),
      txn('2025-07-01', 3000, { payee: 'Mr Fake Payee', category: 'transfers.p2p' }),
      txn('2025-08-01', 50000, { direction: 'credit', kind: 'income', payee: 'FAKE EMPLOYER', category: 'income.received' }),
      txn('2025-08-15', 150, { direction: 'credit', kind: 'cashback', payee: 'FAKE BANK CASHBACK', category: 'income.cashback' }),
      txn('2025-09-05', 5000, { payee: 'FAKE MUTUAL FUND', category: 'investments' }),
      txn('2025-09-06', 20000, { payee: 'Bank Account XXXX1111', category: 'ignored', kind: 'transfer' }),
      txn('2025-10-02', 6000, { payee: 'CRED', category: 'transfers.card_bill', kind: 'bill_payment' }),
      txn('2025-10-03', 6000, { direction: 'credit', kind: 'bill_payment', payee: 'PAYMENT RECEIVED - THANK YOU', category: 'transfers.card_bill', ...byNumber(CARD.id) }),
    ],
    payments: [
      bill('estimated', CARD.id, '2025-11-25', 9000, { paysFrom: '2025-10-13', paysTo: '2025-11-12', cycle: 'card', counted: 0, estimate: 9000 }),
      bill('covered', CARD.id, '2025-07-25', 4999, { coveredBy: 'u_stmt', paysFrom: '2025-06-13', paysTo: '2025-07-12', cycle: 'statement', estimate: 0 }),
    ],
    statements: [statement('u_stmt', CARD.id, '2025-06-13', '2025-07-12')],
  })
}

const ask = (data: LedgerData, over: Partial<AskQuery>) => answer(data, { ...emptyQuery(), ...over })
const asPeriod = (p: PeriodKey) => (p === 'all' ? null : yearPeriod(p))

describe('the same numbers as the dashboard', () => {
  for (const counting of [true, false]) {
    const data = scoped(fake(), counting)
    for (const p of [...periodsIn(data), 'all' as const]) {
      const tag = `${p}${counting ? '' : ', investments left out'}`
      const view = viewFor(data, p, null)
      const totals = totalSpendFor(data, view)
      const period = asPeriod(p)

      test(`${tag}: all spending = Total spend; UPI and cards = their sections`, () => {
        near(ask(data, { period }).amount, totals.total, 'total')
        near(ask(data, { period, channel: 'upi' }).amount, totals.upi, 'UPI')
        near(ask(data, { period, channel: 'cards' }).amount, totals.cards + totals.cardPurchases, 'cards, estimates included')
        near(ask(data, { period, kind: 'trend' }).lines.reduce((s, l) => s + l.amount, 0), totals.total, 'the months add up')
      })

      test(`${tag}: every category and sub-category, as the dashboard lists it`, () => {
        for (const top of view.byCategory) {
          const a = ask(data, { period, categories: [top.id] })
          near(a.amount, top.amount, top.id)
          assert.equal(a.payments, top.count, `${top.id}: payments`)
          for (const child of top.children) near(ask(data, { period, categories: [child.id] }).amount, child.amount, child.id)
        }
      })

      test(`${tag}: every payee, as "Who you paid most" lists them`, () => {
        for (const payee of view.topPayees) {
          const a = ask(data, { period, payees: [payee.payee] })
          near(a.amount, payee.amount, payee.payee)
          assert.equal(a.payments, payee.count, `${payee.payee}: payments`)
        }
      })

      test(`${tag}: money in, and how many payments`, () => {
        near(ask(data, { period, money: 'in' }).amount, view.totals.in + view.totals.cashback, 'money in')
        assert.equal(ask(data, { period, kind: 'count' }).payments, view.counts.spent, 'payments counted')
      })
    }
  }
})

describe('what an answer says', () => {
  const data = fake()

  test('a refund counts on its payment’s day: January’s refund lowers December', () => {
    near(ask(data, { period: monthPeriod('2025-12'), categories: ['food.delivery'] }).amount, 800, 'December, net of the refund')
    near(ask(data, { period: monthPeriod('2026-01'), categories: ['food.delivery'] }).amount, 0, 'nothing in January')
  })

  test('a total says what it adds up, and card spending from bills only in an answer about all spending', () => {
    const all = ask(data, { period: yearPeriod(2025) })
    assert.match(all.sentence, /^You spent ₹[\d,]+ in 2025: \d+ payments counted one by one, and ₹9,000 estimated from card bills\.$/)
    const power = ask(data, { period: yearPeriod(2025), categories: ['bills.electricity'] })
    assert.equal(power.sentence, '₹3,371 on Electricity in 2025, across 2 payments.')
    assert.equal(power.figure, '₹3,371')
    assert.ok(power.notes.includes('Not included: ₹9,000 of card spending known only from card bills, which have no categories.'))
    assert.deepEqual(power.ids.length, 2)
  })

  test('investments left out: not in your spending, but a question about them is answered', () => {
    const out = scoped(data, false)
    const spent = ask(out, { period: yearPeriod(2025) })
    assert.ok(spent.notes.includes('Investments are left out (your setting): ₹5,000 in 2025.'))
    const invested = ask(out, { period: yearPeriod(2025), categories: ['investments'] })
    near(invested.amount, 5000, 'invested')
    assert.deepEqual(invested.notes, ['Investments are left out of your spending (your setting); this is what you put into them.'])
  })

  test('card bills are never spending: asked about, they come from the payment-app history', () => {
    const bills = ask(data, { period: yearPeriod(2025), categories: ['transfers.card_bill'] })
    near(bills.amount, 13999, 'bills paid in 2025')
    assert.match(bills.notes[0], /never added to your spending/)
    assert.ok(!ask(data, { period: yearPeriod(2025) }).ids.some((id) => data.txns.find((t) => t.id === id)?.category === 'transfers.card_bill'))
  })

  test('nothing on file, no such payee, and no payments are different answers', () => {
    assert.equal(ask(data, { period: yearPeriod(2019) }).sentence, 'Your files have nothing in 2019 yet.')
    assert.equal(ask(data, { payees: ['nowhere'] }).sentence, 'No payee matches “nowhere” in your files.')
    assert.equal(ask(data, { period: yearPeriod(2026), categories: ['bills.mobile'] }).sentence, 'No payments on Mobile in 2026.')
  })

  test('a statement on hold is said, never counted', () => {
    const held = { ...data, held: [{ ...statement('u_held', CARD.id, '2026-02-13', '2026-03-12'), status: 'on_hold' as const }] }
    assert.ok(ask(held, { period: yearPeriod(2026) }).notes.includes('A statement on hold isn’t counted yet: check it in Your vault.'))
    assert.ok(!ask(held, { period: yearPeriod(2025) }).notes.some((n) => n.includes('on hold')))
  })

  test('top, largest, last, list, compare, trend and averages', () => {
    const top = ask(data, { kind: 'top', period: yearPeriod(2025), limit: 2 })
    assert.deepEqual(top.lines.map((l) => [l.label, l.amount]), [['FAKE MUTUAL FUND', 5000], ['FAKEMART ONLINE', 4999]])
    assert.equal(ask(data, { kind: 'top', by: 'category', period: yearPeriod(2025) }).lines[0].label, 'Investments')
    assert.equal(ask(scoped(data, false), { kind: 'top', by: 'category', period: yearPeriod(2025) }).lines[0].label, 'Shopping')
    assert.equal(ask(data, { kind: 'largest', limit: 1, period: yearPeriod(2025) }).figure, '₹5,000') // never money in or a transfer
    assert.equal(ask(scoped(data, false), { kind: 'largest', limit: 1, period: yearPeriod(2025) }).figure, '₹4,999')
    // "Show these payments" shows what the answer lists: the top payees' payments, the biggest payments themselves
    const idsOf = (...payees: string[]) => data.txns.filter((t) => payees.includes(t.payee) && t.at.startsWith('2025')).map((t) => t.id).sort()
    assert.deepEqual([...top.ids].sort(), idsOf('FAKE MUTUAL FUND', 'FAKEMART ONLINE'))
    assert.equal(top.payments, 2)
    const biggest = ask(data, { kind: 'largest', limit: 1, period: yearPeriod(2025) })
    assert.deepEqual(biggest.ids, idsOf('FAKE MUTUAL FUND'))
    const topCategory = ask(scoped(data, false), { kind: 'top', by: 'category', limit: 1, period: yearPeriod(2025) })
    // the button says what the list will show: a refund taken off its payment is a row of its own there
    assert.equal(showLabel(ask(data, { categories: ['food.delivery'], period: yearPeriod(2025) })), 'Show this payment and 1 refund')
    assert.equal(showLabel(ask(data, { categories: ['bills.electricity'], period: yearPeriod(2025) })), 'Show these 2 payments')
    assert.equal(showLabel(biggest), 'Show this payment')
    assert.deepEqual([...topCategory.ids].sort(), idsOf('FAKEMART ONLINE'))
    const last = ask(data, { kind: 'last', payees: ['fake power'] })
    assert.equal(last.sentence, 'Your last payment to “fake power” was ₹1,810 to FAKE POWER CO, on 10 Jan 2026.')
    const list = ask(data, { kind: 'list', categories: ['bills.electricity'] })
    assert.deepEqual(list.lines.map((l) => l.amount), [1810, 1720.5, 1650])
    const compare = ask(data, { kind: 'compare', categories: ['bills.electricity'], period: yearPeriod(2026), compareTo: yearPeriod(2025) })
    assert.equal(compare.sentence, 'Electricity: ₹1,810 in 2026, against ₹3,371 in 2025, down ₹1,561 (46%).')
    const trend = ask(data, { kind: 'trend', categories: ['bills.electricity'], period: yearPeriod(2025) })
    assert.equal(trend.lines.length, 12)
    // 2026: the files end in March, so the months after it aren't shown as ₹0, and the answer says where they end
    const later = ask(data, { kind: 'trend', categories: ['bills.electricity'], period: yearPeriod(2026) })
    assert.deepEqual(later.lines.map((l) => l.month), ['2026-01', '2026-02', '2026-03'])
    assert.ok(ask(data, { kind: 'total', period: yearPeriod(2024) }).sentence.startsWith('Your files have nothing in 2024'))
    assert.ok(ask(data, { kind: 'total', period: rangePeriod('2024-10-01', '2025-03-31') }).notes.includes('Your files start in Jan 2025.'))
    assert.match(trend.sentence, /the most in February 2025 \(₹1,721\)/)
    near(ask(data, { kind: 'average', categories: ['bills.electricity'], period: yearPeriod(2025) }).amount, 1685.25, 'per payment')
    near(ask(data, { kind: 'average', per: 'month', categories: ['bills.electricity'], period: yearPeriod(2025) }).amount, 3370.5 / 12, 'per month')
  })

  test('card spending from bills by whole months: a range cutting a cycle says so', () => {
    const part = ask(data, { period: rangePeriod('2025-10-01', '2025-10-20') })
    assert.ok(part.notes.some((n) => n.includes('counted by whole months; part of October 2025')))
  })
})

describe('periods and names', () => {
  test('years, months, financial years and ranges', () => {
    assert.deepEqual(yearPeriod(2025), { from: '2025-01-01', to: '2025-12-31', label: '2025' })
    assert.deepEqual(monthPeriod('2024-02'), { from: '2024-02-01', to: '2024-02-29', label: 'February 2024' })
    assert.deepEqual(fyPeriod(2024), { from: '2024-04-01', to: '2025-03-31', label: 'FY 2024–25' })
    assert.equal(rangePeriod('2025-11-01', '2026-02-28').label, 'Nov 2025 – Feb 2026')
    assert.equal(rangePeriod('2025-01-01', '2025-12-31').label, '2025')
  })

  test('a payee is found by a word of its name, never by part of a word', () => {
    assert.ok(payeeMatches('SWIGGY BANGALORE', 'swiggy'))
    assert.ok(payeeMatches('SWIGGY BANGALORE', 'swig'))
    assert.ok(payeeMatches('BIG BASKET FAKE', 'bigbasket'))
    assert.ok(!payeeMatches('MOTOROLA FAKE', 'ola'))
    assert.ok(!payeeMatches('Unknown', 'unknown'))
  })
})

describe('questions to start with', () => {
  test('come from your own files, and the rules read every one of them for sure', () => {
    const data = fake()
    const starters = suggestions(data)
    assert.deepEqual(starters, ['How much on online shopping in 2026?', 'Top 5 payees in 2026', 'Compare 2025 and 2026', 'Online shopping by month in 2026'])
    const ctx = { categories: data.categories, payees: data.txns.map((t) => t.payee), cards: data.cards, today: '2026-10-07' }
    const kinds = starters.map((q) => {
      const r = readQuestion(q, ctx)
      assert.ok(r?.sure, `${q}: not sure (${r?.unknown.join(', ')})`)
      return r.query.kind
    })
    assert.deepEqual(kinds, ['total', 'top', 'compare', 'trend'])
  })
})
