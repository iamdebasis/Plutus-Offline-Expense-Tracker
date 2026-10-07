// The README's screenshots, taken from the demo's made-up data only: `make screenshots` starts the demo, runs this, stops.
//
// Drives a Chromium-based browser already on this Mac (Chrome, Brave, Edge or Chromium) through its debugging
// protocol: no packages, no downloads. It refuses to photograph anything but a server whose data folder is
// .demo/data, so your own dashboard can never end up in docs/screenshots/.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:8001'
const OUT = join(ROOT, 'docs', 'screenshots')
const PORT = 9339
const WIDTH = 1280
const ASK_HEIGHT = 1080 // Ask Plutus is photographed as on a screen (tall enough for both answers), not page-tall

const BROWSERS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)

// Each shot: a section of the dashboard, found by its heading.
const SHOTS = [
  { file: 'overview.png', heading: 'Total spend', from: 'page-top' },
  { file: 'month-by-month.png', heading: 'Month by month' },
  { file: 'credit-cards.png', heading: 'Credit cards' },
  { file: 'upi.png', heading: 'UPI spends' },
  { file: 'transactions.png', heading: 'Your transactions', most: 1400 }, // the first screenful of a long list
  { file: 'vault.png', heading: 'Your vault' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Where every section sits, and how tall the page is: a picture is taken only once this stops changing, and kept
// only if it didn't change while it was taken (a chart redrawn mid-capture moves everything below it).
const LAYOUT = `JSON.stringify([document.documentElement.scrollHeight, innerHeight, ...[...document.querySelectorAll('section')].map((s) => {
  const r = s.getBoundingClientRect()
  return [Math.round(r.top + scrollY), Math.round(r.height)]
})])`

async function main() {
  const status = await (await fetch(`${BASE}/api/status`)).json()
  if (!/[/\\]\.demo[/\\]data$/.test(status.dataDir)) {
    throw new Error(`${BASE} isn't the demo (its data is in ${status.dataDir}). Run \`make screenshots\`, which starts it.`)
  }
  const browser = BROWSERS.find((b) => existsSync(b))
  if (!browser) throw new Error('No Chromium-based browser found (Chrome, Brave, Edge or Chromium). Set CHROME to its path.')

  const profile = join(ROOT, '.demo', 'browser')
  rmSync(profile, { recursive: true, force: true })
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    // a throwaway profile, and none of the browser's own background traffic
    `--user-data-dir=${profile}`, '--disable-extensions', '--disable-component-update', '--disable-background-networking',
    '--disable-sync', '--metrics-recording-only', `--remote-debugging-port=${PORT}`, 'about:blank',
  ], { stdio: 'ignore' })

  try {
    let target
    for (let i = 0; i < 60 && !target; i++) {
      try {
        target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`, { method: 'PUT' })).json()
      } catch {
        await sleep(250)
      }
    }
    if (!target) throw new Error('The browser did not start')
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    let id = 0
    const pending = new Map()
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m)
        pending.delete(m.id)
      }
      if (m.method === 'Runtime.exceptionThrown') console.error('page error:', m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    }
    await new Promise((r) => (ws.onopen = r))
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const n = ++id
        pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
        ws.send(JSON.stringify({ id: n, method, params }))
      })
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

    await send('Runtime.enable')
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Page.reload', { ignoreCache: true })

    const headings = JSON.stringify(SHOTS.map((s) => s.heading))
    for (let i = 0; !(await evaluate(`${headings}.every((t) => [...document.querySelectorAll('h2')].some((h) => h.textContent.trim() === t))`)); i++) {
      if (i === 120) throw new Error(`The dashboard never showed all of ${headings}`)
      await sleep(250)
    }
    /** Waits for the page to hold still for a second, with the window as tall as the page so nothing scrolls. */
    const still = async () => {
      let last = null
      let since = Date.now()
      for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(200)) {
        const now = await evaluate(LAYOUT)
        const [page, view] = JSON.parse(now)
        if (page !== view) await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: page, deviceScaleFactor: 2, mobile: false })
        if (now !== last) [last, since] = [now, Date.now()]
        else if (Date.now() - since >= 1000) return now
      }
      throw new Error('The page kept moving')
    }

    // the Ask Plutus orb sits in the window's corner: kept out of the sections, photographed with the window page-tall
    await evaluate(`(() => { const s = document.createElement('style'); s.id = 'no-orb'; s.textContent = 'button[aria-label="Ask Plutus"] { visibility: hidden }'; document.head.append(s); return true })()`)

    mkdirSync(OUT, { recursive: true })
    for (const shot of SHOTS) {
      for (let attempt = 1; ; attempt++) {
        const before = await still()
        const box = await evaluate(`(() => {
          const h = [...document.querySelectorAll('h2')].find((el) => el.textContent.trim() === ${JSON.stringify(shot.heading)})
          const r = h.closest('section').getBoundingClientRect()
          const top = ${shot.from === 'page-top' ? '0' : 'r.top + scrollY - 24'}
          return { x: 0, y: top, width: ${WIDTH}, height: Math.min(${shot.most ?? 'Infinity'}, r.bottom + scrollY + 24 - top) }
        })()`)
        const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 } })
        if ((await evaluate(LAYOUT)) === before) {
          writeFileSync(join(OUT, shot.file), Buffer.from(data, 'base64'))
          console.log(`  docs/screenshots/${shot.file}`)
          break
        }
        if (attempt === 3) throw new Error(`${shot.file}: the page kept moving while it was photographed`)
      }
    }

    // Ask Plutus, as on a screen: the chat open over the dashboard (the orb steps aside while it's open), then the orb
    // itself, opened into its pill over the transactions
    const until = async (expression, what) => {
      for (let i = 0; !(await evaluate(expression)); i++) {
        if (i === 120) throw new Error(`Ask Plutus: never ${what}`)
        await sleep(250)
      }
    }
    const save = async (file, clip) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip && { clip: { ...clip, scale: 1 } }) })
      writeFileSync(join(OUT, file), Buffer.from(data, 'base64'))
      console.log(`  docs/screenshots/${file}`)
    }
    const PANEL = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
    const ask = async (question) => {
      await evaluate(`(() => { const i = ${PANEL}.querySelector('input[aria-label="Your question"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(question)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await evaluate(`${PANEL}.querySelector('button[aria-label="Ask"]').click()`)
      await until(`!${PANEL}.innerText.includes('Reading your question')`, `answered “${question}”`)
    }
    await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: ASK_HEIGHT, deviceScaleFactor: 2, mobile: false })
    await evaluate(`document.getElementById('no-orb').remove()`)
    await evaluate('window.scrollTo(0, 0)')
    const year = await evaluate(`document.querySelector('[role=tab][aria-selected=true]').textContent.trim()`)
    await evaluate(`document.querySelector('button[aria-label="Ask Plutus"]').click()`)
    await until(`!!${PANEL}`, 'opened')
    await ask(`How much on food delivery in ${year}?`)
    await ask('and by month?')
    await sleep(1200) // the conversation scrolls to its last answer
    await save('ask-plutus.png')
    await evaluate(`${PANEL}.querySelector('button[aria-label="Close"]').click()`)
    await until(`!${PANEL}`, 'closed')
    await evaluate(`(() => { document.activeElement?.blur(); document.getElementById('transactions').scrollIntoView({ block: 'start' }); return true })()`)
    await sleep(600)
    const orb = await evaluate(`(() => { const r = document.querySelector('button[aria-label="Ask Plutus"]').getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 } })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: orb.x, y: orb.y })
    await sleep(800)
    await save('ask-orb.png', await evaluate(`({ x: ${WIDTH} - 640, y: scrollY + innerHeight - 220, width: 640, height: 220 })`))
    ws.close()
  } finally {
    proc.kill()
    await sleep(500)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
