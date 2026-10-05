// Ticking payments in the transactions list to change several at once. Made-up ids and amounts only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keepShown, tick, tickedTotal } from '../src/lib/selection'
import { txn } from './fixtures'

const shown = ['a', 'b', 'c', 'd', 'e']

test('a tick flips one payment; a shift-tick ticks the run from the last one, either way down the list', () => {
  let s = tick(new Set(), 'b', shown, null, false)
  assert.deepEqual([...s], ['b'])
  s = tick(s, 'e', shown, 'b', true)
  assert.deepEqual([...s].sort(), ['b', 'c', 'd', 'e'])
  s = tick(s, 'c', shown, 'e', true) // shift-ticking a ticked one unticks the run
  assert.deepEqual([...s].sort(), ['b'])
  assert.deepEqual([...tick(s, 'b', shown, 'b', false)], []) // and a plain tick on a ticked one unticks it
})

test("a change of several never reaches a payment that isn't shown", () => {
  const s = new Set(['a', 'c', 'x'])
  assert.deepEqual([...keepShown(s, shown)].sort(), ['a', 'c'])
  const all = new Set(['a', 'b'])
  assert.equal(keepShown(all, shown), all) // nothing went: the same set
})

test('what the ticked payments add up to: money out less money back', () => {
  const at = '2026-08-01'
  const txns = [txn(at, 499, { id: 'a' }), txn(at, 1234.5, { id: 'b' }), txn(at, 100, { id: 'c', direction: 'credit' }), txn(at, 7, { id: 'd' })]
  assert.deepEqual(tickedTotal(txns, new Set(['a', 'b', 'c'])), { count: 3, net: 1633.5, cardBills: 0 })
})

test('a payment to your card is ticked like any other, but is neither money out nor money back', () => {
  const at = '2026-08-01'
  const txns = [
    txn(at, 499, { id: 'a' }),
    txn(at, 9000, { id: 'paid', direction: 'credit', kind: 'bill_payment', channel: 'card', category: 'transfers.card_bill' }),
    txn(at, 9000, { id: 'from-bank', kind: 'bill_payment', category: 'transfers.card_bill' }),
  ]
  assert.deepEqual(tickedTotal(txns, new Set(['a', 'paid', 'from-bank'])), { count: 3, net: 499, cardBills: 2 })
})
