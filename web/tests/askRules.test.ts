// Questions read by rules, with the real category tree (the same for everyone) and made-up payees and cards. Each
// question says what it should be read as; "unsure" ones go to the local AI. Today is fixed: 7 Oct 2026, a Wednesday.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { emptyQuery, yearPeriod, type AskQuery } from '../src/lib/ask'
import { couldBePayee, readQuestion, type AskContext } from '../src/lib/askRules'
import type { Category } from '../src/lib/ledger'
import type { CategoryNode } from '../src/types'
import { card } from './fixtures'

const tree: CategoryNode[] = JSON.parse(readFileSync(new URL('../../backend/app/seed/categories.json', import.meta.url), 'utf-8'))
const categories = new Map<string, Category>()
for (const top of tree) {
  categories.set(top.id, { id: top.id, label: top.label, parent: null, excludeFromSpend: !!top.excludeFromSpend })
  for (const c of top.children ?? []) categories.set(c.id, { id: c.id, label: c.label, parent: top.id, excludeFromSpend: false })
}

const ctx: AskContext = {
  categories,
  payees: ['SWIGGY BANGALORE', 'ZOMATO LTD', 'FAKE POWER CO', 'Mr Fake Payee', 'BIGBASKET FAKE', 'AMAZON PAY INDIA', 'UBER INDIA',
    'NETFLIX.COM', 'FAKE MUTUAL FUND'],
  cards: [card('fakebank-1141', '1141'), { ...card('otherbank-2222', '2222'), issuer: 'Other Bank' }],
  today: '2026-10-07',
}

type Expect = Partial<Omit<AskQuery, 'period' | 'compareTo'>> & { period?: string | null; compareTo?: string | null; sure?: boolean }

function reads(question: string, want: Expect, previous: AskQuery | null = null) {
  const r = readQuestion(question, ctx, previous)
  assert.ok(r, `${question}: not understood at all`)
  const got: Record<string, unknown> = { ...r.query, period: r.query.period?.label ?? null, compareTo: r.query.compareTo?.label ?? null, sure: r.sure }
  for (const [key, value] of Object.entries(want)) {
    const g = Array.isArray(got[key]) ? [...(got[key] as string[])].sort() : got[key]
    const w = Array.isArray(value) ? [...value].sort() : value
    assert.deepEqual(g, w, `${question} → ${key}: got ${JSON.stringify(got[key])} (unknown: ${r.unknown.join(', ') || 'none'})`)
  }
}

const SURE = { sure: true }

describe('how much', () => {
  test('a category and a year', () => {
    reads('How much did I pay for electricity in 2025?', { kind: 'total', categories: ['bills.electricity'], period: '2025', ...SURE })
    reads('electricity bill 2025', { kind: 'total', categories: ['bills.electricity'], period: '2025', ...SURE })
    reads('Total bijli bill this year', { categories: ['bills.electricity'], period: '2026', ...SURE })
    reads('What did I spend on food delivery last month?', { categories: ['food.delivery'], period: 'September 2026', ...SURE })
    reads('how much on groceries in FY 2024-25', { categories: ['groceries'], period: 'FY 2024–25', ...SURE })
    reads('petrol expenses fy25', { categories: ['transport.fuel'], period: 'FY 2024–25', ...SURE })
    reads('restaurants & cafés in 2025', { categories: ['food.restaurants'], period: '2025', ...SURE })
    reads('electricity and water bills in 2025', { categories: ['bills.electricity', 'bills.water'], period: '2025', ...SURE })
    reads('all my bills in 2025', { categories: ['bills'], period: '2025', ...SURE })
  })

  test('everything, a payee, a span', () => {
    reads('How much did I spend in total?', { kind: 'total', categories: [], payees: [], period: null, ...SURE })
    reads('How much did I spend on Swiggy?', { payees: ['swiggy'], categories: [], period: null, ...SURE })
    reads('How much did I spend in March 2025', { categories: [], period: 'March 2025', ...SURE })
    reads('rent paid since January 2026', { categories: ['home.rent'], period: '1 Jan 2026 – 7 Oct 2026', ...SURE })
    reads('money sent to Mr Fake Payee', { payees: ['mr fake'], ...SURE }) // "payee" is a filler word; the name still matches
    reads('big basket this month', { payees: ['big basket'], period: 'October 2026', ...SURE })
    reads('bigbasket', { payees: ['bigbasket'], ...SURE })
    reads('netflix 2025', { payees: ['netflix'], period: '2025', ...SURE })
  })

  test('cards and UPI', () => {
    reads('How much did I spend on my credit card in 2025?', { channel: 'cards', cards: [], period: '2025', ...SURE })
    reads('UPI spending last year', { channel: 'upi', period: '2025', ...SURE })
    reads('spending on my Fake Bank card', { cards: ['fakebank-1141'], channel: 'all', ...SURE })
    reads('card ending 2222 this month', { cards: ['otherbank-2222'], period: 'October 2026', ...SURE })
    reads('gst on my card', { categories: ['fees.tax'], channel: 'cards', ...SURE })
    reads('credit card bills in 2025', { categories: ['transfers.card_bill'], channel: 'all', period: '2025', ...SURE })
  })

  test('money in', () => {
    reads('How much cashback did I get in 2025?', { categories: ['income.cashback'], money: 'in', period: '2025', ...SURE })
    reads('How much salary did I receive last year?', { categories: ['income.received'], money: 'in', period: '2025', ...SURE })
    reads('how much money came in this year', { money: 'in', period: '2026', ...SURE })
    reads('How much came in as cashback this year?', { categories: ['income.cashback'], money: 'in', period: '2026', ...SURE })
    reads('refunds in 2025', { categories: ['income.refund'], money: 'in', ...SURE })
  })

  test('the words people use for categories', () => {
    const cases: [string, string][] = [
      ['kirana shopping 2025', 'groceries.local'], ['cab rides last month', 'transport.ride_hailing'], ['fastag', 'transport.tolls'],
      ['medicines', 'health.pharmacy'], ['gym membership', 'health.fitness'], ['flights 2025', 'travel.flights'],
      ['movies this year', 'entertainment.events'], ['late fees', 'fees.late'], ['atm withdrawals', 'cash'],
      ['phone bill', 'bills.mobile'], ['wifi', 'bills.broadband'], ['LPG cylinder', 'bills.gas'], ['utilities', 'bills'],
      ['how much did I invest in SIPs this year', 'investments'], ['insurance premiums', 'insurance'], ['salon', 'personal_care'],
      ['school fees', 'education'], ['society maintenance', 'home.maintenance'], ['bars & liquor', 'food.drinks'],
      ['bus tickets', 'travel.bus'], ['metro', 'transport.public'], ['interest on my card', 'fees.interest'],
    ]
    for (const [question, category] of cases) {
      const r = readQuestion(question, ctx)
      assert.ok(r?.query.categories.includes(category), `${question} → ${category}: got ${JSON.stringify(r?.query.categories)}`)
    }
  })
})

describe('other kinds of question', () => {
  test('how many and averages', () => {
    reads('How many times did I order from Zomato?', { kind: 'count', payees: ['zomato'], ...SURE })
    reads('number of Uber rides in 2025', { kind: 'count', payees: ['uber'], categories: ['transport.ride_hailing'], period: '2025', ...SURE })
    reads('how often do I order food', { kind: 'count', categories: ['food'], ...SURE })
    reads('Average grocery bill', { kind: 'average', per: 'payment', categories: ['groceries'], ...SURE })
    reads('average monthly spend on food delivery in 2025', { kind: 'average', per: 'month', categories: ['food.delivery'], period: '2025', ...SURE })
  })

  test('top and biggest', () => {
    reads('Top 5 payees in 2025', { kind: 'top', by: 'payee', limit: 5, period: '2025', ...SURE })
    reads('Where do I spend the most?', { kind: 'top', by: 'category', ...SURE })
    reads('biggest categories this year', { kind: 'top', by: 'category', period: '2026', ...SURE })
    reads('Who did I pay the most in 2024?', { kind: 'top', by: 'payee', period: '2024', ...SURE })
    reads('top 3 food delivery apps', { kind: 'top', by: 'payee', limit: 3, categories: ['food.delivery'], ...SURE })
    reads('Biggest expense in 2025', { kind: 'largest', limit: 1, period: '2025', ...SURE })
    reads('5 largest payments last year', { kind: 'largest', limit: 5, period: '2025', ...SURE })
    reads('my most expensive purchase', { kind: 'largest', limit: 1, ...SURE })
  })

  test('compare, by month, list, last', () => {
    reads('Food delivery 2024 vs 2025', { kind: 'compare', categories: ['food.delivery'], period: '2024', compareTo: '2025', ...SURE })
    reads('Compare electricity in 2025 and 2026', { kind: 'compare', period: '2025', compareTo: '2026', ...SURE })
    reads('electricity this year vs last year', { kind: 'compare', period: '2026', compareTo: '2025', ...SURE })
    reads('electricity last year vs this year', { kind: 'compare', period: '2025', compareTo: '2026', ...SURE })
    reads('electricity by month in 2025', { kind: 'trend', categories: ['bills.electricity'], period: '2025', ...SURE })
    reads('monthly food delivery spend this year', { kind: 'trend', categories: ['food.delivery'], period: '2026', ...SURE })
    reads('Show my insurance payments in 2025', { kind: 'list', categories: ['insurance'], period: '2025', ...SURE })
    reads('List all Amazon orders', { kind: 'list', payees: ['amazon'], ...SURE })
    reads('When did I last pay rent?', { kind: 'last', categories: ['home.rent'], ...SURE })
    reads('last time I paid Netflix', { kind: 'last', payees: ['netflix'], ...SURE })
    reads('most recent electricity bill', { kind: 'last', categories: ['bills.electricity'], ...SURE })
  })
})

describe('when', () => {
  test('months, ranges, weeks and days', () => {
    reads('spending in may 2025', { period: 'May 2025', ...SURE })
    reads('may i know my rent in 2025', { categories: ['home.rent'], period: '2025', ...SURE })
    reads('from march to june 2025', { period: 'Mar 2025 – Jun 2025', ...SURE })
    reads('between jan 2024 and mar 2024', { period: 'Jan 2024 – Mar 2024', ...SURE })
    reads('from 2023 to 2025', { period: 'Jan 2023 – Dec 2025', ...SURE })
    reads('last 3 months', { period: '1 Aug 2026 – 7 Oct 2026', ...SURE })
    reads('this week', { period: '5 Oct 2026 – 7 Oct 2026', ...SURE })
    reads('last week', { period: '28 Sept 2026 – 4 Oct 2026', ...SURE })
    reads('yesterday', { period: '6 Oct 2026 – 6 Oct 2026', ...SURE })
    reads('electricity in december', { period: 'December 2025', ...SURE })
    reads('electricity in april', { period: 'April 2026', ...SURE })
    reads('how much did i spend in the last 30 days', { categories: [], period: '8 Sept 2026 – 7 Oct 2026', ...SURE })
    reads('past 2 weeks', { period: '24 Sept 2026 – 7 Oct 2026', ...SURE })
    reads('top payees in the last 3 months', { kind: 'top', limit: 5, period: '1 Aug 2026 – 7 Oct 2026', ...SURE }) // a span, not "top 3"
    reads('biggest payments in the last 30 days', { kind: 'largest', limit: 5, period: '8 Sept 2026 – 7 Oct 2026', ...SURE })
    reads('top 3 payees in the last 6 months', { kind: 'top', limit: 3, period: '1 May 2026 – 7 Oct 2026', ...SURE })
    reads('What did doctors and medicines cost me over the past two years?', { categories: ['health.medical', 'health.pharmacy'], period: '1 Nov 2024 – 7 Oct 2026', ...SURE })
    reads('How much did I put into mutual funds since January?', { categories: ['investments'], period: '1 Jan 2026 – 7 Oct 2026', ...SURE })
  })

  test('a period takes its "in" with it: "my money in 2025" is spending, not Money in', () => {
    reads('Which category took most of my money in 2025?', { kind: 'top', by: 'category', categories: [], money: 'out', period: '2025', ...SURE })
    reads('how much money did I spend in March', { categories: [], money: 'out', period: 'March 2026', ...SURE })
    reads('how much money came in this year', { categories: [], money: 'in', period: '2026', ...SURE })
  })
})

describe('follow-ups and what rules can’t read', () => {
  const before: AskQuery = { ...emptyQuery(), categories: ['bills.electricity'], period: yearPeriod(2025) }

  test('a follow-up changes only what it says', () => {
    reads('and in 2024?', { categories: ['bills.electricity'], period: '2024', ...SURE }, before)
    reads('2024?', { categories: ['bills.electricity'], period: '2024', ...SURE }, before)
    reads('what about broadband', { categories: ['bills.broadband'], period: '2025', ...SURE }, before)
    reads('only on cards', { categories: ['bills.electricity'], channel: 'cards', period: '2025', ...SURE }, before)
    reads('how many?', { kind: 'count', categories: ['bills.electricity'], period: '2025', ...SURE }, before)
    reads('How much did I spend in total in 2026?', { categories: [], period: '2026', ...SURE }, before) // a new question
    reads('by month?', { kind: 'trend', categories: ['bills.electricity'], period: '2025', ...SURE }, before)
    reads('biggest expense in 2026', { kind: 'largest', categories: [], period: '2026', ...SURE }, before) // stands alone
    assert.equal(readQuestion('asdf qwerty', ctx, before), null) // never "the last question again"
  })

  test('words that only connect a sentence are read past', () => {
    reads('How much did the electricity company take from me in 2025?', { categories: ['bills.electricity'], payees: [], period: '2025', ...SURE })
    reads('Rent plus electricity together in 2025, how much?', { categories: ['home.rent', 'bills.electricity'], period: '2025', ...SURE })
    reads('Average I spend per Zomato order in 2026', { kind: 'average', per: 'payment', payees: ['zomato'], period: '2026', ...SURE })
    reads('How much interest and late fees did the banks charge me in 2025?', { categories: ['fees.interest', 'fees.late'], period: '2025', ...SURE })
    // but not words that change the question: "go up" asks for a comparison the rules didn't read
    assert.equal(readQuestion('Did my grocery spending go up from 2024 to 2025?', ctx)?.sure, false)
  })

  test('a payee from the local AI is kept only if it could name one', () => {
    for (const kind of ['shops', 'doctors', 'electricity company', 'restaurants', 'the cab company']) assert.equal(couldBePayee(kind, ctx), false, kind)
    for (const name of ['Mr Fake Payee', 'zomato', 'Swiggy', 'Mr Fake Friend', 'Fake Corner Store']) assert.equal(couldBePayee(name, ctx), true, name)
  })

  test('what the rules can’t place goes to the local AI, said', () => {
    const r = readQuestion('What did keeping the lights on and the internet cost me last winter?', ctx)
    assert.ok(r && !r.sure, 'unsure')
    assert.ok(r.unknown.includes('lights') && r.unknown.includes('winter'), r.unknown.join(', '))
    assert.equal(readQuestion('how much did I spend on stuff', ctx)?.sure, false)
    assert.equal(readQuestion('asdf qwerty', ctx), null)
  })
})
