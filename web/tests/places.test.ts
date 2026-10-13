// Where you were, as you told Plutus: a payment's place comes from its day (a refund's, from its payment's), the stay
// told latest wins a shared day, a stay's spending is what Ask Plutus says for it, and the sentences people say read
// as the stays they mean, or as nothing. Fake ledgers and made-up places only.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { answer, emptyQuery, yearPeriod, type AskQuery } from '../src/lib/ask'
import { dayRange, readQuestion, readStay, type AskContext } from '../src/lib/askRules'
import type { LedgerData } from '../src/lib/ledger'
import { cleanPlace, parsePlace, placeLabel, placeMatches, placeTitle, regionOf, stateAt, STATES, staysIn, staysOf, stayOn, stayPreview, toldBefore } from '../src/lib/places'
import type { Stay } from '../src/types'
import { inr } from '../src/lib/money'
import { scoped } from '../src/lib/scope'
import { bill, card, ledger, txn } from './fixtures'

const TODAY = '2026-10-13'
const near = (a: number | null | undefined, b: number, what: string) => assert.ok(a != null && Math.abs(a - b) < 0.01, `${what}: ${a} vs ${b}`)
const stay = (id: string, place: string, start: string, end: string, addedAt: string, region: string | null = null): Stay => ({ id, place, region, start, end, addedAt })

const categories = new Map(
  [['food', 'Food & Dining', null], ['food.restaurants', 'Restaurants', 'food'], ['transport', 'Transport', null],
   ['travel', 'Travel', null], ['transfers', 'Transfers', null], ['transfers.p2p', 'To people', 'transfers'],
   ['income', 'Money in', null], ['income.received', 'Received', 'income']]
    .map(([id, label, parent]) => [id!, { id: id!, label: label!, parent, excludeFromSpend: false }]),
)
const CARD = card('fakebank-1141', '1141')

/** Goa told first (1–10 Jan 2026), Kerala told later over part of it (8–12 Jan): 8–10 Jan are Kerala's. A refund on
 *  12 Jan for a meal on 3 Jan counts on 3 Jan, in Goa. A payment to a person, money in, and a day with no stay. */
function fake(): LedgerData {
  const meal = txn('2026-01-03', 1200, { id: 'meal', payee: 'Fake Beach Cafe', category: 'food.restaurants' })
  return ledger({
    categories,
    cards: [CARD],
    txns: [
      meal,
      txn('2026-01-12', 200, { id: 'back', direction: 'credit', kind: 'refund', refundOf: 'meal', payee: 'Fake Beach Cafe', category: 'food.restaurants' }),
      txn('2026-01-05', 800, { id: 'scooter', payee: 'Fake Scooter Rental', category: 'transport' }),
      txn('2026-01-09', 600, { id: 'boat', payee: 'Fake Houseboat', category: 'travel' }),
      txn('2026-01-11', 300, { id: 'chai', payee: 'Fake Tea Stall', category: 'food.restaurants' }),
      txn('2026-01-06', 5000, { id: 'friend', payee: 'Mr Fake Friend', category: 'transfers.p2p' }),
      txn('2026-01-07', 9000, { id: 'salary', direction: 'credit', kind: 'income', payee: 'Fake Employer', category: 'income.received' }),
      txn('2026-02-01', 450, { id: 'home', payee: 'Fake Grocery', category: 'food.restaurants' }),
      txn('2025-12-31', 700, { id: 'eve', payee: 'Fake Party', category: 'food.restaurants' }),
    ],
    payments: [bill('est', CARD.id, '2026-02-05', 3000, { paysFrom: '2026-01-01', paysTo: '2026-01-31', cycle: 'card', counted: 0, estimate: 3000 })],
    stays: [
      stay('stay-000000000001', 'Goa', '2025-12-30', '2026-01-10', '2026-01-20T10:00:00Z'),
      stay('stay-000000000002', 'Kerala', '2026-01-08', '2026-01-12', '2026-01-21T10:00:00Z'),
    ],
  })
}

/** The same, with an investment made far from any stay (to be left out). */
const withInvestment = (data: LedgerData): LedgerData => ({ ...data, categories: new Map([...data.categories, ['investments', { id: 'investments', label: 'Investments', parent: null, excludeFromSpend: false }]]),
  txns: [...data.txns, txn('2026-06-01', 5000, { id: 'sip', payee: 'FAKE MUTUAL FUND', category: 'investments' })] })

describe('a payment’s place comes from its day', () => {
  const data = fake()
  const at = staysOf(data)
  test('the stay told latest wins a day two stays share', () => {
    assert.equal(stayOn('2026-01-07', data.stays)?.place, 'Goa')
    assert.equal(stayOn('2026-01-08', data.stays)?.place, 'Kerala')
    assert.equal(stayOn('2026-01-13', data.stays), null)
  })
  test('every payment on those days has it, whatever kind; a refund takes its payment’s day', () => {
    assert.deepEqual(Object.fromEntries([...at].map(([id, s]) => [id, s.place])),
      { meal: 'Goa', back: 'Goa', scooter: 'Goa', boat: 'Kerala', chai: 'Kerala', friend: 'Goa', salary: 'Goa', eve: 'Goa' })
  })
})

describe('what a stay holds', () => {
  const data = fake()
  test('its own days in the year, what was spent on them, and by what', () => {
    const [kerala, goa] = staysIn(data, 2026)
    assert.deepEqual([goa.stay.place, goa.days, goa.payments], ['Goa', 7, 2]) // 1–7 Jan in 2026; the meal and the scooter
    near(goa.spent, 1200 - 200 + 800, 'Goa') // the refund comes off; the friend and the salary aren't spending
    assert.deepEqual(goa.categories, [{ id: 'food', amount: 1000 }, { id: 'transport', amount: 800 }])
    assert.deepEqual(goa.ids.sort(), ['back', 'meal', 'scooter'])
    assert.deepEqual([kerala.stay.place, kerala.days, kerala.payments], ['Kerala', 5, 2])
    near(kerala.spent, 900, 'Kerala')
  })
  test('across all years, a stay over the new year counts all its days', () => {
    const goa = staysIn(data, 'all').find((s) => s.stay.place === 'Goa')!
    assert.equal(goa.days, 9) // 30 Dec – 7 Jan
    near(goa.spent, 700 + 1800, 'Goa, all years')
  })
  test('Ask Plutus says the same for each place, and says how much card spending from bills falls on its days, unplaced', () => {
    const ask = (over: Partial<AskQuery>) => answer(data, { ...emptyQuery(), ...over })
    for (const s of staysIn(data, 2026)) {
      const a = ask({ places: [s.stay.place], period: yearPeriod(2026) })
      near(a.amount, s.spent, s.stay.place)
      assert.equal(a.payments, s.payments)
      // the bill's ₹3,000 estimate is spread over January's 31 days: Goa owns 7 of them in 2026, Kerala 5
      near(s.estimated, (3000 * s.days) / 31, `${s.stay.place}: estimated over its days`)
      assert.ok(a.notes.includes(`Not included: about ${inr(s.estimated)} of card spending estimated from card bills over those days. A bill has no payments, so it has no place.`), `${s.stay.place}: ${a.notes}`)
    }
    // nothing about investments or other days in an answer about a place
    const left = answer(scoped(withInvestment(data), false), { ...emptyQuery(), places: ['Goa'], period: yearPeriod(2026) })
    assert.ok(!left.notes.some((n) => /Investments are left out/.test(n)), String(left.notes))
    near(ask({ places: ['goa'], categories: ['food'], period: yearPeriod(2026) }).amount, 1000, 'food in goa, any case')
  })
  test('“where was I”: each place with its own days in the period, and what was spent there', () => {
    const a = answer(data, { ...emptyQuery('where'), period: { from: '2026-01-01', to: '2026-01-31', label: 'January 2026' } })
    assert.deepEqual(a.lines.map((l) => [l.label, l.amount, l.detail]), [
      ['Goa', 1800, '1 Jan 2026 – 10 Jan 2026 · 10 days'], ['Kerala', 900, '8 Jan 2026 – 12 Jan 2026 · 5 days']])
    assert.match(a.sentence, /^In January 2026 you were in Goa and Kerala/)
    assert.match(answer(ledger({ categories }), emptyQuery('where')).sentence, /haven’t told me where you were yet/)
  })
})

describe('before a stay is kept: what it would do', () => {
  test('the payments on its days, what was spent, and the days it takes from places told before', () => {
    const p = stayPreview(fake(), '2026-01-09', '2026-01-11', 'Hampi')
    assert.deepEqual([p.days, p.payments], [3, 2])
    near(p.spent, 900, 'spent')
    assert.deepEqual(p.taken.map((x) => [x.stay.place, x.start, x.end]), [['Goa', '2026-01-09', '2026-01-10'], ['Kerala', '2026-01-09', '2026-01-11']])
    assert.deepEqual(stayPreview(fake(), '2026-01-09', '2026-01-11', 'goa').taken.map((x) => x.stay.place), ['Kerala']) // Goa again takes nothing from Goa
  })
  test('a place is tidied, made a name when written in small letters, and refused when it isn’t one', () => {
    assert.equal(cleanPlace('  north   goa '), 'North Goa')
    assert.equal(cleanPlace('McLeod Ganj'), 'McLeod Ganj')
    assert.equal(cleanPlace('daman & diu'), 'Daman & Diu')
    for (const bad of ['', '  ', 'x'.repeat(41), 'Goa<b>', 'Goa\nKerala', '{Goa}']) assert.equal(cleanPlace(bad), null, bad)
  })
})

describe('telling Plutus where you were, in your own words', () => {
  const ctx: AskContext = { categories, payees: [], cards: [], places: ['Goa'], today: TODAY }
  const read = (s: string) => readStay(s, ctx)
  const cases: [string, ['stay' | 'forget', string | null, string | null, string | null] | null][] = [
    ['1st Jan 2026 to 5th March 2026 I was in Goa', ['stay', 'Goa', '2026-01-01', '2026-03-05']],
    ['I was in Goa from 1 Jan to 5 Mar 2026', ['stay', 'Goa', '2026-01-01', '2026-03-05']],
    ['i was in goa from 1 jan to 5 mar', ['stay', 'Goa', '2026-01-01', '2026-03-05']], // your "Goa"; the latest that's begun
    ['I was in GOA from the 1st of January to the 5th of March, 2026', ['stay', 'Goa', '2026-01-01', '2026-03-05']],
    ['we were in kerala 28 Dec to 3 Jan', ['stay', 'Kerala', '2025-12-28', '2026-01-03']], // over the new year
    ['I stayed in north goa 1-5 Jan 2026', ['stay', 'North Goa', '2026-01-01', '2026-01-05']],
    ['Coorg trip 12-19 March', ['stay', 'Coorg', '2026-03-12', '2026-03-19']],
    ['mark 1/1/2026 to 5/3/2026 as Goa', ['stay', 'Goa', '2026-01-01', '2026-03-05']], // day first, as in India
    ['2026-01-01 to 2026-03-05 we were in Goa', ['stay', 'Goa', '2026-01-01', '2026-03-05']],
    ['Jan 1 - Mar 5 2026 I was in Goa', ['stay', 'Goa', '2026-01-01', '2026-03-05']],
    ['I was in Goa on 12 Jan', ['stay', 'Goa', '2026-01-12', '2026-01-12']],
    ['I’m in Goa since 1 Oct', ['stay', 'Goa', '2026-10-01', TODAY]],
    ['I was in Goa in December', ['stay', 'Goa', '2025-12-01', '2025-12-31']], // the latest December that has begun
    ['I was in Goa last week', ['stay', 'Goa', '2026-10-05', '2026-10-11']], // 13 Oct 2026 is a Tuesday: Monday to Sunday before
    ['I’ll be in Goa from 20 to 25 Dec', ['stay', 'Goa', '2026-12-20', '2026-12-25']], // a time to come: the next
    ['I will be in Goa in December', ['stay', 'Goa', '2026-12-01', '2026-12-31']],
    ['I’ll be in Goa from 1 to 5 Jan', ['stay', 'Goa', '2027-01-01', '2027-01-05']], // January has passed: the next one
    ['I was in Goa', ['stay', 'Goa', null, null]], // no days: the reply asks when
    ['I was in Goa in the second week of March', ['stay', 'Goa', null, null]], // part of a month: not the whole of it
    ['we were in Kerala in early January', ['stay', 'Kerala', null, null]],
    ['I was in Goa from 31 Feb to 3 Mar', ['stay', 'Goa', null, null]], // not a day
    ['I was in Goa until 5 Jan', ['stay', 'Goa', null, null]], // one end only: not that one day
    ['I was in Goa up to 5 Jan', ['stay', 'Goa', null, null]],
    ['I was in Goa before 5 Jan', ['stay', 'Goa', null, null]],
    ['forget Goa', ['forget', 'Goa', null, null]],
    ['I wasn’t in Goa in January', ['forget', 'Goa', '2026-01-01', '2026-01-31']],
    ['remove the stay in goa', ['forget', 'Goa', null, null]],
    ['forget all my places', ['forget', null, null, null]],
    // questions, and sentences that tell nothing about where you were
    ['How much did I spend in Goa?', null],
    ['How much did I spend when I was in Goa from 1 to 5 Jan', null], // a question with a stay in it: still a question
    ['what did we spend while we were in Kerala last week', null],
    ['where was I in February', null],
    ['spent 500 on food in January', null],
    ['top 5 payees in 2026', null],
  ]
  for (const [sentence, want] of cases) {
    test(sentence, () => {
      const r = read(sentence)
      assert.deepEqual(r && [r.kind, r.place, r.start, r.end], want)
    })
  }
  test('a day range of a question’s kind, read the same way', () => {
    assert.deepEqual(dayRange('from march to june 2025', TODAY), { start: '2025-03-01', end: '2025-06-30' })
    assert.equal(dayRange('nothing about days here', TODAY), null)
  })
})

describe('asking about a place', () => {
  const ctx: AskContext = { categories, payees: [], cards: [], places: ['Goa', 'North Goa'], today: TODAY }
  test('a place you told is read in a question, longest name first', () => {
    const r = readQuestion('how much did I spend in north goa', ctx)!
    assert.deepEqual([r.query.places, r.sure], [['North Goa'], true])
    const food = readQuestion('food in goa in 2026', ctx)!
    assert.deepEqual([food.query.places, food.query.categories, food.query.period?.label], [['Goa'], ['food'], '2026'])
  })
  test('“where was I in February?” asks where, for February', () => {
    const r = readQuestion('where was I in February?', ctx)!
    assert.deepEqual([r.query.kind, r.query.period?.label, r.sure], ['where', 'February 2026', true])
  })
})


describe('a place’s state', () => {
  test('India’s 36 by their number-plate codes; the official and old codes, and old names, taken as them', () => {
    assert.equal(Object.keys(STATES).length, 36)
    assert.equal(new Set(Object.values(STATES)).size, 36)
    assert.deepEqual(['WB', 'wb', 'TS', 'CT', 'OR', 'West Bengal', 'west  bengal', 'Orissa', 'Jammu & Kashmir', 'J&K', 'Dadra and Nagar Haveli'].map(regionOf),
      ['WB', 'WB', 'TG', 'CG', 'OD', 'WB', 'WB', 'OD', 'JK', 'JK', 'DD'])
    for (const no of ['XX', 'Bengal', 'India', 'Darjeeling', '']) assert.equal(regionOf(no), null, no)
  })
  test('shown as “Place, ST”, the state’s name on hover; a place that is a state, by its name alone', () => {
    assert.equal(placeLabel({ place: 'Darjeeling', region: 'WB' }), 'Darjeeling, WB')
    assert.equal(placeTitle({ place: 'Darjeeling', region: 'WB' }), 'Darjeeling, West Bengal')
    assert.equal(placeLabel({ place: 'Goa', region: 'GA' }), 'Goa')
    assert.equal(placeTitle({ place: 'Goa', region: 'GA' }), 'Goa')
    assert.equal(placeLabel({ place: 'Fakepur', region: null }), 'Fakepur')
    assert.equal(placeLabel({ place: 'Fakepur' }), 'Fakepur')
  })
  test('a state written after a place: a code in capitals, or a name after a comma or in brackets', () => {
    const at = (s: string) => { const r = stateAt(s); return r && [r.region, s.slice(0, r.length)] }
    assert.deepEqual(at(', WB from 1 Jan'), ['WB', ', WB'])
    assert.deepEqual(at(' WB from 1 Jan'), ['WB', ' WB'])
    assert.deepEqual(at(' (WB) from 1 Jan'), ['WB', ' (WB)'])
    assert.deepEqual(at(', West Bengal, India'), ['WB', ', West Bengal'])
    assert.deepEqual(at(' (west bengal)'), ['WB', ' (west bengal)'])
    assert.deepEqual(at(', TS'), ['TG', ', TS'])
    assert.deepEqual(at(' (OR)'), ['OD', ' (OR)'])
    assert.equal(stateAt(' OR Kerala'), null) // an old code after a plain space: a word ("Goa OR Kerala")
    assert.equal(stateAt(' WB', false), null) // all capitals: codes can't be told from words
    assert.deepEqual(at(', Jammu & Kashmir'), ['JK', ', Jammu & Kashmir'])
    // a code in small letters can be a word ("up to", "as", "or"); a name without a comma can be part of the place's
    // ("North Goa", "New Delhi"); a code runs on into a longer word
    for (const no of [' wb', ', wb', ' up to 5 Jan', ', as I said', ' West Bengal', ' Goa', ', WBX', ' Bengal', '']) assert.equal(stateAt(no), null, no)
  })
  test('a place asked about is a stay’s by its name, its name with its state, or its state alone', () => {
    const k = stay('stay-000000000009', 'Darjeeling', '2026-01-01', '2026-01-05', '2026-01-06T10:00:00Z', 'WB')
    for (const yes of ['Darjeeling', 'darjeeling', 'Darjeeling, WB', 'darjeeling wb', 'Darjeeling, West Bengal', 'West Bengal', 'WB']) assert.ok(placeMatches(yes, k), yes)
    for (const no of ['Darjeeling, BR', 'Bihar', 'Goa', 'Darjeeling Town']) assert.ok(!placeMatches(no, k), no)
    const f = stay('stay-000000000010', 'Fakepur', '2026-01-01', '2026-01-05', '2026-01-06T10:00:00Z')
    assert.ok(placeMatches('fakepur', f))
    for (const no of ['Fakepur, WB', 'West Bengal']) assert.ok(!placeMatches(no, f), `${no}: its state isn't known`)
  })
  test('the local AI’s copy of a place: its name, and a state written with it or the state it is', () => {
    assert.deepEqual(parsePlace('Darjeeling, WB'), { place: 'Darjeeling', region: 'WB' })
    assert.deepEqual(parsePlace('darjeeling, West Bengal'), { place: 'Darjeeling', region: 'WB' })
    assert.deepEqual(parsePlace('Lucknow UP'), { place: 'Lucknow', region: 'UP' })
    assert.deepEqual(parsePlace('goa'), { place: 'Goa', region: 'GA' })
    assert.deepEqual(parsePlace('mambaii'), { place: 'Mambaii', region: null })
    assert.deepEqual(parsePlace('North Goa'), { place: 'North Goa', region: null })
    assert.equal(parsePlace('<b>'), null)
  })
  test('a place told before with a state: the same name is offered with it, the latest told first', () => {
    const stays = [
      stay('stay-000000000011', 'AURANGABAD', '2026-01-01', '2026-01-05', '2026-01-06T10:00:00Z', 'MH'), // the latest told's spelling wins
      stay('stay-000000000012', 'Aurangabad', '2026-02-01', '2026-02-05', '2026-02-06T10:00:00Z', 'BR'),
      stay('stay-000000000013', 'Aurangabad', '2026-03-01', '2026-03-05', '2026-03-06T10:00:00Z', 'MH'),
      stay('stay-000000000014', 'Fakepur', '2026-03-01', '2026-03-05', '2026-03-06T10:00:00Z'),
    ]
    assert.deepEqual(toldBefore('aurangabad', stays), [{ place: 'Aurangabad', region: 'MH' }, { place: 'Aurangabad', region: 'BR' }])
    assert.deepEqual(toldBefore('Fakepur', stays), []) // told without one: nothing to go on
    assert.deepEqual(toldBefore('Mumbai', stays), [])
  })
  test('a stay told again with another state takes the days; with none, or the same, it takes nothing', () => {
    const data = { ...fake(), stays: [stay('stay-000000000011', 'Aurangabad', '2026-01-01', '2026-01-05', '2026-01-06T10:00:00Z', 'MH')] }
    assert.equal(stayPreview(data, '2026-01-02', '2026-01-03', 'Aurangabad', 'BR').taken.length, 1)
    assert.equal(stayPreview(data, '2026-01-02', '2026-01-03', 'Aurangabad', 'MH').taken.length, 0)
    assert.equal(stayPreview(data, '2026-01-02', '2026-01-03', 'aurangabad').taken.length, 0)
  })
})

describe('telling Plutus where you were, with its state', () => {
  const ctx: AskContext = { categories, payees: [], cards: [], places: ['Goa'], today: TODAY }
  const cases: [string, [string, string | null] | null][] = [
    ['I was in Darjeeling, WB from 1 to 5 Jan 2026', ['Darjeeling', 'WB']],
    ['I was in Darjeeling, West Bengal from 1 to 5 Jan 2026', ['Darjeeling', 'WB']],
    ['I was in Darjeeling WB from 1 to 5 Jan 2026', ['Darjeeling', 'WB']],
    ['I was in Darjeeling (WB) from 1 to 5 Jan 2026', ['Darjeeling', 'WB']],
    ['I was in bengaluru, KA from 1 to 5 Jan 2026', ['Bengaluru', 'KA']],
    ['I was in Lucknow UP from 1 to 5 Jan 2026', ['Lucknow', 'UP']],
    ['I was in Hyderabad, TS from 1 to 5 Jan 2026', ['Hyderabad', 'TG']], // an old code, as today's
    ['I was in Hyderabad TS from 1 to 5 Jan 2026', ['Hyderabad TS', null]], // an old code needs a comma: the local AI is asked
    ['I was in Goa from 1 to 5 Jan 2026', ['Goa', 'GA']], // a state itself
    ['we were in west bengal from 1 to 5 Jan 2026', ['West Bengal', 'WB']],
    ['I was in Jammu and Kashmir from 1 to 5 Jan 2026', ['Jammu and Kashmir', 'JK']],
    ['I was in Goa, GA from 1 to 5 Jan 2026', ['Goa', 'GA']],
    ['I was in Goa Velha from 1 to 5 Jan 2026', ['Goa Velha', null]], // a place in a state, named after it
    ['I stayed in north goa 1-5 Jan 2026', ['North Goa', null]],
    ['I was in New Delhi from 1 to 5 Jan 2026', ['New Delhi', null]],
    ['I was in Goa up to 5 Jan 2026', ['Goa', 'GA']], // "up" a word, not Uttar Pradesh
    ['I was in darjeeling, wb from 1 to 5 Jan 2026', ['Darjeeling', null]], // small letters could be a word: the local AI is asked
    ['I was in UP from 1 to 5 Jan 2026', ['UP', null]], // a code alone could be another place ("LA"): the local AI is asked
    ['I stayed in mambaii for from 13 jun to 30th june ,', ['Mambaii', null]],
    ['I stayed in Aurangadad from 13 jun to 30th june', ['Aurangadad', null]],
  ]
  for (const [sentence, want] of cases) {
    test(sentence, () => {
      const r = readStay(sentence, ctx)
      assert.deepEqual(r && [r.place, r.region], want)
      if (r?.kind === 'stay' && /from 1 to 5 jan 2026/i.test(sentence)) assert.deepEqual([r.start, r.end], ['2026-01-01', '2026-01-05'], 'the state isn’t read as days')
    })
  }
  test('forgetting a place in one state', () => {
    const r = readStay('forget Aurangabad, MH', ctx)!
    assert.deepEqual([r.kind, r.place, r.region], ['forget', 'Aurangabad', 'MH'])
  })
})

describe('asking about a state', () => {
  const ctx: AskContext = { categories, payees: [], cards: [], places: ['Goa', 'North Goa', 'Aurangabad', 'Kochi'], today: TODAY }
  const places = (q: string) => readQuestion(q, ctx)?.query.places
  test('by its name, or its code in capitals; a place you told with a state after it is that place in that state', () => {
    assert.deepEqual(places('how much did I spend in West Bengal'), ['West Bengal'])
    assert.deepEqual(places('how much did I spend in WB in 2026'), ['West Bengal'])
    assert.deepEqual(places('food in kerala'), ['Kerala'])
    assert.deepEqual(places('how much did I spend in Aurangabad, MH?'), ['Aurangabad, MH'])
    assert.deepEqual(places('how much did I spend in aurangabad, Maharashtra'), ['Aurangabad, MH'])
    assert.deepEqual(places('how much did I spend in Goa and Kerala'), ['Goa', 'Kerala'])
    assert.equal(readQuestion('how much did I spend in WB in 2026', ctx)?.sure, true)
  })
  test('a word that is also a code is a word', () => {
    assert.deepEqual(places('why did my spending go up in 2026'), [])
    assert.deepEqual(places('food or travel in 2026'), [])
    assert.deepEqual(places('WHY DID MY SPENDING GO UP IN 2026'), [])
    assert.deepEqual(places('HOW MUCH DID I SPEND IN GOA UP TO MARCH'), ['Goa']) // all capitals: "UP" is a word here
    assert.deepEqual(places('how much did I spend in Goa UP'), ['Goa, UP']) // in capitals among small letters: a code
    assert.deepEqual(places('how much did I spend in Goa OR Kerala'), ['Goa', 'Kerala']) // an old code only after a comma
    assert.deepEqual(places('how much did I spend in Hyderabad, TS'), ['Telangana'])
  })
  test('the answer is the stays in that state, as Places counts them; “where was I” names them with their states', () => {
    const plain = fake()
    const data = { ...plain, stays: [{ ...plain.stays[0], place: 'Panaji', region: 'GA' }, { ...plain.stays[1], place: 'Kochi', region: 'KL' }] }
    const ask = (places: string[]) => answer(data, { ...emptyQuery(), places, period: yearPeriod(2026) })
    const [kochi, panaji] = staysIn(data, 2026)
    near(ask(['Goa']).amount, panaji.spent, 'Goa: Panaji, GA')
    near(ask(['Kerala']).amount, kochi.spent, 'Kerala: Kochi, KL')
    near(ask(['Kochi, KL']).amount, kochi.spent, 'Kochi, KL')
    near(ask(['Kochi, KA']).amount ?? 0, 0, 'Kochi in another state')
    near(ask(['Goa', 'Kerala']).amount, panaji.spent + kochi.spent, 'both')
    // the same figure as when the stays were told by the states' names
    near(ask(['Goa']).amount, answer(plain, { ...emptyQuery(), places: ['Goa'], period: yearPeriod(2026) }).amount!, 'as before')
    const where = answer(data, { ...emptyQuery('where'), period: { from: '2026-01-01', to: '2026-01-31', label: 'January 2026' } })
    assert.deepEqual(where.lines.map((l) => l.label), ['Panaji, GA', 'Kochi, KL'])
  })
})
