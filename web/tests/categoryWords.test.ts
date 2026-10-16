// The search in Your transactions finds payments by category too: what you type is matched against each category's
// name and the words people use for it (the same words Ask Plutus knows), as you type it, on the real category tree.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { categoriesMatching, categoriesNamed } from '../src/lib/categoryWords'
import { flatten } from '../src/lib/ledger'
import type { CategoryNode } from '../src/types'

const tree = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'backend', 'app', 'seed', 'categories.json'), 'utf8')) as CategoryNode[]
const categories = flatten(tree)
const found = (q: string) => [...categoriesMatching(q, categories)].sort()
const shown = (q: string) => categoriesNamed(q, categories)
const under = (top: string) => [...categories.values()].filter((c) => c.id === top || c.parent === top).map((c) => c.id).sort()

test('“bar” is Bars & liquor', () => {
  assert.deepEqual(found('bar'), ['food.drinks'])
  assert.deepEqual(found('Bars'), ['food.drinks'])
})

test('a main category brings everything under it: “food” is all of Food & Dining, “shop” all of Shopping', () => {
  assert.deepEqual(found('food'), under('food'))
  assert.deepEqual(shown('food'), ['food', 'food.delivery', 'food.snacks']) // each named one a chip, to narrow to it
  assert.deepEqual(found('shop'), under('shopping'))
  assert.deepEqual(shown('shop'), ['shopping', 'shopping.online'])
  assert.deepEqual(found('shopping'), under('shopping'))
})

test('a subcategory is just itself; several can match, each shown once, in the tree’s order', () => {
  assert.deepEqual(found('electricity'), ['bills.electricity'])
  assert.deepEqual(shown('cab'), ['transport.ride_hailing', 'bills.dth']) // "Cabs & autos", and "DTH & cable"
  // "Rent & Home" is named, so all of it is found; Rent and the rental are chips too, to narrow to just one
  assert.deepEqual(found('rent'), under('home'))
  assert.deepEqual(shown('rent'), ['home', 'home.rent', 'home.furniture_rental'])
})

test('the words people use, as Ask Plutus knows them; plurals and accents too', () => {
  for (const [q, id] of [['liquor', 'food.drinks'], ['pub', 'food.drinks'], ['kirana', 'groceries.local'], ['petrol', 'transport.fuel'],
    ['bijli', 'bills.electricity'], ['salon', 'personal_care'], ['gym', 'health.fitness'], ['cafes', 'food.restaurants'], ['café', 'food.restaurants'],
    ['shoes', 'shopping.apparel'], ['restaurants', 'food.restaurants'], ['street fo', 'food.snacks'], ['ott', 'entertainment.ott'],
    ['liquors', 'food.drinks'], ['gyms', 'health.fitness']] as const) {
    assert.ok(found(q).includes(id), `${q} → ${id}: ${found(q)}`)
  }
})

test('too short, a number, or a word that names nothing: no category', () => {
  for (const q of ['', '  ', 'a', 'ba', '310', '1,750', 'and', 'the', 'zzzz']) assert.deepEqual(found(q), [], q)
})

test('Ignored, by name', () => {
  assert.deepEqual(found('ignored'), ['ignored'])
})
