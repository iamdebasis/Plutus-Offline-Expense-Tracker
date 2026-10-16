// Plutus used as a person would, start to finish: start over, add the files with the picker, pick one again, answer a
// payee waiting in Uncategorized from Total spend, answer the review list, change two payments and undo it, tell Ask
// Plutus where you were (kept only by its button, undone, removed in Places and put back, forgotten; a place with its
// state, shown with it and changed in Places), confirm a held
// statement, delete a file, ask with no local AI, open the Local AI panel; the ledger checked after every change.
// It starts over, so it runs only when the demo was started for these checks (`make check-ui` sets
// PLUTUS_CHECKS_MAY_START_OVER, and sends Start over to .demo/trash).
import { copyFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sleep } from './browser.mjs'
import ledger from './ledger.mjs'

export default async function walkthrough(s) {
  console.log('\nthe walkthrough')
  if (process.env.PLUTUS_CHECKS_MAY_START_OVER !== '1') {
    console.log('  (skipped: it starts over, so it runs only under `make check-ui`)')
    return
  }
  const status = () => fetch(`${s.base}/api/status`).then((r) => r.json())
  const before = await status()
  const folder = join(dirname(before.dataDir), 'files')
  const files = readdirSync(folder).filter((f) => !f.startsWith('.')).map((f) => join(folder, f))
  const click = (sel, text) => s.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim().startsWith(${JSON.stringify(text)})); b?.click(); return !!b })()`)
  const typeInto = (sel, text) => s.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const pick = (selectExpr, value) => s.evaluate(`(() => { const sel = ${selectExpr}; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return sel.value })()`)
  const settled = () => s.until(`fetch('/api/uploads').then((r) => r.json()).then((u) => u.every((x) => !['queued', 'running'].includes(x.importStatus?.state)))`, 'every file read', 240)
  const addWithPicker = async (paths) => {
    const { root } = await s.send('DOM.getDocument', { depth: -1 })
    const { nodeId } = await s.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][multiple]' })
    await s.send('DOM.setFileInputFiles', { nodeId, files: paths })
    await s.until(`[...document.querySelectorAll('button')].some((b) => /^(Process|Read|Add) \\d/.test(b.textContent.trim()))`, 'the sheet of files picked', 30)
    await s.evaluate(`[...document.querySelectorAll('button')].find((b) => /^(Process|Read|Add) \\d/.test(b.textContent.trim())).click()`)
    // while they're read: the pill's stopwatch, from the server's own times, ticking; a screen reader can ask it
    const clockNow = () => s.evaluate(`(() => { const t = document.querySelector('[role=timer]'); return t && { text: t.textContent.trim(), label: t.getAttribute('aria-label') } })()`)
    const secs = (c) => c.split(':').map(Number).reduce((a, n) => a * 60 + n, 0)
    let seen = null
    for (let i = 0; i < 60 && !seen; i++) {
      seen = await clockNow()
      if (!seen) await sleep(250)
    }
    s.check(!!seen && /^\d+:\d\d(:\d\d)?$/.test(seen.text) && /so far$/.test(seen.label ?? ''), `a stopwatch shows while the files are read (${seen?.text}, "${seen?.label}")`)
    await sleep(2100)
    const later = await clockNow()
    if (later) s.check(secs(later.text) > secs(seen?.text ?? '0:00'), `and it ticks (${seen?.text} then ${later.text})`)
    else console.log('  · these files were read in under two seconds: too quick to see the stopwatch tick')
    const lastSeen = later ?? seen
    await settled()
    await sleep(1500)
    const done = await s.evaluate(`[...document.querySelectorAll('button[aria-haspopup=dialog] [role=status]')].map((e) => e.textContent.trim()).find((x) => / read/.test(x)) ?? null`)
    const tookSecs = (x) => { const m = /read in (under a second|(?:(\d+)h)? ?(?:(\d+)m)? ?(?:(\d+)s)?)/.exec(x ?? ''); return !m ? null : m[1] === 'under a second' ? 0 : (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + +(m[4] ?? 0) }
    s.check(tookSecs(done) !== null && tookSecs(done) + 1 >= secs(lastSeen?.text ?? '0:00') && !(await clockNow()),
      `when every file is read, the pill says how long it took, and the stopwatch is gone ("${done}")`)
    await s.evaluate(`[...document.querySelectorAll('button[aria-haspopup=dialog]')].find((b) => / read/.test(b.textContent)).click()`)
    await sleep(500)
    s.check(await s.evaluate(`[...document.querySelectorAll('[role=dialog][aria-label="Files being read"] li')].some((li) => /read in /.test(li.innerText))`),
      'and each file says how long its own reading took')
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(300)
    await click('button', 'Done')
    await sleep(500)
  }
  await s.size(1440, 900)
  await s.motion()
  await s.load()

  // start over, with the typed confirmation. Nothing of yours stays in the browser after it: answers about you are never
  // cached, what the page kept (here, a card's id among the ticked chart lines) goes the moment the server confirms, and
  // Plutus open in another tab loads again, empty, while this tab keeps its dialog
  s.check(await s.evaluate(`Promise.all(['/api/transactions', '/api/payees', '/api/instruments'].map((p) => fetch(p).then((r) => r.headers.get('cache-control'))))
    .then((all) => all.every((c) => c === 'no-store'))`), 'your payments, payees and cards are sent never to be cached')
  await s.evaluate(`localStorage.setItem('plutus.cardTrends.ticked', JSON.stringify(['card-fake-bank-1111'])); localStorage.setItem('other.app', 'theirs'); true`)
  const other = await s.tab(s.base)
  const otherUntil = async (expression, what) => {
    for (let i = 0; !(await other.evaluate(expression)); i++) {
      if (i > 120) return s.check(false, `never: ${what}`)
      await sleep(250)
    }
    return true
  }
  await otherUntil(`document.querySelectorAll('h2').length > 4`, 'the dashboard in another tab')
  await other.evaluate(`window.plutusOpenBefore = true`)
  await s.evaluate(`(() => { const e = document.getElementById('your-vault'); scrollTo(0, e.getBoundingClientRect().top + scrollY + 3000); return true })()`)
  await sleep(400)
  s.check(await click('button', 'Remove all my data'), 'Remove all my data… is in Your vault')
  await sleep(1200)
  s.check(await s.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove everything')?.disabled === true`), 'it waits for you to type the confirmation')
  await typeInto('input[placeholder="start over"]', 'start over')
  await sleep(300)
  await click('button', 'Remove everything')
  await s.until(`fetch('/api/status').then((r) => r.json()).then((x) => x.transactions === 0 && x.uploads === 0)`, 'an empty Plutus', 30)
  await s.until(`document.body.innerText.includes('Plutus is empty again')`, 'its done dialog', 10)
  s.check(await s.evaluate(`!Object.keys(localStorage).some((k) => k.startsWith('plutus.')) && localStorage.getItem('other.app') === 'theirs'`),
    'what the page kept in the browser is gone the moment the server confirms (and nothing of anyone else)')
  s.check(await otherUntil(`!window.plutusOpenBefore && document.body.innerText.includes('See where every')`, 'the other tab, empty')
    && (await s.evaluate(`document.body.innerText.includes('Plutus is empty again')`)), 'Plutus open in another tab loads again, empty; this tab keeps its dialog')
  await other.close()
  await s.evaluate(`localStorage.removeItem('other.app'); true`)
  await s.send('Page.reload', { ignoreCache: true })
  await sleep(2000)
  s.check(await s.evaluate(`document.body.innerText.includes('See where every') && !document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]')`), 'empty again: the welcome page, and no Ask orb')

  // the files back, with the picker: the same ledger
  await addWithPicker(files)
  await s.load()
  const after = await status()
  s.check(after.transactions === before.transactions && after.cardPayments === before.cardPayments && after.cards === before.cards && after.uploads === files.length,
    `the files, added with the picker, make the same ledger: ${after.transactions} payments, ${after.cardPayments} bills, ${after.cards} cards`)
  await ledger(s, 'the ledger, after adding the files')

  // one of them again, renamed: known by its content before anything is sent, so nothing is counted twice
  const copy = join(dirname(before.dataDir), 'checks', 'a renamed copy.pdf')
  copyFileSync(files[0], copy)
  const { root } = await s.send('DOM.getDocument', { depth: -1 })
  const { nodeId } = await s.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file][multiple]' })
  await s.send('DOM.setFileInputFiles', { nodeId, files: [copy] })
  await s.until(`document.getElementById('sheet-title')?.nextElementSibling?.textContent.trim() === 'All of these were added before'`, 'the copy recognised', 30)
  s.check(await s.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Nothing new')?.disabled === true`), 'a renamed copy of a file already added is recognised by its content: "Nothing new", nothing to send')
  await s.evaluate(`document.querySelector('button[aria-label="Close"]').click()`)
  await sleep(800)
  const again = await status()
  s.check(again.transactions === after.transactions && again.uploads === after.uploads, 'and nothing reached the ledger')

  // a payee waiting in Uncategorized, answered from what Total spend shows for it: its payments leave Uncategorized
  await s.load()
  const BARS = s.panel('Total spend', 'Where it went')
  const uncategorized = () => s.evaluate(`(() => { const b = [...${BARS}.querySelectorAll(':scope > ul > li > button')].find((b) => b.querySelector('span.truncate')?.textContent.trim() === 'Uncategorized'); return b ? Number(b.querySelector('span.text-zinc-100').textContent.replace(/[^\\d.]/g, '')) : 0 })()`)
  const waiting = await uncategorized()
  if (waiting) {
    await s.evaluate(`[...${BARS}.querySelectorAll(':scope > ul > li > button')].find((b) => b.querySelector('span.truncate')?.textContent.trim() === 'Uncategorized').click()`)
    await sleep(600)
    const REGION = `[...document.querySelectorAll('[aria-label="What you tapped, in detail"]')].find((r) => r.getBoundingClientRect().width > 0)`
    const LI = `[...${REGION}.querySelectorAll('ul[aria-label="Waiting for a category"] > li')].find((li) => li.querySelector('select'))`
    const shop = await s.evaluate(`(() => { const li = ${LI}; if (!li) return null; const sel = li.querySelector('select')
      const to = [...sel.options].find((o) => !o.disabled && o.value && !/^(uncategorized|transfers|ignored|investments)/.test(o.value))
      return { name: li.querySelector('span').textContent.trim(), amount: Number(li.innerText.match(/₹([\\d,]+)/)[1].replace(/,/g, '')), to: to.value } })()`)
    if (s.check(!!shop, 'Total spend shows a payee waiting in Uncategorized, with its answer')) {
      await pick(`${LI}.querySelector('select')`, shop.to)
      await sleep(200)
      await s.evaluate(`[...${LI}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click()`)
      await sleep(2500)
      await s.load()
      const left = await uncategorized()
      s.check(Math.abs(waiting - shop.amount - left) <= 1, `${shop.name}, answered there: its ${shop.amount} leaves Uncategorized (${waiting} → ${left})`)
      await ledger(s, 'the ledger, after answering it')
    }
  }

  // the review list: one answer files every payment to that payee
  await s.load()
  const review = await s.evaluate(`(() => { const rows = [...document.querySelectorAll('#review li')]; const row = rows.at(-1); if (!row) return null
    const sel = row.querySelector('select'); return { count: Number(document.querySelector('#review h3 span')?.textContent ?? 0), name: row.querySelector('p, span')?.textContent.trim(), current: sel.value,
      other: [...sel.options].find((o) => !o.disabled && o.value && o.value !== sel.value && !o.value.startsWith('transfers') && !o.value.startsWith('ignored'))?.value } })()`)
  if (review) {
    await pick(`[...document.querySelectorAll('#review li')].at(-1).querySelector('select')`, review.other)
    await sleep(300)
    await s.evaluate(`[...[...document.querySelectorAll('#review li')].at(-1).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(2000)
    const now = await s.evaluate(`Number(document.querySelector('#review h3 span')?.textContent ?? 0)`)
    s.check(now === review.count - 1, `the review list: one answer settles a payee (${review.count} → ${now})`)
  }

  // two ticked payments changed together, then put back
  await s.evaluate(`(() => { const e = document.querySelector('#transactions'); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80); return true })()`)
  await sleep(500)
  const was = await s.evaluate(`[...document.querySelectorAll('#transactions tbody tr')].slice(0, 2).map((tr) => tr.querySelector('select').value)`)
  await s.evaluate(`[...document.querySelectorAll('#transactions tbody input[type=checkbox]')].slice(0, 2).forEach((b) => b.click())`)
  await sleep(300)
  await pick(`document.querySelector('[role=toolbar] select')`, 'shopping.electronics')
  await sleep(200)
  await s.evaluate(`[...document.querySelectorAll('[role=toolbar] button')].find((b) => b.textContent.trim().startsWith('Change')).click()`)
  await sleep(1500)
  const changed = await s.evaluate(`[...document.querySelectorAll('#transactions tbody tr')].slice(0, 2).map((tr) => tr.querySelector('select').value)`)
  s.check(changed.every((v) => v === 'shopping.electronics'), 'two ticked payments change together')
  await s.evaluate(`[...document.querySelectorAll('[role=toolbar] button')].find((b) => b.textContent.trim() === 'Undo').click()`)
  await sleep(1500)
  s.check(JSON.stringify(await s.evaluate(`[...document.querySelectorAll('#transactions tbody tr')].slice(0, 2).map((tr) => tr.querySelector('select').value)`)) === JSON.stringify(was), 'and Undo puts them back exactly')

  // where you were: told in Ask Plutus and kept only by its button; undone; removed in Places and put back exactly;
  // forgotten in Ask Plutus. None of it touches the ledger.
  {
    const ASK = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
    const placesNow = () => fetch(`${s.base}/api/places`).then((r) => r.json())
    const ledgerNow = () => fetch(`${s.base}/api/transactions`).then((r) => r.text())
    const ledgerBefore = await ledgerNow()
    const say = async (text) => {
      await s.evaluate(`(() => { const i = ${ASK}.querySelector('input[aria-label="Your question"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
      await sleep(100)
      await s.evaluate(`${ASK}.querySelector('button[aria-label="Ask"]').click()`)
      await sleep(1200)
      return s.evaluate(`[...${ASK}.querySelectorAll('[role=log] > *')].at(-1).innerText.replace(/\\s+/g, ' ')`)
    }
    const press = async (label) => {
      const ok = await s.evaluate(`(() => { const b = [...${ASK}.querySelectorAll('button')].reverse().find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)})); b?.click(); return !!b })()`)
      await sleep(1500)
      return ok
    }
    await s.load()
    await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').click()`)
    await s.until(`!!${ASK}?.querySelector('input')`, 'the Ask panel')
    const card = await say('I was in Goa from 19th Sep 2026 to 25th Sep 2026')
    s.check(/Mark as Goa/.test(card) && /7 days/.test(card) && !(await placesNow()).length, 'telling Ask Plutus where you were shows it first: nothing kept until its button')
    s.check(/press the button/.test(await say('yes')) && !(await placesNow()).length, 'typing “yes” keeps nothing: only the button does')
    await s.evaluate(`[...${ASK}.querySelectorAll('[role=group]')].at(-1).scrollIntoView()`)
    s.check(await press('Mark as Goa'), 'its button')
    const kept = await placesNow()
    s.check(kept.length === 1 && kept[0].place === 'Goa' && kept[0].region === 'GA' && kept[0].start === '2026-09-19' && kept[0].end === '2026-09-25', 'the button keeps Goa, a state itself, 19 to 25 Sep 2026')
    await press('Undo')
    s.check(!(await placesNow()).length, 'Undo: nothing kept')
    await say('I was in Goa from 19th Sep 2026 to 25th Sep 2026')
    await press('Mark as Goa')
    const [goa] = await placesNow()
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await s.load()
    const location = await s.evaluate(`[...document.querySelectorAll('#transactions tbody tr')].filter((tr) => tr.innerText.includes('Goa')).length`)
    s.check(!!goa && location > 0, `Goa is beside its days' payments in Your transactions (${location})`)
    await s.evaluate(`(() => { const e = document.getElementById('places'); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80); return true })()`)
    await sleep(400)
    await s.evaluate(`document.querySelector('#places [aria-label^="Remove Goa"]').click()`)
    await sleep(300)
    await s.evaluate(`[...document.querySelectorAll('#places button')].find((b) => b.textContent.trim() === 'Remove').click()`)
    await sleep(1500)
    s.check(!(await placesNow()).length, 'removed in Places')
    await s.evaluate(`[...document.querySelectorAll('#places button')].find((b) => b.textContent.includes('Undo')).click()`)
    await sleep(1500)
    const back = await placesNow()
    s.check(back.length === 1 && back[0].id === goa.id && back[0].addedAt === goa.addedAt, 'Undo in Places puts it back exactly: its own id, and when you told it')
    await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').click()`)
    await s.until(`!!${ASK}?.querySelector('input')`, 'the Ask panel')
    s.check(/Forget Goa\?/.test(await say('forget goa')) && (await placesNow()).length === 1, 'forgetting is shown first too')
    await press('Forget it')
    s.check(!(await placesNow()).length, 'forgotten with its button')

    // a place told with its state: kept with it, shown "Place, ST" (its name on hover), found by the state's name; the
    // state changed in Places; then removed
    const stated = await say('I was in Fakepur, WB from 19th Sep 2026 to 25th Sep 2026')
    s.check(/Mark as Fakepur, WB/.test(stated) && /West Bengal/.test(stated) && !(await placesNow()).length, 'a place told with its state shows it, with the state’s name')
    await s.evaluate(`[...${ASK}.querySelectorAll('[role=group]')].at(-1).scrollIntoView()`)
    await press('Mark as Fakepur, WB')
    const [fakepur] = await placesNow()
    s.check(fakepur?.place === 'Fakepur' && fakepur.region === 'WB', 'kept with its state, as its code')
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await s.load()
    const LIST = `document.getElementById('transactions')`
    const besides = await s.evaluate(`[...${LIST}.querySelectorAll('tbody tr')].filter((tr) => tr.innerText.includes('Fakepur, WB')).length`)
    await s.evaluate(`(() => { const i = ${LIST}.querySelector('input[placeholder^="Search"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'west bengal'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(500)
    const found = await s.evaluate(`[...${LIST}.querySelectorAll('tbody tr')].filter((tr) => tr.children.length > 3).map((tr) => tr.innerText.includes('Fakepur, WB'))`)
    s.check(besides > 0 && found.length > 0 && found.every(Boolean), `Fakepur, WB beside its days' payments (${besides}), and found by its state's name (${found.length})`)
    await s.load()
    await s.evaluate(`(() => { const e = document.getElementById('places'); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80); return true })()`)
    await sleep(400)
    const title = await s.evaluate(`document.querySelector('#places article h3 span[title]')?.getAttribute('title')`)
    s.check(title === 'Fakepur, West Bengal', `its card names the state on hover (${title})`)
    await s.evaluate(`document.querySelector('#places [aria-label^="Edit Fakepur, WB"]').click()`)
    await sleep(300)
    await s.evaluate(`(() => { const sel = document.querySelector('#places form select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'KA'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true })()`)
    await sleep(200)
    await s.evaluate(`[...document.querySelectorAll('#places form button')].find((b) => b.textContent.trim() === 'Save').click()`)
    await sleep(1500)
    const [moved] = await placesNow()
    s.check(moved?.id === fakepur.id && moved.region === 'KA' && moved.place === 'Fakepur', 'its state changed in Places')
    await s.evaluate(`document.querySelector('#places [aria-label^="Remove Fakepur, KA"]').click()`)
    await sleep(300)
    await s.evaluate(`[...document.querySelectorAll('#places button')].find((b) => b.textContent.trim() === 'Remove').click()`)
    await sleep(1500)
    s.check(!(await placesNow()).length, 'and removed')
    s.check((await ledgerNow()) === ledgerBefore, 'none of it touched the ledger: every payment exactly as it was')
  }

  // a held statement, checked and counted
  const heldBefore = await s.evaluate(`fetch('/api/card-statements').then((r) => r.json()).then((x) => x.filter((st) => st.status === 'on_hold').map((st) => st.held.length))`)
  if (heldBefore.length) {
    await s.evaluate(`(() => { const e = document.getElementById('your-vault'); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80); return true })()`)
    await sleep(500)
    await click('button', "They're right: count them")
    await sleep(300)
    await click('button', 'Yes, count them')
    await sleep(2500)
    await settled()
    const counted = await status()
    s.check(counted.transactions === again.transactions + heldBefore[0], `a held statement, confirmed: its ${heldBefore[0]} rows counted (${again.transactions} → ${counted.transactions})`)
    await ledger(s, 'the ledger, after confirming it')
  }

  // a file deleted: it and every payment read only from it go
  await s.load()
  const name = await s.evaluate(`fetch('/api/uploads').then((r) => r.json()).then((u) => u.find((x) => /CRED/i.test(x.originalName))?.originalName)`)
  if (name) {
    await s.evaluate(`(() => { const e = document.getElementById('your-vault'); scrollTo(0, e.getBoundingClientRect().top + scrollY - 80); return true })()`)
    await sleep(400)
    await s.evaluate(`document.querySelector('[aria-label=${JSON.stringify(`Delete ${name}`)}]').click()`)
    await sleep(300)
    await s.evaluate(`document.querySelector('[aria-label=${JSON.stringify(`Confirm delete ${name}`)}]').click()`)
    await sleep(2500)
    await settled()
    const gone = await s.evaluate(`fetch('/api/uploads').then((r) => r.json()).then((u) => !u.some((x) => x.originalName === ${JSON.stringify(name)}))`)
    s.check(gone, `${name} deleted`)
    await ledger(s, 'the ledger, after deleting it')
  }

  // Ask Plutus with no local AI, and the Local AI panel
  await s.load()
  const PANEL = `document.querySelector('[role=dialog][aria-label="Ask Plutus"]')`
  await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').click()`)
  await s.until(`!!${PANEL}?.querySelector('input')`, 'the Ask panel')
  await typeInto('[role=dialog][aria-label="Ask Plutus"] input[aria-label="Your question"]', 'hmm, what about that thing from before?')
  await sleep(100)
  await s.evaluate(`${PANEL}.querySelector('button[aria-label="Ask"]').click()`)
  await s.until(`!${PANEL}.innerText.includes('Reading your question') && !${PANEL}.innerText.includes('is reading your question')`, 'an answer', 60)
  await sleep(500)
  const odd = await s.evaluate(`[...${PANEL}.querySelectorAll('[role=log] > *')].at(-1).innerText.replace(/\\s+/g, ' ')`)
  s.check(odd.length > 20 && !/error|undefined|NaN/i.test(odd), 'a question the rules can\'t read, with no local AI, gets a calm answer')

  // closing it with a click outside: it slides away and what was clicked still works, the focus left there; a click
  // inside, a drag from inside to past its edge, or a click in a window it opened (the Local AI panel) keeps it open.
  // Real presses of the mouse, as a person's.
  const centre = (el) => s.evaluate(`(() => { const r = (${el}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })()`)
  const mouse = (type, p) => s.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 })
  const clickAt = async (p) => {
    await mouse('mousePressed', p)
    await mouse('mouseReleased', p)
    await sleep(900)
  }
  const askOpen = () => s.evaluate(`!!${PANEL}`)
  const inside = await centre(`${PANEL}.querySelector('[role=log] > p')`) // your question, as you asked it: no control there
  await clickAt(inside)
  s.check(await askOpen(), 'a click inside Ask Plutus keeps it open')
  await mouse('mousePressed', inside)
  await mouse('mouseMoved', { x: 200, y: inside.y })
  await mouse('mouseReleased', { x: 200, y: inside.y })
  await sleep(900)
  s.check(await askOpen(), 'so does selecting its text and dragging past its edge')
  await clickAt(await centre(`[...${PANEL}.querySelectorAll('header button')].find((b) => /local AI/.test(b.textContent))`))
  const aiOpen = () => s.evaluate(`!!document.querySelector('[role=dialog][aria-modal="true"]')`)
  const opened = await aiOpen()
  await clickAt({ x: 24, y: 24 }) // the Local AI panel's backdrop
  s.check(opened && !(await aiOpen()) && (await askOpen()), 'a click on a window it opened closes that window, not Ask Plutus')
  const TAB = `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === 'All years')`
  await clickAt(await centre(TAB))
  await s.until(`!${PANEL}`, 'Ask Plutus sliding away', 5)
  s.check(await s.evaluate(`${TAB}.getAttribute('aria-selected') === 'true' && document.activeElement === ${TAB}`),
    'a click outside slides it away, and what was clicked still works, the focus left there (All years)')
  s.check(await s.evaluate(`document.querySelector('button[aria-label="Ask Plutus"][aria-haspopup="dialog"]').getAttribute('aria-expanded') === 'false'`), 'the orb is back')
  await s.evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('AI')).click()`)
  await sleep(1500)
  s.check((await s.evaluate(`[...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join(' ')`)).length > 50, 'the Local AI panel opens and says what suits this Mac')
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
