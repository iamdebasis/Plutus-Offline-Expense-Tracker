// The page grows with the window (about 10% each side, never narrower than 1104px of content, at most 1600), the header
// lines up with it, nothing scrolls sideways, and a month-by-month chart runs its card's full width with its names in
// a key under it, in the chips' order; pointing at a name brings its line forward.
import { sleep } from './browser.mjs'

const expected = (w) => Math.min(w - 48, Math.max(1104, 0.8 * w), 1600)
const BOX = `(() => {
  const m = document.querySelector('main'), r = m.getBoundingClientRect(), cs = getComputedStyle(m)
  const h = document.querySelector('body header'), hr = h.getBoundingClientRect(), hs = getComputedStyle(h)
  const left = r.left + parseFloat(cs.paddingLeft), right = r.right - parseFloat(cs.paddingRight)
  return { left, right, width: right - left, hLeft: hr.left + parseFloat(hs.paddingLeft), hRight: hr.right - parseFloat(hs.paddingRight),
           overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }
})()`
const CHART = (panel) => `(() => {
  const p = ${panel}, svg = p.querySelector('svg[role=img]'), s = svg.getBoundingClientRect()
  const plotRight = Math.max(...[...svg.querySelectorAll('line')].map((l) => +l.getAttribute('x2') || 0))
  return { svgW: Math.round(s.width), plotRight: Math.round(plotRight), height: Math.round(s.height),
           beside: [...svg.querySelectorAll('text')].filter((t) => +t.getAttribute('x') > plotRight + 1).map((t) => t.textContent),
           key: [...p.querySelectorAll('[aria-label="Key"] li')].map((li) => li.textContent.trim()),
           ticked: [...p.querySelectorAll('[role=checkbox][aria-checked=true]')].map((b) => b.querySelector('span:nth-child(2)').textContent.trim()) }
})()`

export default async function layout(s) {
  console.log('\nthe page\'s width, and the charts\' keys')
  await s.motion()
  for (const [w, h] of [[1280, 800], [1440, 900], [1728, 1117], [1920, 1080], [2560, 1440]]) {
    await s.size(w, h)
    await s.load()
    const b = await s.evaluate(BOX)
    s.check(Math.abs(b.width - expected(w)) <= 1.5, `${w}px window: the page is ${Math.round(b.width)} wide (${Math.round(expected(w))}), ${Math.round(b.left)} each side`)
    s.check(Math.abs(b.hLeft - b.left) <= 1 && Math.abs(b.hRight - b.right) <= 1 && b.overflow <= 0, `${w}px: the header lines up with it, nothing scrolls sideways`)
    for (const [name, panel] of [['categories', `${s.section('Month by month')}.querySelector('section')`], ['cards', s.panel('Credit cards', 'Month by month')]]) {
      await s.evaluate(`(() => { const p = ${panel}; scrollTo(0, p.getBoundingClientRect().top + scrollY - 90); return true })()`)
      await sleep(400)
      const c = await s.evaluate(CHART(panel))
      s.check(c.beside.length === 0 && c.svgW - c.plotRight <= 20, `${w}px, ${name}: the plot runs the full width, no names beside it`)
      s.check(c.key.length >= 2 && c.key.join() === c.ticked.join(), `${w}px, ${name}: the key under it lists the ticked lines in the chips' order`)
      if (name === 'categories') {
        if (w <= 1280) s.check(c.height === 326, `${w}px: the chart as tall as before (${c.height})`)
        if (w >= 1728) s.check(c.height >= 346, `${w}px: taller on a wider page (${c.height})`)
        const at = await s.evaluate(`(() => { const li = ${panel}.querySelectorAll('[aria-label="Key"] li')[1]; if (!li) return null; const r = li.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: li.dataset.line } })()`)
        if (at) {
          await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
          await sleep(500)
          const lines = await s.evaluate(`[...${panel}.querySelectorAll('svg g[data-line]')].map((g) => [g.dataset.line, +getComputedStyle(g).opacity])`)
          s.check(lines.some(([id, o]) => id === at.id && o > 0.9) && lines.filter(([id]) => id !== at.id).every(([, o]) => o < 0.5), `${w}px: pointing at a name brings its line forward`)
          await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 })
          await sleep(300)
        }
      }
    }
    if (w === 1728) await s.view('layout-1728.png')
  }
  await s.size(390, 844, 2, true)
  await s.load()
  const p = await s.evaluate(BOX)
  s.check(Math.abs(p.width - 358) <= 1 && p.overflow <= 0, `a phone's page as before (${Math.round(p.width)} wide), nothing sideways`)
  await s.evaluate(`(() => { const e = ${s.section('Month by month')}; scrollTo(0, e.getBoundingClientRect().top + scrollY - 110); return true })()`)
  await sleep(400)
  const pc = await s.evaluate(CHART(`${s.section('Month by month')}.querySelector('section')`))
  s.check(pc.key.join() === pc.ticked.join() && pc.beside.length === 0, 'a phone has the key under the chart too')
}
