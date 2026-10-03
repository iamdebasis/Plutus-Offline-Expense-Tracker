// Labels shortened to fit beside a chart. Made-up names only.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitLabel } from '../src/lib/format'

const sixEach = (s: string) => s.length * 6 // every letter 6px wide

test("a label that fits is kept; a long card name gives up words, then letters, never the card's digits", () => {
  assert.equal(fitLabel('Fake Bank ••1111', 120, sixEach), 'Fake Bank ••1111')
  assert.equal(fitLabel('Fake First Bank ••1111', 120, sixEach), 'Fake First… ••1111')
  assert.equal(fitLabel('Fakeinternational ••1111', 90, sixEach), 'Fakeint… ••1111')
  assert.equal(fitLabel('Personal care & wellness', 100, sixEach), 'Personal care…')
  assert.equal(fitLabel('Entertainment', 60, sixEach), 'Entertain…')
})
