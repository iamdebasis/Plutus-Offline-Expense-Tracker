// The month-by-month table: a row a category (or a card), a column a month (a year across several), each row's
// Total its own figure (the same as Where it went's), the months adding up to it, Together under them; a year fits
// without scrolling from 1024px, and on a phone the names stay put while the months scroll.
import { rupees, sleep } from './browser.mjs'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec']

export default async function table(s) {
  console.log('\nthe month-by-month table')
  const categories = `${s.section('Month by month')}.querySelector('section')`
  const cards = s.panel('Credit cards', 'Month by month')
  const show = (panel) => s.evaluate(`(() => { const b = [...${panel}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show table'); b?.click(); return !!b })()`)
  const read = (panel) => s.evaluate(`(() => {
    const p = ${panel}, table = p.querySelector('table'), box = table.parentElement
    return { head: [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim()),
             rows: [...table.querySelectorAll('tbody tr')].map((tr) => [tr.querySelector('th').textContent.trim(), ...[...tr.querySelectorAll('td')].map((td) => td.textContent.trim())]),
             ticked: [...p.querySelectorAll('[role=checkbox][aria-checked=true]')].map((b) => b.querySelector('span:nth-child(2)').textContent.trim()),
             fits: box.scrollWidth <= box.clientWidth + 1, over: box.scrollWidth - box.clientWidth }
  })()`)
  const where = () => s.evaluate(`(() => { const out = {}; for (const b of ${s.panel('Total spend', 'Where it went')}.querySelectorAll(':scope > ul > li > button')) { const n = b.querySelector('span.truncate')?.textContent.trim(); const a = b.querySelector('span.text-zinc-100')?.textContent.trim(); if (n && a) out[n] = a } return out })()`)
  const tab = (label) => s.evaluate(`[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  const years = await s.evaluate(`[...document.querySelectorAll('[role=tab]')].map((b) => b.textContent.trim()).filter((t) => /^\\d{4}$/.test(t))`)
  const year = years.at(-1)
  await s.motion()

  for (const [tag, w, h, scale, phone] of [['1440px', 1440, 900, 1, false], ['1280px', 1280, 800, 1, false], ['1024px', 1024, 768, 1, false], ['1200px', 1200, 800, 1, false], ['a phone', 390, 844, 2, true]]) {
    await s.size(w, h, scale, phone)
    await s.load()
    await tab(year)
    await sleep(800)
    await s.evaluate(`(() => { const e = ${s.section('Month by month')}; scrollTo(0, e.getBoundingClientRect().top + scrollY - 70); return true })()`)
    await show(categories)
    await sleep(400)
    const t = await read(categories)
    const shown = t.ticked.length
    s.check(t.head.join() === ['Category', ...MONTHS, 'Total'].join(), `${tag}: a year reads Category, Jan to Dec, Total`)
    s.check(t.rows.slice(0, shown).map((r) => r[0]).join() === t.ticked.join() && (shown < 2 || t.rows.at(-1)[0] === 'Together'), `${tag}: a row for each ticked category, in the chips' order, then Together`)
    const bars = await where()
    s.check(t.rows.slice(0, shown).every((r) => bars[r[0]] === r[13].replace('≈ ', '')), `${tag}: each row's Total is its figure in Where it went`)
    s.check(t.rows.every((r) => Math.abs(r.slice(1, 13).reduce((n, c) => n + (rupees(c) ?? 0), 0) - rupees(r[13])) <= 12), `${tag}: each row's months add up to its Total`)
    if (!phone) s.check(t.fits, `${tag}: nothing scrolls sideways (${t.over}px over)`)
    else {
      const pinned = await s.evaluate(`(() => { const box = ${categories}.querySelector('table').parentElement, th = box.querySelector('tbody th'), before = th.getBoundingClientRect().left
        box.scrollLeft = 300
        return new Promise((r) => setTimeout(() => r({ moved: Math.abs(th.getBoundingClientRect().left - before), faded: getComputedStyle(box).maskImage.includes('gradient'), gap: Math.round(th.getBoundingClientRect().left - box.getBoundingClientRect().left), edge: getComputedStyle(th, '::after').content !== 'none' }), 250)) })()`)
      s.check(pinned.moved < 1 && pinned.gap === 0 && pinned.faded && pinned.edge, `${tag}: the months scroll under the names, which stay put; the far edge fades, the names' edge softens`)
      await s.view('table-phone.png')
    }
    await tab('All years')
    await sleep(800)
    const a = await read(categories)
    s.check(a.head[0] === 'Category' && a.head.slice(1, -1).every((y) => /^\d{4}$/.test(y)) && a.head.at(-1) === 'Total', `${tag}: All years has a column a year (${a.head.slice(1, -1).join(', ')})`)
    const allBars = await where()
    s.check(a.rows.slice(0, a.ticked.length).every((r) => allBars[r[0]] === r.at(-1).replace('≈ ', '')), `${tag}: All years' Totals are Where it went's`)
    await tab(year)
    await sleep(800)
    await s.evaluate(`(() => { const e = ${cards}; scrollTo(0, e.getBoundingClientRect().top + scrollY - 70); return true })()`)
    await show(cards)
    await sleep(400)
    const c = await read(cards)
    s.check(c.head.join() === ['Card', ...MONTHS, 'Total'].join() && c.rows.length === c.ticked.length + (c.ticked.length > 1 ? 1 : 0), `${tag}: the cards' table, a row a card, then Together`)
    s.check(c.rows.every((r) => Math.abs(r.slice(1, 13).reduce((n, x) => n + (rupees(x) ?? 0), 0) - rupees(r[13])) <= 12), `${tag}: each card's months add up to its Total`)
    if (!phone) s.check(c.fits, `${tag}: the cards' table doesn't scroll sideways`)
  }
}
