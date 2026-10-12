// What Total spend shows for a category you tap, or with nothing tapped, is the dashboard's own numbers: a category's
// shops add up to its figure in Where it went, Ask Plutus names the same top payees and biggest payments, a card's
// bills add up to its estimate, and the highlights are Month by month's figures. Every year, investments counted or
// left out. Fake ledgers only.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { answer, emptyQuery, yearPeriod, type AskQuery } from '../src/lib/ask'
import { biggestIn, cardEstimates, highlights, namesWaiting, shopsIn, topShops, UNCATEGORIZED } from '../src/lib/focus'
import { NO_NAME, periodsIn, viewFor, type LedgerData } from '../src/lib/ledger'
import { scoped } from '../src/lib/scope'
import { CARD_PURCHASES, monthlyTrends, totalSpendFor } from '../src/lib/totals'
import { bill, byNumber, card, ledger, onUpi, statement, txn } from './fixtures'

const near = (a: number | null | undefined, b: number, what: string) => assert.ok(a != null && Math.abs(a - b) < 0.01, `${what}: ${a} vs ${b.toFixed(2)}`)

const categories = new Map(
  [
    ['groceries', 'Groceries', null], ['groceries.quick_commerce', 'Quick commerce', 'groceries'], ['groceries.local', 'Local stores', 'groceries'],
    ['food', 'Food & Dining', null], ['food.delivery', 'Food delivery', 'food'],
    ['shopping', 'Shopping', null], ['shopping.online', 'Online shopping', 'shopping'],
    ['uncategorized', 'Uncategorized', null], ['investments', 'Investments', null],
    ['transfers', 'Transfers', null], ['transfers.card_bill', 'Credit card bills', 'transfers'],
  ].map(([id, label, parent]) => [id!, { id: id!, label: label!, parent, excludeFromSpend: false }]),
)

const CARD = card('fakebank-1141', '1141')

/** Two years. 2025 has UPI history only (January to March). 2026 has UPI too, and the card: its statement for
 *  February, and a bill estimating March. One shop spelt two ways, with a refund; payees waiting in Uncategorized,
 *  one of them with no name; an investment. */
function fake(): LedgerData {
  const big = txn('2026-01-20', 900, { id: 'big', payee: 'FAKEMART LIMITED', shop: 'FAKEMART LIMITED', category: 'groceries.local' })
  return ledger({
    categories,
    cards: [CARD],
    txns: [
      txn('2025-01-05', 300, { payee: 'FAKEMART LIMITED', category: 'groceries.local' }),
      txn('2025-02-05', 250, { payee: 'Fake Quick App', category: 'groceries.quick_commerce' }),
      txn('2025-03-05', 400, { payee: 'Fake Food App', category: 'food.delivery' }),
      big,
      txn('2026-01-22', 120, { payee: 'Fakemart', shop: 'FAKEMART LIMITED', category: 'groceries.local' }),
      txn('2026-02-02', 100, { id: 'back', direction: 'credit', kind: 'refund', refundOf: 'big', payee: 'FAKEMART REFUNDS', category: 'groceries.local' }),
      txn('2026-01-25', 640, { payee: 'Fake Quick App', category: 'groceries.quick_commerce' }),
      txn('2026-02-11', 560, { payee: 'Fake Quick App', category: 'groceries.quick_commerce' }),
      txn('2026-02-15', 2200, { payee: 'FAKE GADGETS', category: 'shopping.online', ...byNumber(CARD.id) }),
      txn('2026-03-03', 200, { payee: 'Fake Food App', category: 'food.delivery', ...onUpi(CARD.id) }),
      txn('2026-03-09', 700, { payee: 'Fake Corner Store', category: UNCATEGORIZED, needsReview: true }),
      txn('2025-03-19', 90, { payee: 'Fake Corner Store', category: UNCATEGORIZED, needsReview: true }),
      txn('2026-03-12', 330, { payee: NO_NAME, category: UNCATEGORIZED, needsReview: true }),
      txn('2026-03-20', 5000, { payee: 'FAKE MUTUAL FUND', category: 'investments' }),
    ],
    payments: [bill('est', CARD.id, '2026-04-05', 3000, { paysFrom: '2026-03-01', paysTo: '2026-03-31', cycle: 'card', counted: 200, estimate: 2800 })],
    statements: [statement('u_stmt', CARD.id, '2026-02-01', '2026-02-28')],
  })
}

const ask = (data: LedgerData, over: Partial<AskQuery>) => answer(data, { ...emptyQuery(), ...over })

describe('a category you tap: its shops and biggest payments are its figure', () => {
  for (const counting of [true, false]) {
    const data = scoped(fake(), counting)
    for (const period of [...periodsIn(data), 'all' as const]) {
      const tag = `${period}${counting ? '' : ', investments left out'}`
      const view = viewFor(data, period, null)
      const totals = totalSpendFor(data, view)
      const rows = totals.byCategory.filter((c) => c.id !== CARD_PURCHASES).flatMap((c) => [c, ...c.children])

      test(`${tag}: every category's shops add up to its figure in Where it went, payments and all`, () => {
        assert.ok(rows.length >= 4)
        for (const c of rows) {
          const shops = shopsIn(data, view, c.id)
          near(shops.reduce((s, x) => s + x.amount, 0), c.amount, `${c.id}: its shops`)
          for (const n of [1, 2, 6]) {
            const { shown, rest } = topShops(shops, n)
            near(shown.reduce((s, x) => s + x.amount, 0) + rest.amount, c.amount, `${c.id}: its top ${n} and the rest`)
          }
          assert.equal(shops.reduce((s, x) => s + x.payments, 0), c.count, `${c.id}: payments`)
        }
      })

      test(`${tag}: Ask Plutus names the same top payees and the same biggest payments`, () => {
        const p = period === 'all' ? null : yearPeriod(period)
        for (const c of rows) {
          const shops = shopsIn(data, view, c.id).filter((s) => s.amount > 0.5)
          const top = ask(data, { kind: 'top', by: 'payee', categories: [c.id], period: p, limit: 50 })
          assert.deepEqual(top.lines.map((l) => [l.label, l.amount]), shops.map((s) => [s.shop === NO_NAME ? 'No payee name' : s.shop, Math.round(s.amount * 100) / 100]), `${c.id}: top payees`)
          const largest = ask(data, { kind: 'largest', categories: [c.id], period: p, limit: 5 })
          const amounts = largest.lines.length ? largest.lines.map((l) => l.amount) : [largest.amount]
          assert.deepEqual(biggestIn(data, view, c.id).map((x) => x.amount), amounts, `${c.id}: biggest payments`)
        }
      })

      test(`${tag}: each card's bills add up to its estimate in Where it went`, () => {
        const cards = cardEstimates(data, view, totals, period)
        const where = totals.byCategory.find((c) => c.id === CARD_PURCHASES)
        near(cards.reduce((s, c) => s + c.amount, 0), where?.amount ?? 0, 'card purchases')
        for (const c of cards) {
          near(c.bills.reduce((s, b) => s + b.estimate, 0), c.amount, `${c.card}: its bills`)
          near(where!.children.find((k) => k.id === `${CARD_PURCHASES}.${c.card}`)!.amount, c.amount, `${c.card}: its row`)
        }
      })

      test(`${tag}: the busiest month is Month by month's biggest, the biggest payment and top shop the period's`, () => {
        const h = highlights(data, view, totals, period)
        const { months, trends } = monthlyTrends(data, view, totals)
        const together = months.map((m, i) => [m, trends.reduce((s, t) => s + (t.values[i] ?? 0), 0)] as const)
        const most = together.reduce((a, b) => (b[1] > a[1] ? b : a))
        assert.equal(h.busiest?.month, most[0])
        near(h.busiest?.amount, most[1], 'busiest month')
        assert.equal(h.biggest?.amount, Math.max(...view.txns.filter((t) => t.direction === 'debit' && t.category !== 'transfers.card_bill').map((t) => t.amount)))
        assert.equal(h.topShop?.shop, shopsIn(data, view, null).find((s) => s.shop !== NO_NAME)?.shop)
      })
    }
  }
})

describe('one shop, however its files spell it', () => {
  const data = fake()
  const view = viewFor(data, 2026, null)

  test('both spellings are one shop, its refund taken off it, its spellings kept', () => {
    const [shop] = shopsIn(data, view, 'groceries.local')
    assert.deepEqual([shop.shop, shop.amount, shop.payments, shop.names], ['FAKEMART LIMITED', 920, 2, ['FAKEMART LIMITED', 'Fakemart']])
  })

  test('"Who you paid most" and Ask Plutus count it once too', () => {
    assert.equal(view.topPayees.filter((p) => p.payee === 'FAKEMART LIMITED').length, 1)
    near(view.topPayees.find((p) => p.payee === 'FAKEMART LIMITED')?.amount, 920, 'who you paid most')
    near(ask(data, { payees: ['FAKEMART LIMITED'], period: yearPeriod(2026) }).amount, 920, 'asked by its name')
    near(ask(data, { payees: ['fakemart'], period: yearPeriod(2026) }).amount, 920, 'asked by a word of it')
  })

  test('a payment as big as it was paid, with what came back on it', () => {
    const [first] = biggestIn(data, view, 'groceries')
    assert.deepEqual([first.id, first.amount, first.refunded], ['big', 900, 100])
  })

  test("one answer for a shop waiting in Uncategorized files each of its spellings, every year; never the payments with no name", () => {
    assert.deepEqual(namesWaiting(data.txns, 'Fake Corner Store'), ['Fake Corner Store'])
    assert.deepEqual(namesWaiting(data.txns, NO_NAME), [])
    assert.deepEqual(shopsIn(data, view, UNCATEGORIZED).map((s) => [s.shop, s.amount]), [['Fake Corner Store', 700], [NO_NAME, 330]])
  })
})

describe('the top payees shown, and the rest in one line', () => {
  test('the rest says how many more it spent at and how much between them; a shop refunded in full is in neither count', () => {
    const order = txn('2026-05-01', 400, { id: 'whole', payee: 'Fake Shop Z', category: 'shopping.online' })
    const data = ledger({
      categories,
      txns: [
        ...[900, 800, 700, 600, 500, 400, 300, 200].map((amount, i) => txn('2026-05-02', amount, { payee: `Fake Shop ${i}`, category: 'shopping.online' })),
        order,
        txn('2026-05-03', 400, { direction: 'credit', kind: 'refund', refundOf: 'whole', payee: 'Fake Shop Z', category: 'shopping.online' }),
      ],
    })
    const view = viewFor(data, 2026, null)
    const { shown, rest } = topShops(shopsIn(data, view, 'shopping'), 6)
    assert.deepEqual(shown.map((s) => s.amount), [900, 800, 700, 600, 500, 400])
    assert.deepEqual(rest, { count: 2, amount: 500 })
  })
})

describe('highlights', () => {
  test('this year against last, only over the months both years have the same kinds of file for', () => {
    const data = fake()
    const view = viewFor(data, 2026, null)
    const h = highlights(data, view, totalSpendFor(data, view), 2026)
    // January: UPI only in both years (the refund counts there, with its payment). February (a card statement) and
    // March (a card bill) have the card in 2026 only.
    assert.deepEqual(h.before, { year: 2025, months: 1, now: 900 - 100 + 120 + 640, then: 300 })
  })

  test('none for the first year, or across all years', () => {
    const data = fake()
    for (const period of [2025, 'all'] as const) {
      const view = viewFor(data, period, null)
      assert.equal(highlights(data, view, totalSpendFor(data, view), period).before, null, String(period))
    }
  })

  test('the one thing to do: the bigger of what waits for a category and what is only estimated from bills', () => {
    const data = fake()
    const view = viewFor(data, 2026, null)
    const totals = totalSpendFor(data, view)
    assert.deepEqual(highlights(data, view, totals, 2026).action, { kind: 'estimated', amount: totals.cardPurchases, cards: 1 })
    const noBill = ledger({ ...data, payments: [] })
    const v2 = viewFor(noBill, 2026, null)
    assert.deepEqual(highlights(noBill, v2, totalSpendFor(noBill, v2), 2026).action, { kind: 'uncategorized', amount: 1030, shops: 2 })
  })

  test('with no card in your files at all, adding one', () => {
    const data = ledger({ categories, txns: [txn('2026-01-05', 300, { payee: 'Fake Quick App', category: 'groceries.quick_commerce' })] })
    const view = viewFor(data, 2026, null)
    assert.deepEqual(highlights(data, view, totalSpendFor(data, view), 2026).action, { kind: 'no-cards' })
  })
})
