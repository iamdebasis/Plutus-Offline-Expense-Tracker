import type { Category } from './ledger'

/** The words for each category, the same for everyone: its name, and what people call it besides (below). One list for
 *  every place that reads a category from words: Ask Plutus's rules (lib/askRules.ts, which match whole phrases in a
 *  question) and the search in Your transactions (`categoriesMatching`, as you type). */

/** What people call a category, besides its name. Indian usage included ("bijli", "EB bill", "kirana", "SIP"). */
export const SYNONYMS: Record<string, string[]> = {
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

/** Lower case, accents gone, "&" said, only letters and digits: "Restaurants & cafés" → "restaurants and cafes". */
const plain = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, '').replace(/&/g, ' and ').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Fewer letters than this name too many categories to be useful ("a", "ba"). */
const MIN_LETTERS = 3
/** Words in categories' names that name none of them. */
const NOT_NAMES = new Set(['and', 'the', 'for', 'with', 'from'])

/** The categories a search names by their words, as you type it: those with a word of their name, or of a word people
 *  use for them, starting with what you typed ("bar" → Bars & liquor, "sho" → Shopping, "kirana" → Local stores,
 *  "cafes" → Restaurants & cafés), or a plural of one of those words ("liquors"). In the tree's order: what the search
 *  shows as chips, to narrow to one. Nothing for fewer than three letters or for a joining word; a number names none
 *  (no category's words have digits), so amounts are matched as amounts. */
export function categoriesNamed(query: string, categories: Map<string, Category>): string[] {
  const q = plain(query)
  if (q.replace(/ /g, '').length < MIN_LETTERS || NOT_NAMES.has(q)) return []
  const starts = new RegExp(`(?:^| )${escape(q)}`)
  const singular = q.length > MIN_LETTERS && q.endsWith('s') ? new RegExp(`(?:^| )${escape(q.slice(0, -1))}(?: |$)`) : null
  const names = (words: string) => {
    const p = plain(words)
    return starts.test(p) || !!singular?.test(p)
  }
  return [...categories.values()].filter((c) => names(c.label) || (SYNONYMS[c.id] ?? []).some(names)).map((c) => c.id)
}

/** Every category a search finds payments in: those it names, and everything under a main one it names ("food" is all
 *  of Food & Dining). */
export function categoriesMatching(query: string, categories: Map<string, Category>): Set<string> {
  const out = new Set<string>()
  for (const id of categoriesNamed(query, categories)) {
    out.add(id)
    for (const c of categories.values()) if (c.parent === id) out.add(c.id)
  }
  return out
}
