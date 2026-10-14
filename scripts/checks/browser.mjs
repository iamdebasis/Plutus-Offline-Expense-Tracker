// A headless browser on the demo, for the page's checks (scripts/checks/run.mjs): the Chromium-based browser already
// on this Mac (Chrome, Brave, Edge or Chromium), driven through its debugging protocol. No packages, no downloads, and
// a throwaway profile with none of the browser's own background traffic.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BROWSERS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean)

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Opens the page at `base` and gives the checks what they need: `send` (the protocol), `evaluate` (an expression in
 *  the page, its value back), `until` (wait for one to be true), `view` (a screenshot into `out`), `load` (reload and
 *  wait for the dashboard), `size` (a window: desktop or a phone, a finger or a mouse), `check` (one pass or fail,
 *  counted), and the page's own errors. `close` ends it. */
export async function open(base, out, port = 9341) {
  const browser = BROWSERS.find((b) => existsSync(b))
  if (!browser) throw new Error('No Chromium-based browser found (Chrome, Brave, Edge or Chromium). Set CHROME to its path.')
  mkdirSync(out, { recursive: true })
  const profile = join(out, 'browser')
  rmSync(profile, { recursive: true, force: true })
  const proc = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--disable-extensions', '--disable-component-update', '--disable-background-networking',
    '--disable-sync', '--metrics-recording-only', `--remote-debugging-port=${port}`, 'about:blank',
  ], { stdio: 'ignore' })

  let target
  for (let i = 0; i < 60 && !target; i++) {
    try {
      target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(base)}`, { method: 'PUT' })).json()
    } catch {
      await sleep(250)
    }
  }
  if (!target) {
    proc.kill()
    throw new Error('The browser did not start')
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
  }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id
      pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
      ws.send(JSON.stringify({ id: n, method, params }))
    })
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value
  const until = async (expression, what, seconds = 30) => {
    for (let i = 0; !(await evaluate(expression)); i++) {
      if (i > seconds * 4) throw new Error(`never: ${what}`)
      await sleep(250)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')
  await send('DOM.enable')

  let failed = 0
  let passed = 0
  const s = {
    base,
    send,
    evaluate,
    until,
    errors,
    check(ok, what) {
      console.log(`  ${ok ? '✓' : '✗'} ${what}`)
      if (ok) passed++
      else failed++
      return ok
    },
    near(a, b, tol, what) {
      return s.check(a !== null && b !== null && a !== undefined && b !== undefined && Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`)
    },
    async view(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(out, file), Buffer.from(data, 'base64'))
    },
    /** A window: [width, height, pixel ratio, a phone], with a finger on a phone. */
    async size(width, height, scale = 1, mobile = false) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile })
      await send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false })
    },
    async motion(reduce = true) {
      await send('Emulation.setEmulatedMedia', { features: reduce ? [{ name: 'prefers-reduced-motion', value: 'reduce' }] : [] })
    },
    async load() {
      await send('Page.reload', { ignoreCache: true })
      await until(`document.querySelectorAll('h2').length > 4`, 'the dashboard', 40)
      await sleep(1500)
    },
    /** A dashboard section's element, by its heading, as an expression for `evaluate`. */
    section: (h2) => `[...document.querySelectorAll('section')].find((s) => s.querySelector(':scope > header h2')?.textContent.trim() === ${JSON.stringify(h2)})`,
    /** A panel in a section, by its title. */
    panel: (h2, h3) => `[...${s.section(h2)}.querySelectorAll('section')].find((p) => p.querySelector('h3')?.textContent.trim() === ${JSON.stringify(h3)})`,
    get counts() {
      return { passed, failed }
    },
    /** Another tab, at `url` (a person with Plutus open twice): just enough to look into it, and to close it. */
    async tab(url) {
      const other = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json()
      const socket = new WebSocket(other.webSocketDebuggerUrl)
      let n = 0
      const waiting = new Map()
      socket.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.id && waiting.has(m.id)) waiting.get(m.id)(m)
      }
      await new Promise((r) => (socket.onopen = r))
      const ask = (method, params = {}) => new Promise((resolve) => {
        const id = ++n
        waiting.set(id, (m) => resolve(m.result))
        socket.send(JSON.stringify({ id, method, params }))
      })
      return {
        evaluate: async (expression) => (await ask('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value,
        async close() {
          socket.close()
          await fetch(`http://127.0.0.1:${port}/json/close/${other.id}`)
        },
      }
    },
    async close() {
      ws.close()
      proc.kill()
      await sleep(500)
      rmSync(profile, { recursive: true, force: true })
    },
  }
  return s
}

/** Rupees as the page prints them ("₹1,23,456", "≈ ₹12,345", "+₹99.50") as a number; null for "—". */
export const rupees = (text) => (text == null || /^—$/.test(String(text).trim()) ? null : Number(String(text).replace(/[^\d.\-]/g, '')))
