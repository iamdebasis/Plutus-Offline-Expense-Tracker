// Money that comes in reads the way a bank's statement says it: its tag ("Received", "Refund"…), then who it's from,
// and the account or card it was credited to; payments out read as before. A card bill's statement side ("PAYMENT
// RECEIVED") is your own payment to the card, never "from" anyone. Fake payments only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountLine, moneyFrom, moneyIn } from '../src/lib/ledger'
import type { OwnAccount, Transaction } from '../src/types'
import { byNumber, card, onUpi, txn } from './fixtures'

const CARD = card('fakebank-1141', '1141')
const RENT: OwnAccount = { last4: '1111', label: 'Rent account', seenAs: 'Bank Account XXXXXX1111', addedAt: '2026-01-01T00:00:00Z' }
const pay = (over: Partial<Transaction> = {}) => txn('2026-01-05', 500, over)
const credit = (over: Partial<Transaction> = {}) => pay({ direction: 'credit', kind: 'income', category: 'income.received', ...over })
const line = (t: Transaction, accounts: OwnAccount[] = []) => accountLine(t, [CARD], accounts)

test('a payment out: the account or card it was paid from, as before', () => {
  assert.deepEqual(line(pay()), { text: 'Account ••1111', title: 'Account ••1111 · Bank account' })
  assert.equal(line(pay(byNumber(CARD.id)))?.text, 'Fake Bank ••1141')
})

test('money in: credited to the account, or to your own account by the name you gave it', () => {
  assert.deepEqual(line(credit()), { text: 'Credited to account ••1111', title: 'Credited to Account ••1111 · Bank account' })
  assert.equal(line(credit(), [RENT])?.text, 'Credited to Rent account ••1111')
})

test('money back to a card: credited to the card, by its name; one not known yet by its last digits', () => {
  assert.equal(line(credit({ kind: 'refund', category: 'income.refund', ...byNumber(CARD.id) }))?.text, 'Credited to Fake Bank ••1141')
  assert.equal(line(credit({ kind: 'refund', category: 'income.refund', ...onUpi(CARD.id) }))?.text, 'Credited to Fake Bank ••1141')
  assert.equal(line(credit({ kind: 'refund', category: 'income.refund', paidFrom: 'XXXX99' }))?.text, 'Credited to card ••99')
  assert.equal(line(credit({ kind: 'cashback', category: 'income.cashback', paidFrom: 'Gift card' }))?.text, 'Credited to PhonePe gift card')
})

test('the file doesn’t say where it went: no line rather than a guess', () => {
  assert.equal(line(credit({ paidFrom: null })), null)
  assert.equal(line(pay({ paidFrom: null })), null)
})

test('a card bill’s statement side is credited to the card: your payment to it', () => {
  assert.equal(line(credit({ kind: 'bill_payment', category: 'transfers.card_bill', ...byNumber(CARD.id) }))?.text, 'Credited to Fake Bank ••1141')
})

test('money in has its tag on top; “from” whom where its name says who sent it, never a payment out or your own payment to a card', () => {
  for (const t of [credit(), credit({ kind: 'refund', category: 'income.refund' }), credit({ kind: 'transfer', category: 'ignored' })]) {
    assert.deepEqual([moneyIn(t), moneyFrom(t)], [true, true], `${t.kind}`)
  }
  // a cashback's name is the file's wording for it ("Cashback Received"): its tag on top, its name as it is, no "from"
  const cashback = credit({ kind: 'cashback', category: 'income.cashback', payee: 'Cashback Received' })
  assert.deepEqual([moneyIn(cashback), moneyFrom(cashback)], [true, false])
  for (const t of [pay(), credit({ kind: 'bill_payment', category: 'transfers.card_bill', ...byNumber(CARD.id) })]) {
    assert.deepEqual([moneyIn(t), moneyFrom(t)], [false, false])
  }
})
