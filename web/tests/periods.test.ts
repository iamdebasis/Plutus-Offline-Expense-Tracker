import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayLabel, dayMonthLabel, timeLabel } from '../src/lib/periods'

test('a day is read from the stored local timestamp, never shifted by a time zone', () => {
  assert.equal(dayLabel('2026-09-30T23:45:00+05:30'), '30 Sept 2026')
  assert.equal(timeLabel('2026-09-30T23:45:00+05:30'), '11:45 pm')
})

test('a day without its year, for a list whose payments all fall in one year', () => {
  assert.equal(dayMonthLabel('2026-09-30T23:45:00+05:30'), '30 Sept')
  assert.equal(dayMonthLabel('2026-01-01T00:10:00+05:30'), '1 Jan')
})
