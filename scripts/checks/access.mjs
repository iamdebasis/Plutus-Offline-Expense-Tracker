// Readable and reachable: every text against what's behind it at WCAG's 4.5:1 (3:1 large; the faint grey is only for
// decoration), every control at least 24 by 24, the main ones 44px tall under a finger, and the Mac's Increase
// contrast stepping helper text and edges up. On the dashboard and in Ask Plutus.
import { sleep } from './browser.mjs'

export const CONTRAST = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true }); const memo = {}
  const rgba = (c) => { if (c in memo) return memo[c]; cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return (memo[c] = [d[0], d[1], d[2], d[3] / 255]) }
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]))
  const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
  const faint = rgba(getComputedStyle(document.documentElement).getPropertyValue('--color-faint').trim())
  // what's behind a text: its ancestors' fills, and a layer drawn behind it as a sibling (the chosen year's white pill)
  const behind = (el) => { let base = [7, 9, 13]; const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e)
    const box = el.getBoundingClientRect()
    for (const e of chain.reverse()) {
      const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) base = over(c, base)
      for (let sib = e.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (getComputedStyle(sib).position !== 'absolute') continue
        const sc = rgba(getComputedStyle(sib).backgroundColor), sr = sib.getBoundingClientRect()
        if (sc[3] > 0 && sr.left <= box.left + 1 && sr.right >= box.right - 1 && sr.top <= box.top + 1 && sr.bottom >= box.bottom - 1) base = over(sc, base)
      }
    } return base }
  const low = []; let n = 0
  for (const el of document.querySelectorAll('body *')) {
    if (!['SPAN','P','DIV','TD','TH','A','BUTTON','LABEL','DT','DD','LI','H2','H3','H4','STRONG','EM','FIGCAPTION','SMALL'].includes(el.tagName)) continue
    if (![...el.childNodes].some((x) => x.nodeType === 3 && x.textContent.trim())) continue
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden') continue
    let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity
    if (op < 0.99) continue // dimmed on purpose (ignored payments), or a button that shows on hover
    const fg = rgba(cs.color); if (fg[3] === 0) continue // gradient text
    if (fg[0] === faint[0] && fg[1] === faint[1] && fg[2] === faint[2]) continue
    n++
    const bg = behind(el), k = ratio(over(fg, bg), bg)
    const big = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && +cs.fontWeight >= 700)
    if (k < (big ? 3 : 4.5)) low.push(k.toFixed(2) + ' "' + el.textContent.trim().slice(0, 30) + '"')
  }
  return { n, low }
})()`
export const TARGETS = `(() => {
  const small = []; let n = 0
  for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], summary')) {
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue
    if (getComputedStyle(el).visibility === 'hidden' || el.closest('[inert]')) continue
    n++
    let w = r.width, h = r.height
    const label = el.closest('label'); if (label) { const l = label.getBoundingClientRect(); w = Math.max(w, l.width); h = Math.max(h, l.height) }
    for (const host of [el, label].filter(Boolean)) { const a = getComputedStyle(host, '::after'); if (a.content !== 'none' && a.position === 'absolute') { w = Math.max(w, parseFloat(a.width) || 0); h = Math.max(h, parseFloat(a.height) || 0) } }
    if ((w >= 23.5 && h >= 23.5) || (el.tagName === 'A' && getComputedStyle(el).display === 'inline')) continue // a link in a sentence is exempt
    small.push((el.getAttribute('aria-label') || el.textContent.trim() || el.type || el.tagName).replace(/\\s+/g, ' ').slice(0, 28) + ' ' + Math.round(w) + 'x' + Math.round(h))
  }
  return { n, small }
})()`

export default async function access(s) {
  console.log('\nreadable and reachable')
  const PANEL = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
  for (const [tag, w, h, scale, mobile] of [['a desktop', 1440, 900, 1, false], ['a wide screen', 1728, 1117, 1, false], ['a phone', 390, 844, 2, true]]) {
    await s.size(w, h, scale, mobile)
    await s.motion()
    await s.load()
    s.check((await s.evaluate(`matchMedia('(pointer: coarse)').matches`)) === mobile, `${tag}: a ${mobile ? 'finger' : 'mouse'}`)
    const c = await s.evaluate(CONTRAST)
    s.check(c.n > 300 && !c.low.length, `${tag}: all ${c.n} texts read at 4.5:1 or more ${JSON.stringify(c.low.slice(0, 3))}`)
    const t = await s.evaluate(TARGETS)
    s.check(t.n > 100 && !t.small.length, `${tag}: all ${t.n} controls at least 24 by 24 ${JSON.stringify(t.small.slice(0, 3))}`)
    if (mobile) {
      // the main controls take a 44px tap, tested where the eye sees nothing
      const misses = await s.evaluate(`(() => { const out = []
        const probe = (name, el) => { if (!el) return out.push(name + ': missing')
          const r = el.getBoundingClientRect(), x = r.left + r.width / 2
          for (const y of [r.top + r.height / 2 - 21, r.top + r.height / 2 + 21]) {
            if (y < 0 || y > innerHeight) continue
            const hit = document.elementFromPoint(x, y)
            if (!(hit && (hit === el || el.contains(hit) || (hit.tagName === 'LABEL' && hit.contains(el))))) out.push(name)
          } }
        scrollTo(0, 0)
        probe('Add', [...document.querySelectorAll('header button')].find((b) => b.textContent.includes('Add')))
        probe('AI', [...document.querySelectorAll('header button')].find((b) => b.textContent.includes('AI')))
        for (const tab of document.querySelectorAll('[role=tablist] [role=tab]')) probe('year ' + tab.textContent, tab)
        probe('switch', document.querySelector('[role=switch]'))
        return out })()`)
      s.check(!misses.length, `${tag}: the header's buttons, the years and the switch take a 44px tap ${JSON.stringify(misses)}`)
    }
    await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').click()`)
    await s.until(`!!${PANEL}?.querySelector('input')`, 'the Ask panel')
    await s.evaluate(`(() => { const i = ${PANEL}.querySelector('input[aria-label="Your question"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'top 5 payees on food this year'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(100)
    await s.evaluate(`${PANEL}.querySelector('button[aria-label="Ask"]').click()`)
    await sleep(2500)
    const ac = await s.evaluate(CONTRAST)
    const at = await s.evaluate(TARGETS)
    s.check(!ac.low.length && !at.small.length, `${tag}: Ask Plutus reads and reaches the same ${JSON.stringify([...ac.low, ...at.small].slice(0, 3))}`)
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
  }

  await s.size(1440, 900)
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
  await s.load()
  const more = await s.evaluate(`({ muted: getComputedStyle(document.querySelector('.text-muted')).color, card: getComputedStyle(document.querySelector('section.bg-card\\\\/90')).borderTopColor,
    row: getComputedStyle(document.querySelector('#transactions tbody tr')).borderBottomColor, picker: getComputedStyle(document.querySelector('#transactions tbody select')).boxShadow })`)
  s.check(more.muted === 'rgb(176, 176, 185)' && more.card.includes('0.4') && more.row.includes('0.25') && more.picker.includes('0.4'), 'Increase contrast: helper text, card edges, row lines and picker rings step up')
  s.check(!(await s.evaluate(CONTRAST)).low.length, 'Increase contrast: every text still reads')
  await s.motion()
}
