// Searching Your transactions by category: typing a category's word finds its payments (a main category with
// everything under it) as well as payees with the word in their name; a chip names each category found, with how many,
// counted here from the API independently; a chip narrows the list to exactly that category, and its pill clears it;
// fewer than three letters names no category; Ignored payments come when asked for by name; a phone keeps it all on
// screen, readable and reachable.
import { CONTRAST, TARGETS } from './access.mjs'
import { sleep } from './browser.mjs'

export default async function search(s) {
  console.log('\nsearching Your transactions by category')
  const get = async (path) => (await fetch(s.base + path)).json()
  const [txns, tree] = await Promise.all([get('/api/transactions'), get('/api/categories')])
  const byId = new Map(txns.map((t) => [t.id, t]))
  const top = (id) => id.split('.')[0]
  const day = (t) => ((t.direction === 'credit' && t.refundOf && byId.get(t.refundOf)) || t).at.slice(0, 10) // as the list dates it
  const LIST = `document.getElementById('transactions')`
  const INPUT = `${LIST}.querySelector('input[aria-label^="Search payee"]')`
  await s.size(1440, 900)
  await s.motion()
  await s.load()
  const year = await s.evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()`)
  const inYear = txns.filter((t) => !/^\d{4}$/.test(year) || day(t).startsWith(year))
  const type = async (q) => {
    await s.evaluate(`(() => { const i = ${INPUT}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(600)
  }
  const look = () => s.evaluate(`(() => ({
    shown: Number((${LIST}.innerText.match(/(\\d+) shown/) ?? [])[1]),
    rows: [...${LIST}.querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('select')).map((tr) => ({ cat: tr.querySelector('select').value, text: tr.innerText.toLowerCase() })),
    chips: [...${LIST}.querySelectorAll('[role=group][aria-label="Categories your search names"] button')].map((b) => ({ name: b.firstChild.textContent.trim(), n: Number(b.lastChild.textContent) })),
    only: [...${LIST}.querySelectorAll('button')].map((b) => b.textContent.trim()).find((x) => x.startsWith('Only ')) ?? null,
    query: ${INPUT}.value,
  }))()`)

  s.check(await s.evaluate(`${INPUT}.placeholder === 'Search payee, category, UPI id or amount'`), 'the search says it finds categories too')
  const all = (await look()).shown

  // the main category with the most payments this year, searched by the first word of its name ("Food", in the demo)
  const counts = new Map()
  for (const t of inYear) counts.set(top(t.category), (counts.get(top(t.category)) ?? 0) + 1)
  const main = tree.filter((c) => !['transfers', 'ignored', 'income', 'uncategorized', 'investments'].includes(c.id)).sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]
  const word = main.label.split(/[^A-Za-z]+/)[0]
  const expected = inYear.filter((t) => top(t.category) === main.id).length
  await type(word)
  let v = await look()
  const lower = word.toLowerCase()
  s.check(expected > 0 && v.rows.length > 0 && v.rows.every((r) => top(r.cat) === main.id || r.text.includes(lower)),
    `"${word}": every payment shown is in ${main.label} (or has "${word}" in it) (${v.shown} shown)`)
  const chip = v.chips.find((c) => c.name === main.label)
  s.check(!!chip && chip.n === expected && v.shown >= expected, `its chip says ${main.label} has ${chip?.n}, counted from the API: ${expected}`)

  // a chip narrows the list to exactly that category; its pill clears it
  await s.evaluate(`[...${LIST}.querySelectorAll('[role=group][aria-label="Categories your search names"] button')].find((b) => b.firstChild.textContent.trim() === ${JSON.stringify(main.label)}).click()`)
  await sleep(600)
  v = await look()
  s.check(v.only === `Only ${main.label}` && v.query === '' && v.shown === expected && v.rows.every((r) => top(r.cat) === main.id),
    `its chip shows only ${main.label}: ${v.shown} payments, the search cleared, a pill to undo it`)
  await s.evaluate(`[...${LIST}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('Only ')).click()`)
  await sleep(600)
  v = await look()
  s.check(v.only === null && v.shown === all, `its pill brings every payment back (${v.shown})`)

  // too short to name a category; Ignored, by name
  await type(word.slice(0, 2))
  v = await look()
  s.check(v.chips.length === 0, `"${word.slice(0, 2)}": too short to name a category`)
  // Ignored, by name: one payment ignored for the check (as ticking it and choosing Ignored would), put back exactly after
  const post = (path, body) => fetch(s.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const one = inYear.find((t) => top(t.category) === main.id && !t.refundOf && !t.settles)
  const { before } = await post('/api/categorize/payments', { transactionIds: [one.id], category: 'ignored' })
  await s.load()
  await type('ignored')
  v = await look()
  s.check(v.rows.length > 0 && v.rows.every((r) => top(r.cat) === 'ignored') && v.rows.some((r) => r.text.includes(one.payee.toLowerCase())) && v.chips.some((c) => c.name === 'Ignored'),
    `"ignored": the ignored payments come without ticking "Show ignored" (${v.shown})`)
  await post('/api/categorize/payments/undo', before)
  s.check((await get('/api/transactions')).find((t) => t.id === one.id)?.category === one.category, 'and the payment ignored for the check is put back exactly')
  await s.load()

  // a phone: the chips wrap, nothing goes sideways, and they read and reach
  await s.size(390, 844, 2, true)
  await s.load()
  await type(word)
  const phone = await s.evaluate(`({ sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    chips: ${LIST}.querySelectorAll('[role=group][aria-label="Categories your search names"] button').length })`)
  await s.evaluate(`document.getElementById('transactions').scrollIntoView()`)
  await sleep(1800)
  const c = await s.evaluate(CONTRAST)
  const tg = await s.evaluate(TARGETS)
  s.check(phone.chips > 0 && !phone.sideways && !c.low.length && !tg.small.length,
    `a phone: the chips (${phone.chips}) wrap, nothing sideways, all read and reach ${JSON.stringify([...c.low, ...tg.small].slice(0, 3))}`)
  await type('')
  await s.size(1440, 900)
}
