import type { Stay, Transaction } from '../types'
import { bucketOf, isLinkedRefund, topOf, type LedgerData } from './ledger'
import { inPeriod, type PeriodKey } from './periods'

/** Where you were, as you told Plutus (data/places.json): a stay is a place and its days. A payment's place comes from
 *  its day, the day it counts on everywhere (a refund taken off a payment, that payment's day), and the stay you told
 *  most recently that covers that day; nothing is stored on the payment, so a stay changes no figure, and a file for
 *  those days added later has its place too. The place's spending is counted as Total spend counts it, by the same
 *  buckets; card spending known only from bills has no days, so no place. */

const dayOf = (t: Transaction) => t.at.slice(0, 10)

/** The stay that says where you were on `day`: of those covering it, the one told most recently. */
export function stayOn(day: string, stays: Stay[]): Stay | null {
  let best: Stay | null = null
  for (const s of stays) if (s.start <= day && day <= s.end && (!best || s.addedAt > best.addedAt)) best = s
  return best
}

/** Two names, one place: case, spaces and commas aside ("goa", "Goa"; "Aurangabad, MH", "aurangabad mh"). */
export const placeKey = (name: string) => name.replace(/,/g, ' ').trim().replace(/\s+/g, ' ').toLowerCase()
export const samePlace = (a: string, b: string) => placeKey(a) === placeKey(b)

// ---- states ----------------------------------------------------------------------------------------------------------

/** India's 28 states and 8 union territories, by their number-plate codes (Telangana's TG since March 2024; the merged
 *  Dadra and Nagar Haveli and Daman and Diu's DD since January 2020). The same for everyone, like the category tree, and
 *  the same table as the server's (backend/app/places.py `STATES`; a test holds the two the same). */
export const STATES: Record<string, string> = {
  AN: 'Andaman and Nicobar Islands', AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar',
  CH: 'Chandigarh', CG: 'Chhattisgarh', DD: 'Dadra and Nagar Haveli and Daman and Diu', DL: 'Delhi', GA: 'Goa',
  GJ: 'Gujarat', HR: 'Haryana', HP: 'Himachal Pradesh', JK: 'Jammu and Kashmir', JH: 'Jharkhand', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', LD: 'Lakshadweep', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OD: 'Odisha', PY: 'Puducherry', PB: 'Punjab', RJ: 'Rajasthan',
  SK: 'Sikkim', TN: 'Tamil Nadu', TG: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand',
  WB: 'West Bengal',
}
/** The official (ISO 3166-2:IN) codes where they differ, and the old ones, taken as the codes above. */
const ALIASES: Record<string, string> = { CT: 'CG', UT: 'UK', TS: 'TG', OR: 'OD', DN: 'DD', DH: 'DD' }
/** Names people still write: a state's old name, or one of the two territories merged into DD. */
const OLD_NAMES: Record<string, string> = {
  Orissa: 'OD', Pondicherry: 'PY', Uttaranchal: 'UK', 'Andaman and Nicobar': 'AN', 'Dadra and Nagar Haveli': 'DD',
  'Daman and Diu': 'DD', 'J&K': 'JK',
}

/** A place and, when you gave it (or it is one), its state. */
export interface Place {
  place: string
  region?: string | null
}

const nameKey = (name: string) => placeKey(name.replace(/&/g, ' and '))
const BY_NAME = new Map<string, string>([
  ...Object.entries(STATES).map(([code, name]) => [nameKey(name), code] as const),
  ...Object.entries(OLD_NAMES).map(([name, code]) => [nameKey(name), code] as const),
])
/** A state by its name, as people write it ("west bengal", "Orissa", "Jammu & Kashmir"); null for anything else. */
export const stateNamed = (name: string): string | null => BY_NAME.get(nameKey(name)) ?? null
/** A state's code from its code, in any case (the official and old ones too), or its name; null for anything else. */
export function regionOf(written: string): string | null {
  const code = written.trim().toUpperCase()
  return STATES[code] ? code : ALIASES[code] ?? stateNamed(written)
}

/** "Darjeeling, WB"; a place that is a state itself, by its name alone ("Goa"). */
export function placeLabel(p: Place): string {
  return p.region && STATES[p.region] && regionOf(p.place) !== p.region ? `${p.place}, ${p.region}` : p.place
}
/** The same with the state's name ("Darjeeling, West Bengal"): for hover, and for search. */
export function placeTitle(p: Place): string {
  return p.region && STATES[p.region] && regionOf(p.place) !== p.region ? `${p.place}, ${STATES[p.region]}` : p.place
}

/** Whether a place asked about is this stay's: by its name ("Darjeeling"), its name with its state ("Darjeeling, WB",
 *  "Darjeeling, West Bengal"), or its state alone ("West Bengal", "WB"). A stay told without a state is found by its
 *  name only. */
export function placeMatches(word: string, stay: Place): boolean {
  if (samePlace(word, stay.place)) return true
  if (!stay.region) return false
  const key = placeKey(word)
  return [placeLabel(stay), placeTitle(stay), `${stay.place} ${stay.region}`].some((w) => placeKey(w) === key) || regionOf(word) === stay.region
}

/** Two stays, one place: the same name, in the same state or with one of them told without a state. */
const sameStayPlace = (a: Place, b: Place) => samePlace(a.place, b.place) && (!a.region || !b.region || a.region === b.region)

const words = (name: string) => name.split(' ').map((w) => (w === 'and' ? '(?:and|&)' : w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('\\s+')
const NAMES = [...Object.values(STATES), ...Object.keys(OLD_NAMES)].sort((a, b) => b.length - a.length).map(words).join('|')
const CODES = Object.keys(STATES).join('|')
const ANY_CODE = [...Object.keys(STATES), ...Object.keys(ALIASES)].join('|')
const END = String.raw`(?![\p{L}\p{N}])`
const NAME_AFTER = new RegExp(String.raw`^\s*(?:,\s*|\(\s*)(${NAMES})(?:\s*\))?${END}`, 'iu')
const CODE_AFTER = new RegExp(String.raw`^(?:\s*(?:,\s*|\(\s*)(${ANY_CODE})(?:\s*\))?|\s+(${CODES}))${END}`, 'u')
const NAME_IN = new RegExp(String.raw`(?<![\p{L}\p{N}])(${NAMES})${END}`, 'giu')
const CODE_IN = new RegExp(String.raw`(?:(?<![\p{L}\p{N}])[Ii][Nn]\s+(${CODES})|,\s*(${ANY_CODE}))${END}`, 'gu')
/** A state's name at the start of some text, any case ("West Bengal from 1 Jan"). */
export const STATE_NAME = new RegExp(String.raw`^(${NAMES})${END}`, 'iu')
/** A state's code as people write it today: in capitals. */
export const isStateCode = (word: string) => new RegExp(`^(?:${CODES})$`, 'u').test(word)
/** Whether codes can be told from words in this text: not when it's all in capitals ("GO UP", "GOA OR KERALA"). */
export const codesReadIn = (text: string) => /\p{Ll}/u.test(text)

/** A state written just after a place: ", WB", " WB", " (WB)", ", West Bengal". A code only in capitals (`codes`: the
 *  text isn't all capitals), as in small letters it can be a word ("up to", "as"); after a plain space, only today's
 *  codes ("Lucknow UP"), an old one only after a comma or in brackets ("Hyderabad, TS"; "Goa OR Kerala" is "or"). A
 *  name only after a comma or in brackets: without, it can be part of the place's own ("North Goa", "New Delhi"). Its
 *  code and how much of the text it takes; null if there's none. */
export function stateAt(text: string, codes = true): { region: string; length: number } | null {
  const m = text.match(NAME_AFTER) ?? (codes ? text.match(CODE_AFTER) : null)
  const region = m && regionOf(m[1] ?? m[2])
  return m && region ? { region, length: m[0].length } : null
}

/** The states some text names: by name, any case ("West Bengal"), or (`codes`) by code in capitals after "in" ("in WB",
 *  today's codes) or a comma (", TS", any); each with where it is. */
export function statesIn(text: string, codes = true): { region: string; at: number; length: number }[] {
  const out = [...text.matchAll(NAME_IN)].map((m) => ({ region: regionOf(m[1])!, at: m.index!, length: m[1].length }))
  for (const m of codes ? text.matchAll(CODE_IN) : []) {
    const code = m[1] ?? m[2]
    const at = m.index! + m[0].length - code.length
    if (!out.some((o) => o.at <= at && at < o.at + o.length)) out.push({ region: regionOf(code)!, at, length: code.length })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** A place as the local AI copied it from your sentence ("Darjeeling, WB", "goa"): its name, with the state written
 *  after it or the state it is; null if it isn't a place's name. */
export function parsePlace(text: string): { place: string; region: string | null } | null {
  const t = text.trim()
  for (const i of [t.lastIndexOf(','), t.lastIndexOf('('), t.lastIndexOf(' ')]) {
    const state = i > 0 ? stateAt(t.slice(i), codesReadIn(t)) : null
    const name = state && i + state.length === t.length ? cleanPlace(t.slice(0, i)) : null
    if (state && name) return { place: name, region: state.region }
  }
  return asStated(t)
}

/** A place's name tidied, and the state it is when it is one ("goa" → Goa, GA; "west bengal" → West Bengal, WB): the
 *  state's own name when written as it, else as you wrote it ("Orissa"). */
export function asStated(written: string): { place: string; region: string | null } | null {
  const name = cleanPlace(written)
  if (!name) return null
  const region = stateNamed(name)
  return { place: region && nameKey(STATES[region]) === nameKey(name) ? STATES[region] : name, region }
}

/** The places you told before by this name with a state ("Darjeeling, WB"): what it likely is again, the latest told
 *  first. Empty when you never gave it one. */
export function toldBefore(place: string, stays: Stay[]): { place: string; region: string }[] {
  const out = new Map<string, { place: string; region: string }>()
  for (const s of [...stays].sort((a, b) => b.addedAt.localeCompare(a.addedAt))) {
    if (s.region && samePlace(s.place, place) && !out.has(s.region)) out.set(s.region, { place: s.place, region: s.region })
  }
  return [...out.values()]
}

/** The day a payment counts on: a refund taken off its payment, that payment's day (as viewFor dates it). */
function countsOn(data: LedgerData) {
  const byId = new Map([...data.txns, ...data.leftOut].map((t) => [t.id, t]))
  return (t: Transaction) => dayOf((isLinkedRefund(t) && byId.get(t.refundOf!)) || t)
}

/** Each payment's stay, by payment id; payments on days no stay covers have none. */
export function staysOf(data: LedgerData): Map<string, Stay> {
  const out = new Map<string, Stay>()
  if (!data.stays.length) return out
  const on = countsOn(data)
  for (const t of [...data.txns, ...data.leftOut]) {
    const s = stayOn(on(t), data.stays)
    if (s) out.set(t.id, s)
  }
  return out
}

/** What a stay holds in a period: the days it says where you were (a day two stays share goes to the latest told),
 *  what you spent on them, as Total spend counts it, and the payments behind it. */
export interface StaySummary {
  stay: Stay
  /** Its days in the period that are still its own. */
  days: number
  spent: number
  /** Payments (refunds taken off them, not counted). */
  payments: number
  /** The payments and their refunds: what "Show payments" opens. */
  ids: string[]
  /** Its spending by top-level category, biggest first. */
  categories: { id: string; amount: number }[]
  /** About how much card spending estimated from bills falls on its days (`estimatedOver`): no payments, so no place. */
  estimated: number
}

const DAY = 86_400_000
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10)
export const daysBetween = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1

/** The stays with days in the period, latest first, each with what it holds there. */
export function staysIn(data: LedgerData, period: PeriodKey): StaySummary[] {
  const on = countsOn(data)
  const summaries = new Map<string, StaySummary>()
  for (const s of data.stays) {
    if (period !== 'all' && !(s.start <= `${period}-12-31` && `${period}-01-01` <= s.end)) continue
    const own = new Set<string>()
    for (let d = s.start; d <= s.end; d = shift(d, 1)) if (inPeriod(d, period) && stayOn(d, data.stays)?.id === s.id) own.add(d)
    summaries.set(s.id, { stay: s, days: own.size, spent: 0, payments: 0, ids: [], categories: [], estimated: estimatedOver(data, own) })
  }
  const byCategory = new Map<string, Map<string, number>>()
  for (const t of data.txns) {
    if (bucketOf(t) !== 'spent') continue
    const day = on(t)
    if (!inPeriod(day, period)) continue
    const s = stayOn(day, data.stays)
    const summary = s && summaries.get(s.id)
    if (!summary) continue
    const amount = isLinkedRefund(t) ? -t.amount : t.amount
    summary.spent += amount
    summary.payments += isLinkedRefund(t) ? 0 : 1
    summary.ids.push(t.id)
    const cats = byCategory.get(s.id) ?? new Map<string, number>()
    cats.set(topOf(t.category), (cats.get(topOf(t.category)) ?? 0) + amount)
    byCategory.set(s.id, cats)
  }
  for (const [id, cats] of byCategory) {
    summaries.get(id)!.categories = [...cats].map(([c, amount]) => ({ id: c, amount })).filter((c) => c.amount > 0.5).sort((a, b) => b.amount - a.amount)
  }
  return [...summaries.values()].sort((a, b) => b.stay.start.localeCompare(a.stay.start) || b.stay.addedAt.localeCompare(a.stay.addedAt))
}

/** The days the stays with these names say where you were (the days still theirs), within any of these periods
 *  (null: every day). */
export function placeDays(data: LedgerData, names: string[], periods: ({ from: string; to: string } | null)[]): Set<string> {
  const out = new Set<string>()
  for (const s of data.stays) {
    if (!names.some((n) => placeMatches(n, s))) continue
    for (let d = s.start; d <= s.end; d = shift(d, 1)) {
      if (stayOn(d, data.stays)?.id === s.id && periods.some((p) => !p || (p.from <= d && d <= p.to))) out.add(d)
    }
  }
  return out
}

/** About how much card spending estimated from bills falls on these days: each bill that pays no statement you added,
 *  its estimate spread evenly over the days of the cycle it paid for, as Total spend spreads it. A bill has no
 *  payments, so this spending has no place: answers about a place say how much they leave out. */
export function estimatedOver(data: LedgerData, days: Set<string>): number {
  if (!days.size) return 0
  let sum = 0
  for (const p of data.payments) {
    if (p.coveredBy) continue
    const [from, to] = p.paysFrom && p.paysTo ? [p.paysFrom, p.paysTo] : [`${p.at.slice(0, 7)}-01`, lastDayOfMonth(p.at.slice(0, 7))]
    let inside = 0
    for (let d = from; d <= to; d = shift(d, 1)) if (days.has(d)) inside++
    if (inside) sum += ((p.estimate ?? p.amount) * inside) / daysBetween(from, to)
  }
  return sum
}

const lastDayOfMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

/** What telling a stay would do, shown before it's kept: the payments on its days and what was spent on them (a new
 *  stay is the latest told, so every one of its days becomes its own), and the days it takes from stays told before. */
export function stayPreview(data: LedgerData, start: string, end: string, place: string, region: string | null = null) {
  const on = countsOn(data)
  let payments = 0
  let spent = 0
  const ids: string[] = []
  for (const t of data.txns) {
    const day = on(t)
    if (day < start || day > end) continue
    ids.push(t.id)
    if (!isLinkedRefund(t)) payments++
    if (bucketOf(t) === 'spent') spent += isLinkedRefund(t) ? -t.amount : t.amount
  }
  // the days it takes from earlier stays, said by the place they were (the same place told again takes nothing new)
  const taken: { stay: Stay; start: string; end: string }[] = []
  for (const s of [...data.stays].sort((a, b) => a.start.localeCompare(b.start))) {
    const from = s.start > start ? s.start : start
    const to = s.end < end ? s.end : end
    if (from <= to && !sameStayPlace(s, { place, region })) taken.push({ stay: s, start: from, end: to })
  }
  return { days: daysBetween(start, end), payments, spent, ids, taken }
}

/** A place as you'd want it kept: spaces tidied; written all in small letters, made a name ("north goa" → "North
 *  Goa"). The same rule as the server's (backend/app/places.py): up to 40 letters, digits and plain marks, no line
 *  breaks; null otherwise. */
export function cleanPlace(raw: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name || name.length > 40 || !/^[\p{L}\p{N}_][\p{L}\p{N}_ .,'&()/-]*$/u.test(name)) return null
  return name === name.toLowerCase() ? name.replace(/(^|[\s(/-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase()) : name
}
