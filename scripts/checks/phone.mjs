// A phone gets the whole page, and so does a small window: nothing scrolls sideways; every payment's payee, how it was
// paid, category, amount, day and time on screen; a held statement's rows too; the bar that stays at the top short;
// the Ask Plutus orb out of the way while you scroll down where it would cover the page; ticking and changing a
// payment work on a phone.
import { sleep } from './browser.mjs'

const MONEY = String.raw`/^\+?₹[\d,]+(\.\d\d)?$/`
const offScreen = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width && (r.left < -0.5 || r.right > innerWidth + 0.5) }).map((e) => (e.textContent || e.getAttribute('aria-label') || e.tagName).trim().slice(0, 24))`
const amounts = (root) => `(() => { const re = ${MONEY}; let n = 0; const off = []
  for (const e of document.querySelectorAll(${JSON.stringify(root)} + ' *')) {
    if (e.children.length || !re.test(e.textContent.trim())) continue
    const r = e.getBoundingClientRect(); if (!r.width) continue
    n++; if (r.left < -0.5 || r.right > innerWidth + 0.5) off.push(e.textContent.trim())
  } return { n, off } })()`
const sideways = (root) => `[...document.querySelectorAll(${JSON.stringify(root)} + ' *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).length`
const ORB = `document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]')`

export default async function phone(s) {
  console.log('\nphones and small windows')
  await s.motion()
  const to = async (sel, extra = 0) => {
    await s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80 + ${extra}); return true })()`)
    await sleep(500)
  }
  const orbScale = () => s.evaluate(`(() => { const v = getComputedStyle(${ORB}).scale; return v === 'none' ? 1 : parseFloat(v) })()`)
  const swipe = (px) => s.evaluate(`(async () => { for (let i = 0; i < ${px > 0 ? 20 : 6}; i++) { scrollBy(0, ${px > 0 ? px / 20 : -30}); await new Promise((r) => setTimeout(r, 30)) } return true })()`)

  for (const [tag, w, h, scale, mobile] of [['a phone', 390, 844, 2, true], ['a small phone', 320, 640, 2, true], ['a tablet', 768, 1024, 2, true], ['a laptop', 1024, 768, 1, false], ['a desktop', 1440, 900, 1, false]]) {
    await s.size(w, h, scale, mobile)
    await s.load()
    s.check(await s.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), `${tag}: the page doesn't scroll sideways`)

    await s.evaluate(`scrollTo(0, 2500)`)
    await sleep(500)
    const bar = await s.evaluate(`(() => { const b = [...document.querySelectorAll('main *')].find((e) => getComputedStyle(e).position === 'sticky'), r = b.getBoundingClientRect()
      const tabs = b.querySelector('[role=tablist]'), on = tabs.querySelector('[aria-selected=true]').getBoundingClientRect(), box = tabs.getBoundingClientRect()
      return { h: Math.round(r.height), top: Math.round(r.top), fits: tabs.scrollWidth <= tabs.clientWidth, chosen: on.left >= box.left - 0.5 && on.right <= box.right + 0.5,
               switchIn: b.querySelector('[role=switch]').getBoundingClientRect().right <= innerWidth, coverage: b.innerText.includes('Card bills') } })()`)
    s.check(bar.top === 0 && bar.h <= 72 && bar.switchIn && !bar.coverage, `${tag}: the bar that stays is short (${bar.h}px), the years and the switch in it`)
    s.check(bar.fits || bar.chosen, `${tag}: the chosen year in view`)

    await to('#transactions', 120)
    const rows = await s.evaluate(`document.querySelectorAll('#transactions select').length`)
    const money = await s.evaluate(amounts('#transactions'))
    const off = await s.evaluate(offScreen('#transactions select, #transactions .chip-card, #transactions .chip-upi, #transactions input[type=checkbox]'))
    s.check(rows >= 60 && money.n >= rows && !money.off.length && !off.length, `${tag}: each payment's payee, chips, category and amount on screen (${rows})`)
    s.check((await s.evaluate(sideways('#transactions'))) === 0, `${tag}: nothing in the list scrolls sideways`)
    if (w >= 1024) s.check(await s.evaluate(`!!document.querySelector('#transactions table')`), `${tag}: the list is a table where it fits`)
    const days = await s.evaluate(`(() => { const re = /^\\d{1,2} \\w+( \\d{4})?(( ·)? ?\\d{1,2}:\\d\\d [ap]m)?$/; let n = 0, bad = 0
      for (const e of document.querySelectorAll('#transactions span, #transactions td')) {
        if ([...e.children].some((c) => c.tagName !== 'SPAN') || !re.test(e.innerText.trim().replace(/\\s+/g, ' '))) continue
        n++; if (e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > innerWidth + 0.5) bad++
      } return { n, bad } })()`)
    s.check(days.n >= 60 && !days.bad, `${tag}: every day and time whole`)

    if (await s.evaluate(`!!document.querySelector('#your-vault [aria-label^="Show where"]')`)) {
      await to('#your-vault', 200)
      const held = await s.evaluate(amounts('#your-vault'))
      s.check(held.n > 0 && !held.off.length && !(await s.evaluate(offScreen('#your-vault [aria-label^="Show where"]'))).length && (await s.evaluate(sideways('#your-vault'))) === 0,
        `${tag}: a held statement's rows on screen, nothing sideways`)
    }

    const covers = await s.evaluate(`(() => { const o = ${ORB}.getBoundingClientRect(), m = document.querySelector('main'); return o.left < m.getBoundingClientRect().right - parseFloat(getComputedStyle(m).paddingRight) })()`)
    await s.evaluate(`scrollTo(0, 1500)`)
    await sleep(1500)
    s.check((await orbScale()) === 1, `${tag}: the Ask orb at rest`)
    await swipe(1200)
    await sleep(350)
    const during = await orbScale()
    if (covers) {
      s.check(during < 0.6, `${tag}: it shrinks into the corner while you scroll down`)
      await sleep(1400)
      s.check((await orbScale()) === 1, `${tag}: and is back when you stop`)
    } else s.check(during === 1, `${tag}: where it covers nothing, it stays put`)
  }

  await s.size(390, 844, 2, true)
  await s.load()
  await to('#transactions', 120)
  await s.evaluate(`document.querySelector('#transactions input[type=checkbox][aria-label^="Tick the payment"]').click()`)
  await sleep(400)
  s.check(await s.evaluate(`document.querySelector('[role=toolbar][aria-label="Change the ticked payments"]')?.innerText.includes('1 payment ticked') ?? false`), 'a phone: ticking a payment opens the change bar')
  await s.evaluate(`[...document.querySelectorAll('[role=toolbar] button')].find((b) => b.textContent.trim() === 'Clear').click()`)
  await sleep(300)
}
