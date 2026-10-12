// The page checked in a real browser, on the demo's made-up year only: `make check-ui` starts the demo, runs this,
// stops. The ledger through the API; every figure that shows in more than one place, the same; the page's width and
// the charts' keys; the month tables; what Total spend shows for what you tap; phones and small windows; contrast and
// tap targets; then Plutus used start to finish (the walkthrough, which starts over). It refuses any server whose data
// folder isn't .demo/data, so it can never touch your own Plutus. What it saw (two screenshots) is in .demo/checks.
import { dirname, join } from 'node:path'
import access from './access.mjs'
import { open } from './browser.mjs'
import focus from './focus.mjs'
import layout from './layout.mjs'
import ledger from './ledger.mjs'
import money from './money.mjs'
import phone from './phone.mjs'
import table from './table.mjs'
import walkthrough from './walkthrough.mjs'

const BASE = process.env.DEMO_URL ?? 'http://127.0.0.1:8001'

async function main() {
  const status = await (await fetch(`${BASE}/api/status`)).json()
  if (!/[/\\]\.demo[/\\]data$/.test(status.dataDir)) {
    throw new Error(`${BASE} isn't the demo (its data is in ${status.dataDir}). Run \`make check-ui\`, which starts it.`)
  }
  const out = join(dirname(status.dataDir), 'checks')
  const s = await open(BASE, out)
  const started = Date.now()
  try {
    await ledger(s)
    for (const check of [money, layout, table, focus, phone, access, walkthrough]) {
      try {
        await check(s)
      } catch (err) {
        s.check(false, `${check.name}: stopped: ${err.message}`)
      }
    }
  } finally {
    await s.close()
  }
  s.check(!s.errors.length, `the page threw no errors ${JSON.stringify(s.errors.slice(0, 3))}`)
  const { passed, failed } = s.counts
  console.log(`\n${failed ? '✗' : '✓'} ${passed} passed, ${failed} failed, in ${Math.round((Date.now() - started) / 1000)}s (screenshots in ${out})`)
  return !failed
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (err) => {
    console.error(err.message)
    process.exit(1)
  },
)
