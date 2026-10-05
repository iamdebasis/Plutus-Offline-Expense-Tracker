// How payments are bucketed, placed in months, and told apart by card. Fake data only.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { bucketOf, cardsOnUpi, countsAs, cycleShares, describeSource, isCardBill, monthShares, rowTag, statementMonths, viewFor } from '../src/lib/ledger'
import { inr, inrExact } from '../src/lib/money'
import type { Transaction } from '../src/types'
import { bill, card, ledger, statement, txn } from './fixtures'

describe('months', () => {
  test('a span of days is shared out by the days each month holds', () => {
    const shares = monthShares('2026-08-13', '2026-09-12')
    assert.deepEqual(shares.map(([k]) => k), ['2026-08', '2026-09'])
    assert.ok(Math.abs(shares[0][1] - 19 / 31) < 1e-9 && Math.abs(shares[1][1] - 12 / 31) < 1e-9)
    assert.deepEqual(monthShares('2026-12-20', '2027-01-05').map(([k]) => k), ['2026-12', '2027-01'])
    assert.deepEqual(monthShares('2026-02-01', '2026-01-01'), [])
  })

  test('a bill counts over the cycle it paid; one read before cycles were worked out, in the month it was paid', () => {
    const placed = bill('b', 'c', '2026-10-25', 100, { paysFrom: '2026-09-13', paysTo: '2026-10-12' })
    assert.deepEqual(cycleShares(placed).map(([k]) => k), ['2026-09', '2026-10'])
    assert.deepEqual(cycleShares(bill('old', 'c', '2026-10-25', 100, {})), [['2026-10', 1]])
  })

  test('a statement runs through every month of its period', () => {
    assert.deepEqual(statementMonths(statement('s', 'c', '2026-11-13', '2027-01-12')), ['2026-11', '2026-12', '2027-01'])
  })
})

describe('buckets', () => {
  test('card bills, people, money in and refunds each go where they belong', () => {
    assert.equal(bucketOf(txn('2026-01-01', 1, { category: 'transfers.card_bill' })), 'cardBill')
    assert.equal(bucketOf(txn('2026-01-01', 1, { category: 'transfers.p2p' })), 'people')
    assert.equal(bucketOf(txn('2026-01-01', 1, { direction: 'credit', kind: 'income', category: 'income.received' })), 'in')
    assert.equal(bucketOf(txn('2026-01-01', 1, { direction: 'credit', kind: 'cashback', category: 'income.cashback' })), 'cashback')
    assert.equal(bucketOf(txn('2026-01-01', 1, { direction: 'credit', kind: 'refund', refundOf: 't0' })), 'spent')
    assert.equal(bucketOf(txn('2026-01-01', 1, { category: 'ignored' })), 'ignored')
  })
})

describe('who you paid', () => {
  test('a card bill pays your own card, so it names no payee; it still left the account it was paid from', () => {
    const order = txn('2026-03-01', 900, { payee: 'Fake Shop' })
    const data = ledger({
      txns: [
        order,
        txn('2026-03-05', 300, { direction: 'credit', kind: 'refund', refundOf: order.id, payee: 'Fake Shop' }),
        txn('2026-03-10', 5000, { payee: 'Fake Card App', category: 'transfers.card_bill' }),
        txn('2026-03-12', 400, { payee: 'Mr Fake Friend', category: 'transfers.p2p' }),
      ],
    })
    const view = viewFor(data, 2026, null)
    assert.deepEqual(view.topPayees.map((p) => [p.payee, p.amount]), [['Fake Shop', 600], ['Mr Fake Friend', 400]])
    assert.deepEqual(view.paidFrom.map((s) => [s.mask, s.amount, s.count]), [['XX1111', 6000, 3]])
  })
})

describe('which card a UPI payment was made with', () => {
  const rupay = card('a', '1141', 'RuPay')
  const visa = card('b', '2241', 'Visa')
  const unknown = card('c', '3341')

  test('the RuPay card ending that way; never a card on another network; nothing when two could be it', () => {
    assert.deepEqual(cardsOnUpi('XXXX41', [visa, rupay, unknown]).map((c) => c.id), ['a'])
    assert.deepEqual(cardsOnUpi('XXXX41', [visa, unknown]).map((c) => c.id), ['c'])
    assert.equal(cardsOnUpi('XXXX41', [unknown, card('d', '4441')]).length, 2)
    assert.match(describeSource('XXXX41', [unknown, card('d', '4441')]).detail, /set the RuPay one's network/)
  })

  test('a bank account by its last four digits, named when you named it', () => {
    assert.deepEqual(describeSource('XX4321', [], [{ last4: '4321', label: 'Salary', seenAs: '', addedAt: '2026-01-01' }]), {
      title: 'Salary ••4321',
      detail: 'Bank account',
    })
  })
})

describe('money', () => {
  test('rupees in Indian grouping; paise shown when there are any, always two digits of them', () => {
    assert.equal(inr(123456.4), '₹1,23,456')
    assert.equal(inrExact(1234.5), '₹1,234.50')
    assert.equal(inrExact(980), '₹980')
    assert.equal(inrExact(45.3), '₹45.30')
  })
})

test("paying your card is neither spending nor money in, either side of it, until it's filed as something else", () => {
  const received = txn('2026-08-22', 9000, { direction: 'credit', kind: 'bill_payment', channel: 'card', category: 'transfers.card_bill' })
  const fromBank = txn('2026-08-21', 9000, { kind: 'bill_payment', category: 'transfers.card_bill' })
  for (const t of [received, fromBank]) {
    assert.equal(isCardBill(t), true)
    assert.equal(bucketOf(t), 'cardBill')
  }
  // what the page warns about before it's changed: it would start counting
  assert.equal(countsAs(received, 'shopping.online'), 'in')
  assert.equal(countsAs(fromBank, 'home.rent'), 'spent')
  assert.equal(countsAs(received, 'ignored'), 'ignored') // counted nowhere either: nothing to warn about
  assert.equal(isCardBill(txn('2026-08-22', 1, { direction: 'credit', kind: 'income', category: 'income.received' })), false)
})

test('every row where money comes in has a green tag; of the rows going out, only a card bill paid from the bank has one', () => {
  const at = '2026-08-22'
  const tagOf = (over: Partial<Transaction>) => {
    const tag = rowTag(txn(at, 100, over))
    return tag && `${tag.text}${tag.inward ? ' (green)' : ''}`
  }
  assert.equal(tagOf({ direction: 'credit', kind: 'bill_payment', channel: 'card', category: 'transfers.card_bill' }), 'Bill paid (green)')
  assert.equal(tagOf({ direction: 'credit', kind: 'refund', category: 'income.refund' }), 'Refund (green)')
  assert.equal(tagOf({ direction: 'credit', kind: 'refund', refundOf: 't0' }), 'Refund (green)')
  assert.equal(tagOf({ direction: 'credit', kind: 'cashback', category: 'income.cashback' }), 'Cashback (green)')
  assert.equal(tagOf({ direction: 'credit', kind: 'income', category: 'income.received' }), 'Received (green)')
  assert.equal(tagOf({ direction: 'credit', kind: 'transfer', category: 'ignored' }), 'Transfer in (green)')
  // a payment to the card you filed as something else is money that came in, like any other
  assert.equal(tagOf({ direction: 'credit', kind: 'bill_payment', channel: 'card', category: 'income.received' }), 'Received (green)')

  assert.equal(tagOf({ kind: 'bill_payment', category: 'transfers.card_bill' }), 'Bill paid') // paid from your bank: neutral
  assert.equal(tagOf({}), null) // a purchase
  assert.equal(tagOf({ category: 'transfers.p2p' }), null)
})
