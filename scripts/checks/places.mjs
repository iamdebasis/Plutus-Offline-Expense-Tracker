// Where you told Plutus you were, read off the page on the demo's week away (it changes nothing): each Places card's
// spending is what Ask Plutus says for the place, and what the API's payments add up to on its days, counted
// independently here; the Location column names the place on exactly those days' payments and nowhere else; the
// Place filter and the search find them; the table still fits from 1024px, a phone has the place on the day's line;
// every text reads and every control reaches, a told stay's card in Ask Plutus included (cancelled, never kept).
import { CONTRAST, TARGETS } from './access.mjs'
import { rupees, sleep } from './browser.mjs'

const amounts = (text) => [...String(text ?? '').matchAll(/₹[\d,]+(\.\d\d)?/g)].map((m) => rupees(m[0]))
const PANEL = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** "25 Sept 2026" → "2026-09-25", read here rather than by the browser's date parser. */
const isoOf = (label) => {
  const m = String(label).match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})/)
  return m ? `${m[3]}-${String(MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null
}

export default async function places(s) {
  console.log('\nPlaces: where you told Plutus you were')
  const get = async (path) => (await fetch(s.base + path)).json()
  const [stays, txns, prefs] = await Promise.all([get('/api/places'), get('/api/transactions'), get('/api/preferences')])
  const notSpending = new Set(['transfers', 'ignored', 'income', ...(prefs.countInvestments ? [] : ['investments'])])
  if (!s.check(stays.length > 0, `the demo has a place told (${stays.map((x) => `${x.place} ${x.start}…${x.end}`).join(', ')})`)) return
  const stay = stays[0]
  const year = stay.start.slice(0, 4)
  const tab = (label) => s.evaluate(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await s.size(1440, 900)
  await s.motion()
  await s.load()
  await tab(year)
  await sleep(800)

  // the card, against the API's payments added up here (investments left out, as the page leaves them)
  const byId = new Map(txns.map((t) => [t.id, t]))
  const dayOf = (t) => ((t.direction === 'credit' && t.refundOf && byId.get(t.refundOf)) || t).at.slice(0, 10)
  const top = (t) => ((t.direction === 'credit' && t.refundOf && byId.get(t.refundOf)) || t).category.split('.')[0]
  const onDays = txns.filter((t) => dayOf(t) >= stay.start && dayOf(t) <= stay.end)
  const spending = onDays.filter((t) => t.category !== 'transfers.self' && !notSpending.has(top(t)) && (t.direction === 'debit' || t.refundOf))
  const independent = spending.reduce((n, t) => n + (t.direction === 'debit' ? t.amount : -t.amount), 0)
  const card = await s.evaluate(`(() => { const c = document.querySelector('#places article[aria-label^=${JSON.stringify(stay.place)}]'); return c ? c.innerText : null })()`)
  s.check(!!card, `${stay.place}: a card in Places`)
  // the place as the page shows it: "Goa" (a state itself), or "Place, ST" with the state's name on hover
  const label = await s.evaluate(`document.querySelector('#places article[aria-label^=${JSON.stringify(stay.place)}] h3 span[title]')?.textContent`)
  const hover = await s.evaluate(`document.querySelector('#places article[aria-label^=${JSON.stringify(stay.place)}] h3 span[title]')?.getAttribute('title')`)
  s.check(label === stay.place ? hover === stay.place : label === `${stay.place}, ${stay.region}` && hover.startsWith(`${stay.place}, `) && hover.length > label.length,
    `its card shows ${label}${hover !== label ? `, ${hover} on hover` : ''}`)
  const spent = amounts(card)[0]
  s.near(spent, independent, 1, `${stay.place}: its card's spending is its days' payments, added up from the API`)

  const PLACE_Q = `How much did I spend in ${label} in ${year}?`
  await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').click()`)
  await s.until(`!!${PANEL}?.querySelector('input')`, 'the Ask panel')
  const ask = async (q) => {
    await s.evaluate(`(() => { const i = ${PANEL}.querySelector('input[aria-label="Your question"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(100)
    await s.evaluate(`${PANEL}.querySelector('button[aria-label="Ask"]').click()`)
    await s.until(`!${PANEL}.innerText.includes('Reading your question') && !${PANEL}.innerText.includes('is reading your question')`, `an answer to "${q}"`, 60)
    await sleep(400)
    return s.evaluate(`[...${PANEL}.querySelectorAll('[role=log] > *')].at(-1).innerText.replace(/\\s+/g, ' ')`)
  }
  s.near(amounts(await ask(PLACE_Q))[0], spent, 1, `"${PLACE_Q}" = its card`)
  const where = await ask(`Where was I in ${year}?`)
  s.check(where.includes(label) && amounts(where).some((a) => Math.abs(a - spent) <= 1), `"Where was I in ${year}?" names ${label}, with its card's figure`)
  // a told stay: its card shows what it would do; with no local AI and no state written, that it has none; cancelled,
  // nothing is kept
  const told = await ask(`I was in Fakepur from 1st Feb ${year} to 3rd Feb ${year}`)
  s.check(/Fakepur/.test(told) && /Mark as Fakepur/.test(told) && /3 days/.test(told) && /no state/i.test(told), 'telling a stay shows its days, a button to keep it, and that it has no state')
  const c = await s.evaluate(CONTRAST)
  const tg = await s.evaluate(TARGETS)
  s.check(!c.low.length && !tg.small.length, `the told stay's card reads and reaches ${JSON.stringify([...c.low, ...tg.small].slice(0, 3))}`)
  await s.evaluate(`[...${PANEL}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click()`)
  await sleep(500)
  s.check((await get('/api/places')).length === stays.length, 'cancelled: nothing kept')
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)

  // the Location column: the place on exactly its days' payments
  const LIST = `document.getElementById('transactions')`
  const table = () => s.evaluate(`(() => { const t = ${LIST}.querySelector('table'); if (!t) return null
    const head = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()); const at = head.indexOf('Location')
    return { head, rows: [...t.querySelectorAll('tbody tr')].filter((tr) => tr.children.length === head.length).map((tr) => ({ day: tr.children[1].textContent, place: tr.children[at]?.textContent.trim() })) } })()`)
  const inStay = (label) => {
    const iso = isoOf(label)
    return !!iso && iso >= stay.start && iso <= stay.end
  }
  const t = await table()
  s.check(!!t && t.head.indexOf('Location') === t.head.indexOf('Payee') + 1, `the list has a Location column after Payee (${t?.head.join(' · ')})`)
  s.check(t.rows.length > 20 && t.rows.every((r) => (r.place === label) === inStay(r.day)), `${label} beside every payment of its days, and no other`)
  await s.evaluate(`(() => { const sel = ${LIST}.querySelector('select[aria-label="Place"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(label)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
  await sleep(500)
  const only = await table()
  s.check(only.rows.length > 0 && only.rows.every((r) => r.place === label && inStay(r.day)), `the Place filter shows only ${label}'s payments (${only.rows.length})`)
  await s.load()
  await tab(year)
  await sleep(600)
  await s.evaluate(`(() => { const i = ${LIST}.querySelector('input[placeholder^="Search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(stay.place.toLowerCase())}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  await sleep(500)
  const found = await table()
  s.check(found.rows.length === only.rows.length, `searching "${stay.place.toLowerCase()}" finds the same payments (${found.rows.length})`)

  // a laptop and a phone
  for (const [tag, w, h, scale, mobile] of [['1024px', 1024, 768, 1, false], ['a phone', 390, 844, 2, true]]) {
    await s.size(w, h, scale, mobile)
    await s.load()
    await tab(year)
    await sleep(600)
    const shape = await s.evaluate(`({ table: !!${LIST}.querySelector('table'), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      places: !!document.getElementById('places'), lines: [...${LIST}.querySelectorAll('li')].filter((li) => li.innerText.includes(${JSON.stringify(stay.place)})).length })`)
    s.check(shape.places && !shape.sideways && shape.table === !mobile && (mobile ? shape.lines > 0 : true), `${tag}: Places shown, ${mobile ? `the place on the day's line (${shape.lines})` : 'the list a table'}, nothing sideways`)
    await s.evaluate(`document.getElementById('places').scrollIntoView()`)
    await sleep(1800) // the Ask orb steps aside while the page scrolls, and is back, full size, once it stops
    const pc = await s.evaluate(CONTRAST)
    const pt = await s.evaluate(TARGETS)
    s.check(!pc.low.length && !pt.small.length, `${tag}: Places reads and reaches ${JSON.stringify([...pc.low, ...pt.small].slice(0, 3))}`)
  }
  await s.size(1440, 900)
}
