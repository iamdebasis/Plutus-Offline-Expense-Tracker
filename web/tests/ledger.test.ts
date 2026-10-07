// How payments are bucketed, placed in months, and told apart by card. Fake data only.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { billNote, billSides, bucketOf, cardSide, cardsOnUpi, countsAs, cycleShares, describeSource, howPaid, isCardBill, monthShares, oneRowPerPayment, rowTag, statementMonths, viewFor } from '../src/lib/ledger'
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

describe('one payment, one row', () => {
  const CARD = card('fakebank-1141', '1141')
  const sideOf = (id: string, at: string, over: Partial<Transaction>) =>
    txn(at, 9000, { id, kind: 'bill_payment', category: 'transfers.card_bill', ...over })
  const toCred = sideOf('upi', '2026-08-20', { payee: 'CRED Club', settles: 'b1' })
  const received = sideOf('row', '2026-08-22', { direction: 'credit', channel: 'card', payee: 'PAYMENT RECEIVED - THANK YOU', card: CARD.id, refs: { cardRow: 'x' }, settles: 'b1' })
  const shop = txn('2026-08-21', 500, { id: 'shop' })
  const names = { card: () => 'Fake Bank ••1141', paidFrom: () => 'Account ••1111' }

  test('the sides of one bill are one row: the side you paid from, the card’s side folded into it', () => {
    const sides = billSides([received, shop, toCred])
    assert.deepEqual(sides.get('b1')?.map((t) => t.id), ['upi', 'row'])
    assert.deepEqual(oneRowPerPayment([received, shop, toCred], sides).map((t) => t.id), ['shop', 'upi'])
    // only the card's side in the list (paid in another year, or filtered out): it stays
    assert.deepEqual(oneRowPerPayment([received, shop], sides).map((t) => t.id), ['row', 'shop'])
    // a bill with one side, or a payment that isn't a bill: as they are
    const alone = sideOf('row2', '2026-09-22', { direction: 'credit', channel: 'card', card: CARD.id, refs: { cardRow: 'y' }, settles: 'bill-row2' })
    assert.deepEqual(oneRowPerPayment([alone, shop], billSides([alone, shop])).map((t) => t.id), ['row2', 'shop'])
  })

  test('the row says what it stands for: whose bill, through what, and where else it shows', () => {
    const cred = bill('b1', CARD.id, '2026-08-20', 9000, {})
    const sides = billSides([toCred, received])
    assert.equal(billNote(toCred, cred, sides, names), 'Bill for Fake Bank ••1141, via CRED')
    assert.equal(cardSide(toCred, sides)?.id, 'row') // shown as “+ Statement” on its row
    assert.equal(cardSide(received, sides), undefined)
    assert.equal(billNote(received, cred, sides, names), 'Paid from Account ••1111 on 20 Aug 2026, via CRED')
    assert.equal(billNote(received, cred, billSides([received]), names), 'Paid through CRED')
    // CRED rewards paid part of it
    assert.equal(billNote({ ...toCred, amount: 8900 }, cred, billSides([toCred]), names), 'Bill for Fake Bank ••1141, via CRED · ₹100 covered by CRED rewards')
    // paid straight to the card's biller: the statement's own bill, no CRED
    const own = bill('bill-row', CARD.id, '2026-08-22', 9000, { origin: 'statement' })
    const direct = { ...toCred, payee: 'FAKE BANK CREDIT CARD', settles: 'bill-row' }
    const itsRow = { ...received, settles: 'bill-row' }
    assert.equal(billNote(direct, own, billSides([direct, itsRow]), names), 'Bill for Fake Bank ••1141')
    assert.equal(cardSide(direct, billSides([direct, itsRow]))?.id, 'row')
    assert.equal(billNote(itsRow, own, billSides([itsRow]), names), null) // the statement's row on its own: nothing to add
  })
})

describe('how it was paid', () => {
  const CARD = card('fakebank-1141', '1141')
  const parts = (over: Partial<Transaction>) => howPaid(txn('2026-08-20', 500, over))?.parts
  const title = (over: Partial<Transaction>) => howPaid(txn('2026-08-20', 500, over))?.title ?? ''

  test('with the card: its number, or the card through an app', () => {
    // a card statement's purchase: shop, tap or online, which a statement doesn't say, so it isn't guessed
    const bought = { channel: 'card' as const, app: null, card: CARD.id, paidFrom: 'XXXX1141' }
    assert.deepEqual(parts(bought), ['Card'])
    assert.match(title(bought), /in a shop, tapped, or online/)
    assert.match(title({ ...bought, direction: 'credit', kind: 'refund' }), /^On your card/)
    // a RuPay credit card on UPI, in PhonePe: known card, or only its "XXXX41" from the app
    assert.deepEqual(parts({ channel: 'upi', app: 'phonepe', card: CARD.id }), ['Card', 'PhonePe'])
    assert.deepEqual(parts({ channel: 'upi', app: 'phonepe', card: null, paidFrom: 'XXXX41' }), ['Card', 'PhonePe'])
    // a card on UPI only the card's statement shows: the app isn't known
    assert.deepEqual(parts({ channel: 'upi', app: null, card: CARD.id, paidFrom: 'XXXX1141' }), ['Card', 'UPI'])
    assert.match(title({ channel: 'upi', app: null, card: CARD.id }), /the app isn't known/)
    // Google Pay paying with a card (the Play Store and the like)
    assert.deepEqual(parts({ channel: 'card', app: 'gpay', card: null, paidFrom: 'XXXX1141' }), ['Card', 'GPay'])
  })

  test('on UPI from your account: the app it was paid in, or just UPI', () => {
    assert.deepEqual(parts({ app: 'phonepe', paidFrom: 'XX1111' }), ['PhonePe'])
    assert.deepEqual(parts({ app: 'gpay', paidFrom: 'XX1111' }), ['GPay'])
    assert.deepEqual(parts({ app: 'paytm', paidFrom: 'XX1111' }), ['Paytm'])
    assert.deepEqual(parts({ app: null, paidFrom: 'XX1111' }), ['UPI'])
    assert.deepEqual(parts({ app: 'some-new-app', paidFrom: 'XX1111' }), ['UPI']) // an app Plutus doesn't know isn't named
    assert.match(title({ app: 'gpay' }), /^Paid on UPI in Google Pay/)
    assert.match(title({ app: 'phonepe', direction: 'credit', kind: 'income' }), /^Received on UPI in PhonePe/)
    // an account's last four digits that happen to look like a card's: an account, unless one of your cards has them
    assert.deepEqual(parts({ app: 'phonepe', card: null, paidFrom: 'XXXX4321' }), ['PhonePe'])
  })

  test('a PhonePe gift card balance is PhonePe, not UPI; anything else unknown shows nothing', () => {
    assert.deepEqual(parts({ app: 'phonepe', paidFrom: 'Gift card' }), ['PhonePe'])
    assert.match(title({ app: 'phonepe', paidFrom: 'Gift card' }), /gift card balance/)
    assert.equal(howPaid(txn('2026-08-20', 500, { channel: 'other' })), null)
  })
})
