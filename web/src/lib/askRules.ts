import type { Instrument } from '../types'
import { emptyQuery, fyPeriod, lastDayOf, monthPeriod, payeeMatches, rangePeriod, yearPeriod, type AskKind, type AskPeriod, type AskQuery } from './ask'
import type { Category } from './ledger'

/** Reading a question with rules, here in the page, instantly: the periods ("2025", "last month", "FY 2024-25"), the
 *  kind of question ("how much", "top 5", "vs", "by month"…), categories by name and by the words people use for them,
 *  and payees and cards by your own names. What the rules can't place is reported (`unknown`), so the page can ask the
 *  local AI instead, or answer with what it understood and say so. The words are the same for everyone; your payees
 *  and cards come from your ledger, on this Mac. */

export interface AskContext {
  categories: Map<string, Category>
  /** Every payee name in your ledger. */
  payees: string[]
  cards: Instrument[]
  /** "2026-10-07": what "this year" and "last month" mean. */
  today: string
}

export interface Reading {
  query: AskQuery
  /** Every word that matters was placed; otherwise `unknown` says which weren't. */
  sure: boolean
  unknown: string[]
}

// ---- words ---------------------------------------------------------------------------------------------------------

/** What people call a category, besides its name. Indian usage included ("bijli", "EB bill", "kirana", "SIP"). */
const SYNONYMS: Record<string, string[]> = {
  food: ['food', 'dining', 'eating'],
  'food.delivery': ['food delivery', 'food order', 'food orders', 'ordering food', 'takeaway', 'online food'],
  'food.restaurants': ['restaurant', 'restaurants', 'cafe', 'cafes', 'dining out', 'eating out', 'dine out'],
  'food.snacks': ['snacks', 'street food', 'chai', 'tea'],
  'food.drinks': ['alcohol', 'liquor', 'bar', 'bars', 'pub', 'pubs', 'beer', 'wine', 'drinks'],
  groceries: ['grocery', 'groceries'],
  'groceries.quick_commerce': ['quick commerce', 'instant delivery'],
  'groceries.supermarket': ['supermarket', 'supermarkets', 'hypermarket'],
  'groceries.local': ['kirana', 'local store', 'local stores', 'vegetables', 'fruits', 'milk', 'dairy'],
  'groceries.meat_fish': ['meat', 'fish', 'chicken', 'mutton'],
  transport: ['transport', 'commute', 'commuting', 'travel within the city'],
  'transport.ride_hailing': ['cab', 'cabs', 'taxi', 'taxis', 'auto', 'autos', 'rickshaw', 'rides'],
  'transport.fuel': ['fuel', 'petrol', 'diesel', 'cng'],
  'transport.public': ['metro', 'public transport', 'local train'],
  'transport.tolls': ['toll', 'tolls', 'fastag'],
  'transport.parking': ['parking'],
  shopping: ['shopping'],
  'shopping.online': ['online shopping'],
  'shopping.electronics': ['electronics', 'gadgets', 'gadget'],
  'shopping.device_repairs': ['repair', 'repairs', 'phone repair'],
  'shopping.apparel': ['clothes', 'clothing', 'apparel', 'shoes', 'footwear', 'fashion'],
  'shopping.home': ['home goods', 'kitchen', 'hardware', 'household'],
  bills: ['bills', 'utilities', 'utility bills', 'utility'],
  'bills.electricity': ['electricity', 'electric', 'electricity bill', 'power bill', 'current bill', 'eb bill', 'bijli', 'light bill'],
  'bills.mobile': ['mobile', 'phone bill', 'mobile bill', 'recharge', 'recharges', 'mobile recharge', 'prepaid', 'postpaid'],
  'bills.broadband': ['broadband', 'internet', 'wifi', 'wi fi', 'fiber', 'fibre'],
  'bills.water': ['water', 'water bill'],
  'bills.gas': ['gas', 'cooking gas', 'lpg', 'cylinder', 'piped gas', 'gas bill'],
  'bills.dth': ['dth', 'cable', 'tv recharge'],
  entertainment: ['entertainment'],
  'entertainment.ott': ['ott', 'streaming'],
  'entertainment.music': ['music'],
  'entertainment.events': ['movie', 'movies', 'cinema', 'events', 'concerts', 'concert'],
  'entertainment.gaming': ['gaming', 'games'],
  subscriptions: ['subscriptions', 'subscription'],
  'subscriptions.software': ['software', 'saas', 'app subscriptions'],
  'subscriptions.cloud': ['cloud storage', 'cloud'],
  'subscriptions.news': ['news', 'newspaper', 'newspapers', 'newsletters', 'magazines'],
  health: ['health', 'healthcare', 'medical expenses'],
  'health.pharmacy': ['pharmacy', 'medicines', 'medicine', 'chemist'],
  'health.medical': ['doctor', 'doctors', 'hospital', 'hospitals', 'lab', 'labs', 'clinic', 'medical'],
  'health.fitness': ['gym', 'fitness', 'sports', 'yoga'],
  travel: ['travel', 'trip', 'trips', 'vacation', 'holiday', 'holidays'],
  'travel.flights': ['flight', 'flights', 'air tickets', 'airline', 'airlines'],
  'travel.hotels': ['hotel', 'hotels', 'stay', 'stays', 'lodging'],
  'travel.trains': ['train', 'trains', 'railway', 'railways', 'train tickets'],
  'travel.bus': ['bus tickets', 'intercity bus'],
  'home.rent': ['rent', 'house rent', 'landlord'],
  'home.furniture_rental': ['furniture rental', 'appliance rental'],
  'home.maintenance': ['maintenance', 'society maintenance', 'society'],
  'home.services': ['home services', 'cleaning', 'laundry', 'plumber', 'electrician'],
  education: ['education', 'school', 'college', 'tuition', 'courses', 'course', 'school fees'],
  personal_care: ['personal care', 'salon', 'haircut', 'haircuts', 'spa', 'grooming', 'beauty'],
  insurance: ['insurance', 'premium', 'premiums', 'policy'],
  fees: ['fees and charges', 'bank charges', 'charges'],
  'fees.interest': ['interest'],
  'fees.late': ['late fee', 'late fees', 'late payment'],
  'fees.annual': ['annual fee', 'annual fees', 'joining fee', 'joining fees'],
  'fees.forex': ['forex', 'foreign exchange', 'markup'],
  'fees.tax': ['gst'],
  cash: ['cash', 'atm', 'cash withdrawal', 'cash withdrawals', 'atm withdrawal', 'atm withdrawals'],
  investments: ['investment', 'investments', 'invest', 'invested', 'sip', 'sips', 'mutual fund', 'mutual funds', 'stocks'],
  'transfers.p2p': ['people', 'friends', 'family', 'persons', 'individuals'],
  'transfers.card_bill': ['credit card bill', 'credit card bills', 'card bill', 'card bills'],
  income: ['money in', 'income'],
  'income.received': ['salary', 'received'],
  'income.cashback': ['cashback', 'cash back', 'rewards'],
  'income.refund': ['refund', 'refunds'],
}

/** Words that carry no meaning of their own here: never a payee, never "not understood". */
const FILLER = new Set(
  ('a an the i me my mine we our you your is are was were be been do does did done have has had can could would will ' +
    'how much many what which who whom where when why please tell show give list display find get see let know ' +
    'total totals spent spend spending spends paid pay paying payment payments cost costs costed expense expenses ' +
    'amount amounts money bill bills transaction transactions purchase purchases bought buy order orders ordered ' +
    'on in at to for of from by with into onto about and or but so far till until up till now date overall ' +
    'altogether all every each any some this that these those there here it its than then also only just same ' +
    'year years month months day days week weeks time times did done much more most less least overall ever ' +
    'rs inr rupees rupee spent until today yesterday ago since between last past previous current recent recently ' +
    'whats hows whos wheres whens im ive id didnt dont doesnt wasnt sent send sending payee payees merchant merchants ' +
    'shop shops store stores category categories app apps place places may know kindly please tell got receive earned ' +
    'earn credited came expenditure outgo outflow outlay spendings much often times bank banks as over per plus ' +
    'together single take takes took taken put puts charge charged company companies provider providers vendor vendors business ' +
    'businesses')
    .split(' '),
)

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 }

const monthIndex = (name: string) => MONTHS.findIndex((m) => m.startsWith(name.slice(0, 3)))
const pad = (n: number) => String(n).padStart(2, '0')
const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))

// ---- reading -------------------------------------------------------------------------------------------------------

/** The question, read by rules; null when nothing in it was understood. `previous`: the last reading in this chat,
 *  for follow-ups ("and in 2024?", "only on cards"). */
export function readQuestion(question: string, ctx: AskContext, previous: AskQuery | null = null): Reading | null {
  let text = ` ${plainText(question).replace(/[^a-z0-9₹./-]+/g, ' ').replace(/\s+/g, ' ').trim()} `
  const take = (re: RegExp) => {
    const m = text.match(re)
    if (m) text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index! + m[0].length) // places kept
    return m
  }

  const found = { period: false, kind: false, target: false }
  const q = emptyQuery()

  // what kind of question (before periods: "last time" isn't "last month")
  q.kind = kindOf(text)
  found.kind = q.kind !== 'total' || /\b(how much|total|spent|spend|paid|cost|sum)\b/.test(text)
  if (q.kind === 'average' && /\b(per month|a month|monthly|each month|every month)\b/.test(text)) q.per = 'month'
  if (q.kind === 'top') q.by = /\b(categor(y|ies)|what (do|did) i spend|where (do|did) i spend|spend (the )?most on|areas?)\b/.test(text) ? 'category' : 'payee'
  const limit = text.match(/\b(?:top|biggest|largest|highest|last)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\b(?!\s+(?:days?|weeks?|months?|years?)\b)/)
    ?? text.match(/\b(\d{1,2}|three|four|five|ten)\s+(?:biggest|largest|highest|top)\b/)
  if (limit) q.limit = Number(limit[1]) || NUMBER_WORDS[limit[1]] || 5
  else if (q.kind === 'largest' && !/\b(payments|expenses|transactions|purchases|bills|ones)\b/.test(text)) q.limit = 1
  text = text.replace(/\b(when did i last|last time|most recent|latest|biggest|largest|highest|most expensive|costliest|top \d+|top|how many|number of|how often|average|avg|typical(ly)?|compare(d)?( to| with)?|versus|vs\.?|against|month by month|by month|monthwise|month wise|monthly|trend|breakdown|per month|each month|every month|show me|show|list)\b/g, ' ')

  // when
  const periods = periodsOf(take, ctx.today)
  if (periods.length) {
    found.period = true
    q.period = periods[0]
    if (periods.length > 1) {
      if (q.kind === 'compare' || periods.length === 2) {
        q.kind = 'compare'
        found.kind = true
        q.compareTo = periods[1]
      }
    }
  }

  // how: money in, UPI or cards (card bills are a category, read below)
  if (/\b(received|receive|got|income|earned|earn|credited|came in|money in|salary)\b/.test(text)) q.money = 'in'
  const cardBill = /\b(credit )?card bills?\b/.test(text)
  if (!cardBill && take(/\b(?:on|with|by|using|through|via|from) (?:my |a |the |your )?(?:credit )?cards?\b|\bcard (?:spends?|spending|purchases?)\b|\bcredit cards?\b/)) {
    q.channel = 'cards'
    found.target = true
  } else if (take(/\b(?:on|by|using|through|via|over|with)? ?(?:upi|gpay|google pay|phonepe|paytm)\b/)) {
    q.channel = 'upi'
    found.target = true
  }

  // which card
  const ending = take(/\b(?:card )?(?:ending(?: in| with)?|ends with|xx+|x{2,})\s*(\d{4})\b/)
  const cards = ctx.cards.filter((c) => (ending && c.last4 === ending[1]) || cardNamed(text, c))
  if (cards.length) {
    q.cards = cards.map((c) => c.id)
    q.channel = 'all'
    found.target = true
    for (const c of cards) for (const w of cardWords(c)) text = text.replace(new RegExp(`\\b${escape(w)}\\b`, 'g'), ' ')
    text = text.replace(/\bcards?\b/g, ' ')
  }

  // categories, by their names and the words people use, longest first
  const phrases = categoryPhrases(ctx.categories)
  for (const [phrase, id] of phrases) {
    const re = new RegExp(`\\b${escape(phrase)}s?\\b`)
    if (re.test(text) && ctx.categories.has(id)) {
      if (!q.categories.includes(id)) q.categories.push(id)
      text = text.replace(re, ' ')
      found.target = true
    }
  }
  // "electricity bills": the child said it; the bare word "bills" alone means the whole group
  if (q.categories.length > 1 && q.categories.includes('bills') && q.categories.some((c) => c.startsWith('bills.'))) {
    q.categories = q.categories.filter((c) => c !== 'bills')
  }
  if (q.categories.length && q.categories.every((c) => c.split('.')[0] === 'income')) q.money = 'in'

  // payees: what's left that names someone you've paid, longest first
  const tokens = text.split(' ').filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w) && w !== '₹')
  const used = new Set<number>()
  for (const size of [3, 2, 1]) {
    for (let i = 0; i + size <= tokens.length; i++) {
      if ([...Array(size).keys()].some((k) => used.has(i + k))) continue
      const words = tokens.slice(i, i + size).join(' ')
      if (words.length < 3) continue
      if (ctx.payees.some((p) => payeeMatches(p, words))) {
        q.payees.push(words)
        for (let k = 0; k < size; k++) used.add(i + k)
        found.target = true
      }
    }
  }
  const unknown = tokens.filter((_, i) => !used.has(i))

  // a follow-up: what changed, on top of the last reading
  // a follow-up: it starts like one ("and in 2024?", "what about rent"), or it's only a period ("2024?"), or only a short
  // kind of question ("how many?", "by month?"); a whole question ("biggest expense in 2026") stands alone
  const starter = /^\s*(and|what about|how about|same for|also|only|just|but|now)\b/.test(question.toLowerCase())
  const short = question.trim().split(/\s+/).length <= 4
  const followUp = previous && (starter || (!found.target && !found.kind && found.period) || (!found.target && !found.period && found.kind && short))
  if (followUp && previous) {
    const next: AskQuery = { ...previous, compareTo: q.kind === 'compare' ? q.compareTo : previous.compareTo }
    if (found.kind && q.kind !== 'total') Object.assign(next, { kind: q.kind, by: q.by, per: q.per, limit: q.limit })
    if (found.period) next.period = q.period
    if (q.categories.length || q.payees.length) Object.assign(next, { categories: q.categories, payees: q.payees, money: q.money })
    if (q.cards.length) next.cards = q.cards
    if (q.channel !== 'all') next.channel = q.channel
    return { query: next, sure: unknown.length === 0, unknown }
  }

  if (!found.kind && !found.period && !found.target && q.money === 'out') return null
  return { query: q, sure: unknown.length === 0, unknown }
}

/** Whether words the local AI gave as a payee could name one: yes if they match a payee of yours, or have a word that
 *  is neither a category's nor a filler ("Mr Fake Friend", a shop not in your files: the answer then says nothing matched); no
 *  for a kind of payee ("shops", "doctors", "the electricity company"), which is a category or nothing. */
export function couldBePayee(words: string, ctx: AskContext): boolean {
  if (ctx.payees.some((p) => payeeMatches(p, words))) return true
  let text = ` ${plainText(words).replace(/[^a-z0-9]+/g, ' ')} `
  for (const [phrase] of categoryPhrases(ctx.categories)) text = text.replace(new RegExp(`\\b${escape(phrase)}s?\\b`, 'g'), ' ')
  return text.split(' ').some((w) => w && !FILLER.has(w))
}

function kindOf(text: string): AskKind {
  if (/\b(compare|compared|versus|vs\.?|against)\b/.test(text)) return 'compare'
  if (/\b(average|avg|typical|typically|mean)\b/.test(text)) return 'average'
  if (/\b(by month|month by month|monthly|month ?wise|each month|every month|per month|trend|breakdown)\b/.test(text)) return 'trend'
  if (/\b(how many|number of|how often|count)\b/.test(text)) return 'count'
  if (/\b(when did i last|when was (my |the )?last|last time|most recent|latest)\b/.test(text)) return 'last'
  if (/\b(biggest|largest|highest|most expensive|costliest)\b.*\b(payments?|expenses?|transactions?|purchases?|spends?|bills?|ones?)\b/.test(text)) return 'largest'
  if (/\b(top|most|biggest|largest|highest)\b/.test(text)) return 'top'
  if (/^\s*(show|list|display|give me|which|what were|what are)\b/.test(text) || /\b(show|list)\b.*\b(payments?|transactions?|expenses?|bills?|purchases?|orders?)\b/.test(text)) return 'list'
  return 'total'
}

/** Every period the question names, in the order said: the first is the period, a second the one to compare with. */
function periodsOf(take: (re: RegExp) => RegExpMatchArray | null, today: string): AskPeriod[] {
  const said: [number, AskPeriod][] = []
  const out = { push: (p: AskPeriod) => said.push([last?.index ?? 0, p]) }
  let last: RegExpMatchArray | null = null
  const took = (re: RegExp) => (last = take(re))
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))]
  const thisMonth = `${ty}-${pad(tm)}`
  const shift = (month: string, by: number) => {
    const [y, m] = month.split('-').map(Number)
    const i = y * 12 + (m - 1) + by
    return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`
  }
  const dayShift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86400000).toISOString().slice(0, 10)
  let m: RegExpMatchArray | null

  // financial years: "FY 2024-25", "FY25", "financial year 2024-2025"
  // (one year named is the year it ends in: FY25 and FY 2025 are April 2024 to March 2025)
  while ((m = took(/\b(?:fy|financial year)\s*(\d{2,4})(?:\s*[-/]\s*(\d{2,4}))?\b/))) {
    out.push(fyPeriod(m[2] ? fullYear(m[1]) : fullYear(m[1]) - 1))
  }
  // "from March to June 2025", "between Jan 2024 and Mar 2024"
  while ((m = took(new RegExp(`\\b(?:from|between)\\s+${MONTH_RE}\\s*(\\d{4})?\\s+(?:to|and|till|until|-)\\s+${MONTH_RE}\\s*(\\d{4})?\\b`)))) {
    const endYear = m[4] ? Number(m[4]) : m[2] ? Number(m[2]) : ty
    const startYear = m[2] ? Number(m[2]) : monthIndex(m[1]) <= monthIndex(m[3]) ? endYear : endYear - 1
    out.push(rangePeriod(`${startYear}-${pad(monthIndex(m[1]) + 1)}-01`, lastDayOf(`${endYear}-${pad(monthIndex(m[3]) + 1)}`)))
  }
  // "from 2023 to 2025"
  while ((m = took(/\b(?:from|between)\s+(20\d{2})\s+(?:to|and|till|until|-)\s+(20\d{2})\b/))) {
    out.push(rangePeriod(`${m[1]}-01-01`, `${m[2]}-12-31`))
  }
  // "since March 2025", "since 2024"
  if ((m = took(new RegExp(`\\bsince\\s+(?:${MONTH_RE}\\s*)?(\\d{4})?\\b`))) && (m[1] || m[2])) {
    const year = m[2] ? Number(m[2]) : m[1] && monthIndex(m[1]) + 1 <= tm ? ty : ty - 1
    out.push(rangePeriod(`${year}-${pad(m[1] ? monthIndex(m[1]) + 1 : 1)}-01`, today))
  }
  if (took(/\b(this|current) year\b|\bso far this year\b|\bthis year so far\b/)) out.push(rangePeriod(`${ty}-01-01`, `${ty}-12-31`))
  if (took(/\b(last|previous|past) year\b/)) out.push(yearPeriod(ty - 1))
  if (took(/\b(this|current) month\b/)) out.push(monthPeriod(thisMonth))
  if (took(/\b(last|previous|past) month\b/)) out.push(monthPeriod(shift(thisMonth, -1)))
  // "the last 30 days", "past 2 weeks", "last 3 months", "the past two years": back from today, today included;
  // months and years whole from their first day, as the dashboard's months are
  while ((m = took(/\b(?:last|past|previous)\s+(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+(day|week|month|year)s?\b/))) {
    const n = Number(m[1]) || NUMBER_WORDS[m[1]] || 3
    const unit = m[2]
    const from = unit === 'day' ? dayShift(today, -(n - 1))
      : unit === 'week' ? dayShift(today, -(7 * n - 1))
      : `${shift(thisMonth, -(unit === 'year' ? 12 * n - 1 : n - 1))}-01`
    out.push(rangePeriod(from, today))
  }
  if (took(/\b(this|current) week\b/)) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
    out.push(rangePeriod(dayShift(today, -weekday), today))
  }
  if (took(/\b(last|previous|past) week\b/)) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7
    out.push(rangePeriod(dayShift(today, -weekday - 7), dayShift(today, -weekday - 1)))
  }
  if (took(/\btoday\b/)) out.push(rangePeriod(today, today))
  if (took(/\byesterday\b/)) out.push(rangePeriod(dayShift(today, -1), dayShift(today, -1)))
  // "March 2025", "in march" (the latest March: this year's if it's begun, else last year's). "May" is a month only
  // with a year or after "in", "of", "for"… ("may I know" isn't).
  const monthOf = (name: string, year?: string) => {
    const month = monthIndex(name) + 1
    return monthPeriod(`${year ? Number(year) : month <= tm ? ty : ty - 1}-${pad(month)}`)
  }
  while ((m = took(/\b(?:in|of|during|for|this|last)\s+may(?:\s+(\d{4}))?\b|\bmay\s+(\d{4})\b/))) out.push(monthOf('may', m[1] ?? m[2]))
  // (a month or year takes its "in" with it: "my money in 2025" is spending, not "Money in")
  while ((m = took(new RegExp(`\\b(?:(?:in|of|during|for)\\s+)?${MONTH_RE.replace('may|', '')}(?:\\s+(\\d{4}))?\\b`)))) out.push(monthOf(m[1], m[2]))
  // years: "2025", "in 2024 and 2025"
  while ((m = took(/\b(?:(?:in|of|during|for)\s+)?(19\d{2}|20\d{2})\b/))) out.push(yearPeriod(Number(m[1])))
  return said.sort((a, b) => a[0] - b[0]).map(([, p]) => p)
}

/** Every phrase that names a category, longest first: its synonyms, its name, and the parts of a name like "Bars &
 *  liquor". A name said exactly wins over a part ("Bus" is the intercity Bus, not "Metro & bus"). */
function categoryPhrases(categories: Map<string, Category>): [string, string][] {
  const out = new Map<string, string>()
  const plain = (s: string) => plainText(s).replace(/\(.*?\)/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  for (const [id, words] of Object.entries(SYNONYMS)) for (const w of words) if (!out.has(w)) out.set(w, id)
  for (const c of categories.values()) {
    const name = plain(c.label)
    if (name && !out.has(name)) out.set(name, c.id)
  }
  for (const c of categories.values()) {
    for (const part of plain(c.label).split(/\s+and\s+/)) if (part.length > 3 && !FILLER.has(part) && !out.has(part)) out.set(part, c.id)
  }
  return [...out].sort((a, b) => b[0].length - a[0].length)
}

function cardWords(c: Instrument): string[] {
  const bank = (c.issuer ?? '').toLowerCase().replace(/\bbank\b/, '').trim()
  return [bank, c.last4, ...(c.product ?? '').toLowerCase().split(/\s+/).filter((w) => w.length > 3)].filter(Boolean)
}

/** "my HDFC card", "the Fake Bank card", "card 1141": a card named by its bank, product or last four digits, with
 *  the word "card" said, so a bank's name alone (a bank transfer, a bank's charges) isn't taken for a card. */
function cardNamed(text: string, c: Instrument): boolean {
  if (!/\bcards?\b/.test(text)) return false
  return cardWords(c).some((w) => new RegExp(`\\b${escape(w)}\\b`).test(text))
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Lower case, accents and apostrophes gone: "Café's" → "cafes". */
const plainText = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/&/g, ' and ').toLowerCase()
