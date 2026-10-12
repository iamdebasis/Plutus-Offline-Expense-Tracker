// Every figure the dashboard shows in more than one place agrees, every year, investments counted or left out; the
// investments switch moves exactly what it says it leaves out; Ask Plutus answers with the same numbers.
import { rupees, sleep } from './browser.mjs'

// What each section says, read off the page
const FIGURES = `(() => {
  const S = (h2) => [...document.querySelectorAll('section')].find((s) => s.querySelector(':scope > header h2')?.textContent.trim() === h2)
  const num = (t) => (t == null ? null : Number(String(t).replace(/[^\\d.\\-]/g, '')))
  const out = { terms: {}, where: [], upiWhere: [], faces: [] }
  const total = S('Total spend')
  for (const div of total?.querySelectorAll('dl > div') ?? []) out.terms[div.querySelector('dt').textContent.trim()] = num(div.querySelector('dd').textContent)
  out.where = [...(total?.querySelectorAll('ul > li > button') ?? [])].map((b) => [b.querySelector('span.truncate')?.textContent.trim(), num(b.querySelector('span.text-zinc-100')?.textContent)])
  const hero = (label) => num([...document.querySelectorAll('p')].find((p) => p.textContent.trim() === label)?.nextElementSibling?.textContent)
  out.upi = hero('Spent via UPI')
  out.cards = hero('Spent with your cards')
  const cards = S('Credit cards')
  out.faces = [...(cards?.querySelectorAll('figure figcaption') ?? [])].map((f) => ({ amount: num(f.querySelector('p')?.textContent), what: f.querySelectorAll('p')[1]?.textContent.trim() }))
  out.cardNote = cards?.querySelector(':scope > header p')?.textContent.trim()
  const upiWhere = [...(S('UPI spends')?.querySelectorAll('section') ?? [])].find((p) => p.querySelector('h3')?.textContent.trim() === 'Where it went')
  out.upiWhere = [...(upiWhere?.querySelectorAll('ul > li > button') ?? [])].map((b) => num(b.querySelector('span.text-zinc-100')?.textContent))
  out.leftOut = num(document.querySelector('main')?.innerText.match(/Investments:\\s*₹([\\d,]+) left out/)?.[1])
  return out
})()`

export default async function money(s) {
  console.log('\nthe money: every place a figure shows, the same')
  await s.size(1440, 900)
  await s.motion()
  await s.load()
  const tab = (year) => s.evaluate(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(year)}).click()`)
  const counting = () => s.evaluate(`document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true'`)
  const setCounting = async (on) => {
    if ((await counting()) !== on) {
      await s.evaluate(`document.querySelector('[role=switch]').click()`)
      await sleep(1200)
    }
  }
  const allInTable = (panel) => s.evaluate(`(() => { const p = ${panel}; const b = (t) => [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === t); b('All')?.click(); b('Show table')?.click(); return true })()`)
  const together = (panel) => s.evaluate(`(() => { const last = [...${panel}.querySelectorAll('table tbody tr')].at(-1); return last ? Number(last.querySelector('td:last-child').textContent.replace(/[^\\d.]/g, '')) : null })()`)
  const totals = {}
  const years = await s.evaluate(`[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim())`)

  for (const on of [false, true]) {
    for (const year of years) {
      const tag = `${year}, investments ${on ? 'counted' : 'left out'}`
      await s.load()
      await setCounting(on)
      await tab(year)
      await sleep(1200)
      const f = await s.evaluate(FIGURES)
      const t = f.terms
      totals[tag] = { total: t.total, leftOut: f.leftOut }
      console.log(`  ${tag}: Total spend ₹${t.total} = UPI ₹${f.upi} + cards ₹${f.cards}`)
      s.near((t.UPI ?? 0) + (t['cards, from statements'] ?? 0) + (t['cards, estimated from bills'] ?? 0), t.total, 2, `${tag}: the sum line adds up`)
      s.near(t.UPI ?? 0, f.upi ?? 0, 1, `${tag}: its UPI = UPI spends' Spent via UPI`)
      s.near((t['cards, from statements'] ?? 0) + (t['cards, estimated from bills'] ?? 0), f.cards ?? 0, 2, `${tag}: its cards = Credit cards' Spent with your cards`)
      s.near(f.where.reduce((n, [, v]) => n + v, 0), t.total, f.where.length, `${tag}: Where it went adds up to Total spend`)
      if (f.upi) s.near(f.upiWhere.reduce((n, v) => n + v, 0), f.upi, f.upiWhere.length, `${tag}: UPI's Where it went adds up to Spent via UPI`)
      if (f.cards) {
        const spent = f.faces.filter((x) => / · spent$/.test(x.what ?? ''))
        s.near(spent.reduce((n, x) => n + x.amount, 0), f.cards, 1 + spent.length, `${tag}: the cards drawn add up to Spent with your cards`)
        s.near(rupees(f.cardNote?.match(/₹[\d,]+(?= spent with cards)/)?.[0]), f.cards, 1, `${tag}: Credit cards' heading says the same`)
        await allInTable(s.panel('Credit cards', 'Month by month'))
        await sleep(500)
        s.near(await together(s.panel('Credit cards', 'Month by month')), f.cards, 2, `${tag}: the cards' month table comes to it too`)
      }
      await allInTable(`${s.section('Month by month')}.querySelector('section')`)
      await sleep(500)
      s.near(await together(`${s.section('Month by month')}.querySelector('section')`), t.total, 2, `${tag}: the month table, every category ticked, comes to Total spend`)
    }
  }
  for (const year of years) {
    const off = totals[`${year}, investments left out`]
    const on = totals[`${year}, investments counted`]
    s.near(on.total - off.total, off.leftOut ?? 0, 2, `${year}: counting investments adds exactly what was left out`)
  }

  console.log('\nAsk Plutus: the dashboard\'s numbers')
  await s.load()
  await setCounting(false)
  const year = years.filter((y) => /^\d{4}$/.test(y)).at(-1)
  await tab(year)
  await sleep(1000)
  const f = await s.evaluate(FIGURES)
  const PANEL = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
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
  const first = (text) => rupees(text.match(/₹[\d,]+(\.\d\d)?/)?.[0])
  s.near(first(await ask(`How much did I spend in ${year}?`)), f.terms.total, 1, `"How much did I spend in ${year}?" = Total spend`)
  // the three biggest categories (card purchases known only from bills aren't a category you'd ask about by name)
  for (const [name, want] of f.where.filter(([n]) => !['Card purchases', 'Uncategorized'].includes(n)).slice(0, 3)) {
    const words = name.toLowerCase()
    s.near(first(await ask(`How much on ${words} in ${year}?`)), want, 1, `"How much on ${words} in ${year}?" = its bar in Where it went`)
  }
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
}
