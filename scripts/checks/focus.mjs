// What Total spend shows for what you tap, read off the page as you'd see it: each row's detail says the row's figure;
// its top payees (and "and N more") add up to it, biggest first; its biggest payments come in order; "Show all N" opens
// its N payments in Your transactions; Card purchases' cards, and a card's bills, add up to their estimates; Other's
// categories add up to it. With nothing tapped, the busiest month is Month by month's biggest month, and the biggest
// payment opens itself. On a phone the detail opens under the row you tapped. Every text reads, every control reaches.
import { CONTRAST, TARGETS } from './access.mjs'
import { rupees, sleep } from './browser.mjs'

const REGION = `[...document.querySelectorAll('[aria-label="What you tapped, in detail"]')].find((r) => r.getBoundingClientRect().width > 0)`
const amounts = (text) => [...String(text ?? '').matchAll(/₹[\d,]+(\.\d\d)?/g)].map((m) => rupees(m[0]))
const sum = (list) => list.reduce((s, v) => s + (v ?? 0), 0)

export default async function focus(s) {
  console.log('\nTotal spend: what you tap, in detail')
  const BARS = s.panel('Total spend', 'Where it went')
  const BREAKDOWN = s.panel('Total spend', 'Breakdown')
  const tab = (label) => s.evaluate(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const rows = () => s.evaluate(`[...${BARS}.querySelectorAll(':scope > ul > li > button')].map((b) => ({ name: b.querySelector('span.truncate').textContent.trim(), amount: Number(b.querySelector('span.text-zinc-100').textContent.replace(/[^\\d.]/g, '')) }))`)
  const tap = (name) => s.evaluate(`(() => { const b = [...${BARS}.querySelectorAll(':scope > ul > li > button')].find((b) => b.querySelector('span.truncate').textContent.trim() === ${JSON.stringify(name)}); b?.click(); return !!b })()`)
  const detail = () => s.evaluate(`(() => { const r = ${REGION}; if (!r) return null
    const list = (label) => [...(r.querySelector('ul[aria-label="' + label + '"]')?.children ?? [])].map((li) => li.innerText.replace(/\\s+/g, ' ').trim())
    return { line: r.querySelector('p.text-xs')?.innerText.trim(), payees: list('Top payees'), waiting: list('Waiting for a category'), biggest: list('Biggest payments'),
             cards: list('From your bills'), bills: list('Its bills'), other: list("What's in Other"),
             more: [...r.querySelectorAll('p')].map((p) => p.innerText).find((t) => /^and \\d+ more payee/.test(t)) ?? null,
             showAll: [...r.querySelectorAll('button')].map((b) => b.innerText.trim()).find((t) => /^Show all \\d+/.test(t)) ?? null } })()`)
  await s.size(1440, 900)
  await s.motion()
  await s.load()
  const years = await s.evaluate(`[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()).filter((t) => /^\\d{4}$/.test(t))`)
  const year = years.at(-1)

  const counts = []
  for (const period of [year, 'All years']) {
    await s.load()
    await tab(period)
    await sleep(800)
    for (const row of await rows()) {
      await tap(row.name)
      await sleep(500)
      const d = await detail()
      const tag = `${period}, ${row.name}`
      if (!s.check(!!d?.line, `${tag}: tapped, it opens in detail`)) continue
      s.near(amounts(d.line)[0], row.amount, 1, `${tag}: the detail says its figure`)
      if (row.name === 'Card purchases') {
        const cards = d.cards.map((t) => amounts(t.split('≈').at(-1))[0])
        s.near(sum(cards), row.amount, cards.length + 1, `${tag}: its cards add up to it`)
        await s.evaluate(`${REGION}.querySelector('ul[aria-label="From your bills"] button').click()`)
        await sleep(500)
        const one = await detail()
        const bills = one.bills.map((t) => amounts(t.split('≈').at(-1))[0])
        s.near(sum(bills), amounts(one.line)[0], bills.length + 1, `${tag}, its first card: its bills add up to its estimate`)
        continue
      }
      const shown = (d.payees.length ? d.payees : d.waiting).map((t) => amounts(t)[0])
      s.near(sum(shown) + (d.more ? amounts(d.more)[0] : 0), row.amount, shown.length + 2, `${tag}: its payees add up to it`)
      s.check(shown.length >= 1 && shown.length <= 6 && shown.every((v, i) => !i || v <= shown[i - 1] + 0.5), `${tag}: its top payees, biggest first`)
      const big = d.biggest.map((t) => amounts(t).at(-1))
      s.check(big.length >= 1 && big.length <= 5 && big.every((v, i) => !i || v <= big[i - 1]), `${tag}: its biggest payments, biggest first`)
      const n = Number(d.line.match(/([\d,]+) payments?/)?.[1].replace(/,/g, ''))
      s.check(d.showAll === `Show all ${n}`, `${tag}: "Show all" says its ${n} payments`)
      if (period === year) counts.push({ name: row.name, n })
    }
  }

  // Other, on the ring: what's in it adds up to it
  await s.load()
  await tab(year)
  await sleep(800)
  const other = await s.evaluate(`(() => { const b = [...${BREAKDOWN}.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('Other')); b?.click(); return b ? b.innerText : null })()`)
  if (other) {
    await sleep(500)
    const d = await detail()
    s.near(sum(d.other.map((t) => amounts(t)[0])), amounts(d.line)[0], d.other.length + 1, `${year}, Other: its categories add up to it`)
    s.near(amounts(d.line)[0], amounts(other)[0], 1, `${year}, Other: the same as on the ring`)
  }

  // nothing tapped: the busiest month is Month by month's biggest, the biggest payment opens itself
  await s.load()
  await tab(year)
  await sleep(800)
  const tiles = await s.evaluate(`[...${BREAKDOWN}.querySelectorAll('div.grid > *')].map((t) => t.innerText.split('\\n').map((x) => x.trim()))`)
  const busiest = tiles.find((t) => t[0] === 'Busiest month')
  const months = s.section('Month by month') + `.querySelector('section')`
  await s.evaluate(`(() => { const p = ${months}; const b = (t) => [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === t); b('All')?.click(); b('Show table')?.click(); return true })()`)
  await sleep(600)
  const table = await s.evaluate(`(() => { const t = ${months}.querySelector('table'); return { head: [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()), together: [...[...t.querySelectorAll('tbody tr')].at(-1).querySelectorAll('td')].map((td) => td.textContent.trim()) } })()`)
  const values = table.together.slice(0, 12).map((v) => rupees(v.replace('≈ ', '')) ?? 0)
  const top = values.indexOf(Math.max(...values))
  s.check(!!busiest && busiest[1].startsWith(table.head[top + 1]), `${year}: the busiest month is Month by month's biggest (${busiest?.[1]}, ${table.head[top + 1]})`)
  s.near(amounts(busiest?.[2])[0], values[top], 1, `${year}: and its figure`)
  const biggest = tiles.find((t) => t[0] === 'Biggest payment')
  await s.evaluate(`[...${BREAKDOWN}.querySelectorAll('div.grid > button')].find((b) => b.innerText.startsWith('Biggest payment')).click()`)
  await sleep(1500)
  const opened = await s.evaluate(`[...document.querySelectorAll('#transactions tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' '))`)
  s.check(opened.length === 1 && amounts(opened[0]).includes(amounts(biggest[1])[0]), `${year}: the biggest payment opens itself in Your transactions (${biggest[1]})`)

  // "Show all": exactly the category's payments (its refunds beside them)
  const pick = counts.filter((c) => c.n >= 2 && c.n <= 60).sort((a, b) => a.n - b.n)[0]
  if (pick) {
    await s.load()
    await tab(year)
    await sleep(800)
    await tap(pick.name)
    await sleep(500)
    await s.evaluate(`[...${REGION}.querySelectorAll('button')].find((b) => /^Show all/.test(b.innerText.trim())).click()`)
    await sleep(1500)
    const list = await s.evaluate(`(() => { const rows = [...document.querySelectorAll('#transactions tbody tr')]
      return { chip: document.querySelector('#transactions')?.innerText.includes(${JSON.stringify(`From ${pick.name} in ${year}`)}), payments: rows.filter((tr) => ![...tr.querySelectorAll('span')].some((x) => x.textContent.trim() === 'Refund')).length } })()`)
    s.check(list.chip && list.payments === pick.n, `${year}, ${pick.name}: "Show all ${pick.n}" opens its ${pick.n} payments in Your transactions (${list.payments})`)
  }

  // readable and reachable, on a desktop and a phone, with a shop waiting for its answer open where there is one
  for (const [tag, w, h, scale, mobile] of [['a desktop', 1440, 900, 1, false], ['a phone', 390, 844, 2, true]]) {
    await s.size(w, h, scale, mobile)
    await s.load()
    await tab(year)
    await sleep(800)
    const names = (await rows()).map((r) => r.name)
    const name = names.includes('Uncategorized') ? 'Uncategorized' : names.find((n) => n !== 'Card purchases')
    await tap(name)
    await sleep(700)
    const where = await s.evaluate(`({ inBars: ${BARS}.contains(${REGION}), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth })`)
    s.check(where.inBars === mobile && !where.sideways, `${tag}: ${name}'s detail opens ${mobile ? 'under its row' : 'under the ring'}, nothing sideways`)
    const c = await s.evaluate(CONTRAST)
    const t = await s.evaluate(TARGETS)
    s.check(!c.low.length && !t.small.length, `${tag}: with ${name} open, every text reads and every control reaches ${JSON.stringify([...c.low, ...t.small].slice(0, 3))}`)
  }
  await s.size(1440, 900)
}
