// The month-by-month table: a row a category (or card), a column a month, or a year when the months span several.
// Made-up figures only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Trend } from '../src/lib/totals'
import { trendTable } from '../src/lib/trendTable'

const months2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`)
const line = (id: string, values: (number | null)[], extra: Partial<Trend> = {}): Trend => ({
  id,
  label: id,
  amount: values.reduce<number>((s, v) => s + (v ?? 0), 0),
  values,
  ...extra,
})

test('a year: a column a month, then the total; every figure in its own row and month', () => {
  const rent = line('rent', [100, 100, 120, 0, 0, 0, 0, 0, 0, null, null, null])
  const food = line('food', [5, 0, 7.5, 0, 0, 0, 0, 0, 0, null, null, null])
  const t = trendTable(months2026, [rent, food])
  assert.deepEqual(
    t.columns.map((c) => c.label),
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'],
  )
  assert.equal(t.columns[0].title, 'January 2026')
  assert.deepEqual(t.rows.map((r) => r.id), ['rent', 'food']) // in the order given (the chips')
  assert.deepEqual(t.rows[0].cells.map((c) => c.value), rent.values)
  assert.deepEqual(t.rows[1].cells.map((c) => c.value), food.values)
  assert.equal(t.rows[0].total, rent.amount) // the total is the line's own figure (its chip)
  assert.equal(t.rows[1].total, 12.5)
})

test('Together: each column summed over the rows, a month no file covers left empty, not ₹0', () => {
  const t = trendTable(months2026, [line('a', [1, 2, null, ...Array(9).fill(null)]), line('b', [10, null, null, ...Array(9).fill(null)])])
  assert.deepEqual(t.together?.cells.slice(0, 3).map((c) => c.value), [11, 2, null])
  assert.equal(t.together?.total, 13)
  assert.equal(trendTable(months2026, [line('a', Array(12).fill(1))]).together, null, 'one row needs no Together')
})

test('an estimated month stays marked, and so does every sum it goes into', () => {
  const values = [50, 60, ...Array(10).fill(null)]
  const cards = line('cards', values, { estimated: [true, false, ...Array(10).fill(false)] })
  const t = trendTable(months2026, [cards, line('rent', [100, 100, ...Array(10).fill(null)])])
  assert.deepEqual(t.rows[0].cells.slice(0, 2).map((c) => c.estimate), [true, false])
  assert.equal(t.rows[0].estimate, true)
  assert.equal(t.rows[1].estimate, false)
  assert.deepEqual(t.together?.cells.slice(0, 2).map((c) => c.estimate), [true, false])
  assert.equal(t.together?.estimate, true)
  const dashed = trendTable(months2026, [line('bills', [10, null, ...Array(10).fill(null)], { dashed: true })])
  assert.equal(dashed.rows[0].cells[0].estimate, true, 'a line estimated throughout')
  assert.equal(dashed.rows[0].cells[1].estimate, false, 'but not a month with nothing in it')
})

test('months across several years: a column a year, each the sum of its months', () => {
  const months = ['2024-11', '2024-12', '2025-01', '2025-02', '2026-01']
  const t = trendTable(months, [
    line('a', [10, 20, 1, 2, null], { estimated: [false, true, false, false, false] }),
    line('b', [null, null, null, null, 7]),
  ])
  assert.deepEqual(t.columns.map((c) => [c.label, c.title]), [['2024', '2024'], ['2025', '2025'], ['2026', '2026']])
  assert.deepEqual(t.rows[0].cells.map((c) => [c.value, c.estimate]), [[30, true], [3, false], [null, false]])
  assert.deepEqual(t.rows[1].cells.map((c) => c.value), [null, null, 7])
  assert.equal(t.rows[0].total, 33)
  assert.deepEqual(t.together?.cells.map((c) => c.value), [30, 3, 7])
})

test('months that fit in one calendar year stay months, even when not a whole year', () => {
  const t = trendTable(['2026-03', '2026-04'], [line('a', [1, 2])])
  assert.deepEqual(t.columns.map((c) => c.label), ['Mar', 'Apr'])
  assert.deepEqual(trendTable([], []).columns, [])
})
