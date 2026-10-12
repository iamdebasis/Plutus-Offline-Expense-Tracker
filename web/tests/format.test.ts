// Spans of dates as the page says them. Made-up dates only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatSpan } from '../src/lib/format'

test("a statement's span says its year, and both years when it runs across two", () => {
  assert.equal(formatSpan('2026-08-13', '2026-09-12'), '13 Aug – 12 Sept 2026')
  assert.equal(formatSpan('2026-04-01', '2027-03-31'), '1 Apr 2026 – 31 Mar 2027')
})
