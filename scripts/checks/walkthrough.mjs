// Plutus used as a person would, start to finish: start over, add the files with the picker, pick one again, answer the
// review list, change two payments and undo it, confirm a held statement, delete a file, ask with no local AI, open
// the Local AI panel; the ledger checked after every change. It starts over, so it runs only when the demo was started
// for these checks (`make check-ui` sets PLUTUS_CHECKS_MAY_START_OVER, and sends Start over to .demo/trash).
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
    await sleep(1500)
    await settled()
    await sleep(1000)
    await click('button', 'Done')
    await sleep(500)
  }
  await s.size(1440, 900)
  await s.motion()
  await s.load()

  // start over, with the typed confirmation
  await s.evaluate(`(() => { const e = document.getElementById('your-vault'); scrollTo(0, e.getBoundingClientRect().top + scrollY + 3000); return true })()`)
  await sleep(400)
  s.check(await click('button', 'Remove all my data'), 'Remove all my data… is in Your vault')
  await sleep(1200)
  s.check(await s.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove everything')?.disabled === true`), 'it waits for you to type the confirmation')
  await typeInto('input[placeholder="start over"]', 'start over')
  await sleep(300)
  await click('button', 'Remove everything')
  await s.until(`fetch('/api/status').then((r) => r.json()).then((x) => x.transactions === 0 && x.uploads === 0)`, 'an empty Plutus', 30)
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
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(500)
  await s.evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('AI')).click()`)
  await sleep(1500)
  s.check((await s.evaluate(`[...document.querySelectorAll('[role=dialog]')].map((d) => d.innerText).join(' ')`)).length > 50, 'the Local AI panel opens and says what suits this Mac')
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
}
