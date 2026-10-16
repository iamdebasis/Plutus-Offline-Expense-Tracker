import type { Instrument } from '../types'
import { emptyQuery, fyPeriod, lastDayOf, monthPeriod, payeeMatches, rangePeriod, SEASONS, seasonPeriod, yearPeriod, type AskKind, type AskPeriod, type AskQuery, type Season } from './ask'
import type { Category } from './ledger'
import { SYNONYMS } from './categoryWords'
import { asStated, codesReadIn, isStateCode, placeKey, STATE_NAME, stateAt, STATES, statesIn } from './places'

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
  /** The places you told Plutus you were ("Goa"), so a question can name one. */
  places: string[]
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

  // why it changed: the words that only ask why or say which way it went ("higher", "go up") carry nothing more;
  // "from 2024 to 2025" is 2025 against 2024, not the two years together
  let changed: AskPeriod[] = []
  if (q.kind === 'why') {
    text = text.replace(/\b(why|what made|what caused|how come|reasons?( for| why)?|higher|lower|more|less|bigger|smaller|costlier|cheaper|increased?|decreased?|rise|rose|risen|fall|fell|jumped|jump|spiked?|dropped|drop|go|goes|going|went|gone|up|down)\b/g, ' ')
    const span = take(/\bfrom\s+(20\d{2})\s+(?:to|till|until)\s+(20\d{2})\b/)
    if (span) changed = [yearPeriod(Number(span[2])), yearPeriod(Number(span[1]))]
  }

  // when
  const periods = [...changed, ...periodsOf(take, ctx.today, (re) => text.match(re))]
  if (periods.length) {
    found.period = true
    q.period = periods[0]
    if (periods.length > 1 && q.kind === 'why') {
      q.compareTo = periods[1] // what it changed from; with one period named, the one before (lib/ask.ts, periodBefore)
    } else if (periods.length > 1) {
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

  // places: those you told Plutus you were, by your own names, and states (lib/places.ts): before categories, so your
  // word wins
  for (const { word, said } of placesIn(question, ctx.places)) {
    if (!q.places.some((p) => placeKey(p) === placeKey(word))) q.places.push(word)
    const plain = plainText(said).replace(/[^a-z0-9]+/g, ' ').trim()
    if (plain) text = text.replace(new RegExp(`\\b${escape(plain)}\\b`), ' ')
    found.target = true
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
    if (q.categories.length || q.payees.length || q.places.length) Object.assign(next, { categories: q.categories, payees: q.payees, places: q.places, money: q.money })
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
  if (/\bwhere (?:was|were) (?:i|we)\b|\bwhere did (?:i|we) (?:go|stay|travel)\b/.test(text)) return 'where'
  if (/\b(why|what made|what caused|how come|reasons?)\b/.test(text)) return 'why'
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
function periodsOf(take: (re: RegExp) => RegExpMatchArray | null, today: string, peek: (re: RegExp) => RegExpMatchArray | null): AskPeriod[] {
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
  // India's seasons (`SEASONS`: IMD's months, December in winter). A season word counts only with a word that makes it
  // a time ("last winter", "this monsoon", "during the monsoon") or with its year ("summer 2025", "winter 2024-25"), so
  // a name like "Summer House" stays a name. "last" is the latest that has ended; "this", "the" or "in" the latest that
  // has begun. "winter 2025" could be either winter: left unread, so the answer says so (or the local AI is asked).
  const SEASON = '(post[ -]?monsoon|winter|summer|monsoon|rainy season)'
  const seasonOf = (word: string): Season => (word.startsWith('post') ? 'post-monsoon' : word === 'rainy season' ? 'monsoon' : (word as Season))
  const begun = (season: Season) => seasonPeriod(season, SEASONS[season].start <= tm ? ty : ty - 1)
  const ended = (season: Season) => {
    const p = begun(season)
    return p.to < today ? p : seasonPeriod(season, Number(p.from.slice(0, 4)) - 1)
  }
  const winterYears = /\b(?:(?:in|during|for|over)\s+)?(?:the\s+)?winter\s+(\d{4})\s*[-/ ]\s*(\d{2}|\d{4})\b/
  for (let w = peek(winterYears); w && Number(w[2]) % 100 === (Number(w[1]) + 1) % 100; w = peek(winterYears)) {
    took(winterYears)
    out.push(seasonPeriod('winter', Number(w[1])))
  }
  while ((m = took(new RegExp(`\\b(?:(?:in|during|for|over)\\s+)?(?:the\\s+)?${SEASON.replace('winter|', '')}\\s+(\\d{4})\\b`)))) {
    out.push(seasonPeriod(seasonOf(m[1]), Number(m[2])))
  }
  while ((m = took(new RegExp(`\\b(?:(?:in|during|for|over)\\s+)?(?:the\\s+)?(\\d{4})\\s+${SEASON.replace('winter|', '')}\\b`)))) {
    out.push(seasonPeriod(seasonOf(m[2]), Number(m[1])))
  }
  while ((m = took(new RegExp(`\\b(?:(?:in|during|for|over|through)\\s+(?:the\\s+)?|(this|last|previous|past|current|the)\\s+)${SEASON}s?\\b(?!\\s+\\d{4})(?:\\s+season)?`)))) {
    const season = seasonOf(m[2])
    out.push(m[1] && m[1] !== 'this' && m[1] !== 'current' && m[1] !== 'the' ? ended(season) : begun(season))
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

/** Accents and apostrophes gone, "&" said: "Café's" → "Cafes". */
const plainCase = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/&/g, ' and ')
/** The same, in lower case: "Café's" → "cafes". */
const plainText = (s: string) => plainCase(s).toLowerCase()

/** The places a question names: those you told Plutus, by your own names, longest first, each with a state written after
 *  it ("Aurangabad, MH": that place in that state); then states, by name ("West Bengal") or by code in capitals after
 *  "in" or a comma ("in WB"), as their names. Each with the words it took, to take out of the question. */
function placesIn(question: string, told: string[]): { word: string; said: string }[] {
  let s = ` ${plainCase(question)} `
  const codes = codesReadIn(question)
  const out: { word: string; said: string }[] = []
  const take = (at: number, length: number, word: string) => {
    out.push({ word, said: s.slice(at, at + length) })
    s = s.slice(0, at) + ' '.repeat(length) + s.slice(at + length)
  }
  for (const place of [...told].sort((a, b) => b.length - a.length)) {
    const parts = plainText(place).match(/[a-z0-9]+/g)
    if (!parts) continue
    const m = new RegExp(String.raw`(?<![\p{L}\p{N}])${parts.map(escape).join(String.raw`[^\p{L}\p{N}]+`)}(?![\p{L}\p{N}])`, 'iu').exec(s)
    if (!m) continue
    const state = stateAt(s.slice(m.index + m[0].length), codes)
    take(m.index, m[0].length + (state?.length ?? 0), state ? `${place}, ${state.region}` : place)
  }
  for (const st of statesIn(s, codes)) take(st.at, st.length, STATES[st.region])
  return out
}

// ---- telling Plutus where you were ---------------------------------------------------------------------------------

/** "I was in Goa from 1 Jan to 5 Mar 2026": a stay to keep, once you confirm it with the button (Ask Plutus never
 *  keeps one on its own); "forget Goa", "I wasn't in Goa in January": stays to remove, the same way. `start` and `end`
 *  are null when the sentence names no days ("I was in Goa": the reply asks when); `place` is null for every place
 *  ("forget all my places"). */
export type StayReading =
  | { kind: 'stay'; place: string; region: string | null; start: string | null; end: string | null }
  | { kind: 'forget'; place: string | null; region: string | null; start: string | null; end: string | null }

/** A question, not something you're telling: those are read by `readQuestion`. */
const QUESTION = /^\s*(how|what|which|where|when|why|who|whom|show|list|compare|did|do|does|is|are|can|could|would|top|biggest|largest|total|sum)\b/i
const PLACE = String.raw`(\p{L}[\p{L}\p{N}.'&()/-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}.'&()/-]*){0,5})`
/** Where a place's name ends: a word about when, or another part of the sentence. */
const STOP = new Set(('from between during on since till until up to before after for in at the last this next and with week weekend month year ' +
  'today yesterday tomorrow trip trips holiday holidays vacation vacations stay stays visit days day nights night all whole ' +
  'entire of by around over through thru mark tag set as please too also again').split(' '))
const STAYED = [
  // "I was in Goa", "we were at Mumbai", "I'm in Goa", "I'll be in Kerala", "I stayed in Goa", "we visited Goa"
  new RegExp(String.raw`\b(?:i|we)(?:'m|'re|'ll be|'ve been|'d been|\s+(?:was|were|am|are|will be|shall be|have been|had been|stayed|was staying|were staying|lived|was living|were living|went|travelled|traveled|visited|holidayed|vacationed))\s+(?:(?:in|at|to|around)\s+)?${PLACE}`, 'iud'),
  // "trip to Goa", "a holiday in Kerala"
  new RegExp(String.raw`\b(?:trip|holiday|vacation|stay|visit)\s+(?:to|in|at)\s+${PLACE}`, 'iud'),
  // "mark 1-5 Jan as Goa"
  new RegExp(String.raw`\b(?:mark|tag|set|label|record)\b.*?\b(?:as|under)\s+${PLACE}`, 'iud'),
  // "Goa trip 12-19 March"
  new RegExp(String.raw`^\s*${PLACE}\s+(?:trip|holiday|vacation|stay)\b`, 'iud'),
]
const FORGET = [
  // "I wasn't in Goa in January", "we didn't go to Goa"
  new RegExp(String.raw`\b(?:i|we)\s+(?:was not|wasn't|were not|weren't|didn't go to|did not go to|never went to)\s+(?:(?:in|at|to)\s+)?${PLACE}`, 'iud'),
  // "forget Goa", "remove the stay in Goa", "delete my Goa trip"
  new RegExp(String.raw`\b(?:forget|remove|delete|clear|erase|drop)\b(?:\s+(?:my|the|that|this|those|all))*(?:\s+(?:stays?|trips?|places?)\s+(?:in|at|to))?\s+${PLACE}`, 'iud'),
]

/** What you're telling Plutus, when the sentence tells it where you were (or weren't); null for a question. */
export function readStay(sentence: string, ctx: AskContext): StayReading | null {
  const s = sentence.normalize('NFC').replace(/[’‘]/g, "'").replace(/[–—]/g, '-').trim()
  if (!s || s.includes('?') || QUESTION.test(s)) return null
  const future = /\b(will be|'ll be|shall be|am going|are going|going to be|plan(?:ning)? to be|next (?:week|month|year))\b/i.test(s)

  // forgetting: every place ("forget all my places"), or one
  if (/\b(?:forget|remove|delete|clear|erase)\b(?:\s+(?:all|every|my|the))*\s+(?:places|stays|trips)\b/i.test(s)) {
    const days = dayRange(s.toLowerCase(), ctx.today, future)
    return { kind: 'forget', place: null, region: null, start: days?.start ?? null, end: days?.end ?? null }
  }
  for (const re of FORGET) {
    const found = placeIn(s.match(re), s)
    if (found) {
      const days = dayRange(found.rest.toLowerCase(), ctx.today, future)
      return { kind: 'forget', place: known(found.place, ctx), region: found.region, start: days?.start ?? null, end: days?.end ?? null }
    }
  }
  for (const re of STAYED) {
    const found = placeIn(s.match(re), s)
    if (found) {
      const days = dayRange(found.rest.toLowerCase(), ctx.today, future)
      return { kind: 'stay', place: known(found.place, ctx), region: found.region, start: days?.start ?? null, end: days?.end ?? null }
    }
  }
  return null
}

/** The place a pattern caught in the sentence, cut where its name ends ("Goa from 1 Jan" → "Goa") and tidied, with its
 *  state: one written after it (", WB", " (WB)", " WB"), or the one it is ("Goa", "Jammu and Kashmir"; "Goa Velha" is a
 *  place in Goa, not Goa). `rest`: the sentence without them, to read the days from. Null if nothing's left. */
function placeIn(m: RegExpMatchArray | null, s: string): { place: string; region: string | null; rest: string } | null {
  const at = m?.indices?.[1]?.[0]
  if (!m || at === undefined) return null
  const codes = codesReadIn(s)
  const code = (word: string) => codes && isStateCode(word.replace(/[.,]+$/, ''))
  const month = new RegExp(`^${MONTH_RE}$`)
  // where a name can end: nothing more, a mark, a word about when, or a state's code
  const endsAt = (i: number) => {
    const next = s.slice(i).match(/^\s*(\S*)/)![1]
    const bare = next.toLowerCase().replace(/[.,']+$/, '')
    return !next || /^[,.;:!?)(]/.test(next) || STOP.has(bare) || /\d/.test(next) || month.test(bare) || code(next)
  }
  let name: string | null = null
  let end = at
  const state = s.slice(at).match(STATE_NAME)
  if (state && endsAt(at + state[0].length)) {
    // a state, its name whole even with "and" in it
    name = state[0]
    end = at + state[0].length
  } else {
    const words: string[] = []
    for (const w of m[1].matchAll(/\S+/g)) {
      const bare = w[0].toLowerCase().replace(/[.,']+$/, '')
      if (words.length && code(w[0])) break // "Darjeeling WB": its state, after it
      if (!code(w[0]) && (STOP.has(bare) || /\d/.test(w[0]) || month.test(bare))) break
      const word = w[0].replace(/[.,]+$/, '')
      words.push(word)
      end = at + w.index! + word.length
    }
    name = words.join(' ')
  }
  const stated = name ? asStated(name) : null
  if (!stated) return null
  const after = stateAt(s.slice(end), codes)
  return { place: stated.place, region: after?.region ?? stated.region, rest: `${s.slice(0, at)} ${s.slice(end + (after?.length ?? 0))}` }
}

/** A place you've told before, as you first wrote it ("goa" is your "Goa"). */
const known = (place: string, ctx: AskContext) => ctx.places.find((p) => placeKey(p) === placeKey(place)) ?? place

/** The days a sentence names: "1st Jan 2026 to 5th March 2026", "1-5 Jan", "Jan 1 - Mar 5", "01/01/2026 to 05/03/2026",
 *  "2026-01-01 to 2026-03-05", "since 3 Mar", "on 12 Jan", and everything a question's period can be ("in December",
 *  "last week", "from March to June 2025"). A day without its year is the latest such day that has begun, or, when you
 *  say you will be somewhere, the next. Null when it names no days, or days that aren't real or are out of order. */
export function dayRange(lower: string, today: string, future = false): { start: string; end: string } | null {
  let text = ` ${lower.replace(/(\d{1,2})(?:st|nd|rd|th)\b/g, '$1').replace(/(\d{1,2})\s+of\s+/g, '$1 ').replace(/,/g, ' ').replace(/\s+/g, ' ')} `
  const D = '(\\d{1,2})'
  const Y = '(?:\\s+(\\d{4}))?'
  const M = MONTH_RE
  const SEP = '\\s*(?:-|to|till|until|through|thru|and)\\s*(?:the\\s+)?' // "to the 5th"
  const month = (name: string) => monthIndex(name) + 1
  const m = (re: string) => text.match(new RegExp(re))
  let r: RegExpMatchArray | null
  // whole days, both ends named
  if ((r = m(`\\b${D}\\s+${M}${Y}${SEP}${D}\\s+${M}${Y}\\b`))) return resolve([+r[1], month(r[2]), r[3]], [+r[4], month(r[5]), r[6]], today, future)
  if ((r = m(`\\b${M}\\s+${D}${Y}${SEP}${M}\\s+${D}${Y}\\b`))) return resolve([+r[2], month(r[1]), r[3]], [+r[5], month(r[4]), r[6]], today, future)
  if ((r = m(`\\b${D}${SEP}${D}\\s+${M}${Y}\\b`))) return resolve([+r[1], month(r[3]), r[4]], [+r[2], month(r[3]), r[4]], today, future)
  if ((r = m(`\\b${M}\\s+${D}${SEP}${D}${Y}\\b`))) return resolve([+r[2], month(r[1]), r[4]], [+r[3], month(r[1]), r[4]], today, future)
  if ((r = m(`\\b(\\d{4})-(\\d{2})-(\\d{2})${SEP}(\\d{4})-(\\d{2})-(\\d{2})\\b`))) return resolve([+r[3], +r[2], r[1]], [+r[6], +r[5], r[4]], today, future)
  if ((r = m(`\\b(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?${SEP}(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?\\b`))) {
    return resolve([+r[1], +r[2], r[3] && fullYear(r[3])], [+r[4], +r[5], r[6] && fullYear(r[6])], today, future)
  }
  // from a day on: "since 3 Mar", "from 3 March till now"
  if ((r = m(`\\b(?:since|from)\\s+${D}\\s+${M}${Y}(?:\\s+(?:till|until|to)\\s+(?:now|today|date))?\\b`))) {
    const start = resolve([+r[1], month(r[2]), r[3]], [+r[1], month(r[2]), r[3]], today, false)
    return start && start.start <= today ? { start: start.start, end: today } : null
  }
  // one end only ("until 5 Jan", "up to 5 Jan", "before 5 Jan", "after 5 Jan"): not that one day; the reply asks when
  if (new RegExp(`\\b(?:to|till|until|before|after|by)\\s+(?:${D}\\s+${M}|${M}\\s+${D}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2})\\b`).test(text)) return null
  // one day: "on 12 Jan", "Jan 12 2026", "12/01/2026", "2026-01-12"
  if ((r = m(`\\b${D}\\s+${M}${Y}\\b`))) return resolve([+r[1], month(r[2]), r[3]], [+r[1], month(r[2]), r[3]], today, future)
  if ((r = m(`\\b${M}\\s+${D}${Y}\\b`))) return resolve([+r[2], month(r[1]), r[3]], [+r[2], month(r[1]), r[3]], today, future)
  if ((r = m(`\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`))) return resolve([+r[3], +r[2], r[1]], [+r[3], +r[2], r[1]], today, future)
  if ((r = m(`\\b(\\d{1,2})[/.](\\d{1,2})[/.](\\d{2,4})\\b`))) return resolve([+r[1], +r[2], fullYear(r[3])], [+r[1], +r[2], fullYear(r[3])], today, future)
  // "the second week of March", "early January", "the end of May": part of a month, which the rules won't widen to the
  // whole of it; left for the local AI, or for you to say the days
  if (/\b(?:first|second|third|fourth|early|mid|middle|late|end|beginning|start|half|fortnight|couple|few)\b/.test(text)) return null
  // a question's periods: months, years, seasons, "last week", "today"
  const take = (re: RegExp) => {
    const found = text.match(re)
    if (found) text = text.slice(0, found.index) + ' '.repeat(found[0].length) + text.slice(found.index! + found[0].length)
    return found
  }
  const [p] = periodsOf(take, today, (re) => text.match(re))
  if (!p) return null
  // a month or season said of a time to come is the next one, not the last
  if (future && p.to < today) return { start: `${Number(p.from.slice(0, 4)) + 1}${p.from.slice(4)}`, end: lastOrSame(`${Number(p.to.slice(0, 4)) + 1}${p.to.slice(4)}`) }
  return { start: p.from, end: p.to }
}

/** "2027-02-29" isn't a day: the last of its month. */
function lastOrSame(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${pad(m)}-${pad(Math.min(d, last))}`
}

/** Two days from [day, month, year or nothing]: the missing year taken from the other end, else the latest that has
 *  begun (or, `future`, the next that hasn't ended); a span crossing the new year ("28 Dec to 3 Jan") runs into the
 *  next. Null for a day that doesn't exist, or an end before the start. */
function resolve(a: [number, number, string | number | undefined], b: [number, number, string | number | undefined], today: string, future: boolean) {
  const day = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d))
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
  }
  const ya = a[2] ? Number(a[2]) : null
  const yb = b[2] ? Number(b[2]) : null
  const wraps = a[1] > b[1] || (a[1] === b[1] && a[0] > b[0])
  let [startYear, endYear] = ya && yb ? [ya, yb] : yb ? [wraps ? yb - 1 : yb, yb] : ya ? [ya, wraps ? ya + 1 : ya] : [0, 0]
  if (!ya && !yb) {
    const ty = Number(today.slice(0, 4))
    ;[startYear, endYear] = [ty, wraps ? ty + 1 : ty]
    const start = day(startYear, a[1], a[0])
    const end = day(endYear, b[1], b[0])
    if (!start || !end) return null
    if (!future && start > today) [startYear, endYear] = [startYear - 1, endYear - 1]
    if (future && end < today) [startYear, endYear] = [startYear + 1, endYear + 1]
  }
  const start = day(startYear, a[1], a[0])
  const end = day(endYear, b[1], b[0])
  return start && end && start <= end ? { start, end } : null
}
