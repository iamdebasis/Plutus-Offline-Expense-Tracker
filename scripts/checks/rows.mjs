// How a row of Your transactions reads. Money in reads as a bank's statement says it: its tag on top ("Refund",
// "Received"…), then "from" whom (a cashback, the file's own wording for it, as it is), and under "Paid with"'s chips
// "Credited to" the account or card it went to (its last digits, from the API); a payment out reads as before, its payee
// on top and the account it was paid from. On a table and on a phone's list.
import { sleep } from './browser.mjs'

export default async function rows(s) {
  console.log('\nhow a row reads: money in, and a payment out')
  const txns = await (await fetch(s.base + '/api/transactions')).json()
  const LIST = `document.getElementById('transactions')`
  const INPUT = `${LIST}.querySelector('input[aria-label^="Search payee"]')`
  const type = async (q) => {
    await s.evaluate(`(() => { const i = ${INPUT}; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await sleep(600)
  }
  const digits = (t) => (t.paidFrom ?? '').replace(/\D/g, '').slice(-4)
  const escape = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await s.size(1440, 900)
  await s.motion()
  await s.load()
  const year = await s.evaluate(`document.querySelector('[role=tab][aria-selected=true]')?.textContent.trim()`)
  const inYear = txns.filter((t) => !/^\d{4}$/.test(year) || t.at.startsWith(year))
  const money = (t) => t.direction === 'credit' && t.category !== 'transfers.card_bill' && t.payee !== 'Unknown' && digits(t).length === 4
  const toAccount = inYear.find((t) => money(t) && t.kind === 'refund' && !t.card && inYear.some((x) => x.payee === t.payee && x.direction === 'debit'))
  const toCard = inYear.find((t) => money(t) && t.kind === 'refund' && t.card)
  const cashback = inYear.find((t) => money(t) && t.category === 'income.cashback')
  if (!s.check(!!toAccount && !!toCard && !!cashback, `the demo has a refund to an account (${toAccount?.payee}), one to a card (${toCard?.payee}) and a cashback (${cashback?.payee})`)) return

  const read = (name) => s.evaluate(`(() => { const t = ${LIST}.querySelector('table'); if (!t) return []
    const head = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()), at = (k) => head.indexOf(k)
    const text = (cell) => cell.innerText.replace(/\\s+/g, ' ').trim()
    return [...t.querySelectorAll('tbody tr')].filter((tr) => tr.children.length === head.length && tr.children[at('Payee')].innerText.includes(${JSON.stringify(name)}))
      .map((tr) => ({ payee: text(tr.children[at('Payee')]), via: text(tr.children[at('Paid with')]), amount: text(tr.children[at('Amount')]) })) })()`)
  const credits = (rs) => rs.filter((r) => r.amount.startsWith('+'))

  await type(toAccount.payee)
  let rs = await read(toAccount.payee)
  const inn = credits(rs)[0]
  s.check(!!inn && new RegExp(`^refund from ${escape(toAccount.payee)}`, 'i').test(inn.payee), `money in: its tag on top, then "from ${toAccount.payee}" ("${inn?.payee}")`)
  s.check(!!inn && inn.via.includes(`Credited to account ••${digits(toAccount)}`), `and under "Paid with"'s chips, the account it was credited to ("${inn?.via}")`)
  const out = rs.find((r) => !r.amount.startsWith('+'))
  s.check(!!out && out.payee.startsWith(toAccount.payee) && !/\bfrom\b/.test(out.payee) && !out.via.includes('Credited'), `a payment out reads as before ("${out?.payee}" · "${out?.via}")`)

  await type(toCard.payee)
  rs = credits(await read(toCard.payee))
  s.check(rs.length > 0 && rs.every((r) => new RegExp(`Credited to .+••${digits(toCard)}`).test(r.via)), `money back to a card: credited to the card ("${rs[0]?.via}")`)

  await type(cashback.payee)
  rs = credits(await read(cashback.payee))
  s.check(rs.length > 0 && rs.every((r) => /^cashback /i.test(r.payee) && !/\bfrom\b/.test(r.payee) && r.via.includes('Credited to')),
    `a cashback: its tag on top, its name as the file words it, no "from" ("${rs[0]?.payee}")`)

  // every row the same height: money in is two lines like any payment, its tag on top and "from" whom under it, the
  // card's own wording beside the name rather than a line of its own; a Payee with nothing under the name, two lines all
  // the same. The whole year, every row shown.
  await type('')
  for (let i = 0; i < 50 && (await s.evaluate(`(() => { const b = [...${LIST}.querySelectorAll('button')].find((b) => /^Show more/.test(b.textContent.trim())); b?.click(); return !!b })()`)); i++) await sleep(300)
  const wording = (t) => t.payeeHandle ?? (t.note && t.note !== t.payee ? t.note : '')
  const worded = inYear.find((t) => t.direction === 'credit' && t.category !== 'transfers.card_bill' && !t.settles && t.payee !== 'Unknown' && wording(t))
  const sized = await s.evaluate(`(() => { const t = ${LIST}.querySelector('table'), n = t.querySelectorAll('thead th').length
    const at = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim()).indexOf('Payee')
    const rows = [...t.querySelectorAll('tbody tr')].filter((tr) => tr.children.length === n)
    const box = (tr) => tr.children[at].firstElementChild
    return { rows: rows.map((tr) => tr.getBoundingClientRect().height), payees: rows.map((tr) => box(tr).getBoundingClientRect().height),
      bare: rows.filter((tr) => tr.children[at].innerText.split('\\n').filter((x) => x.trim()).length === 1).length, shown: rows.length,
      // the tallest thing in any other column (Paid with, Category…): what it holds, not the cell
      others: Math.max(...rows.flatMap((tr) => [...tr.children].filter((_, i) => i !== at).map((td) => { const r = document.createRange(); r.selectNodeContents(td); return r.getBoundingClientRect().height }))) } })()`)
  const spread = (xs) => Math.max(...xs) - Math.min(...xs)
  s.check(sized.shown > 100 && spread(sized.rows) < 0.01,
    `every row of the table is the same height (${sized.shown} rows, ${Math.min(...sized.rows).toFixed(2)}–${Math.max(...sized.rows).toFixed(2)}px)`)
  s.check(spread(sized.payees) < 0.01 && sized.bare > 0,
    `every Payee is two lines tall, one with nothing under the name too (${sized.bare} of them; ${Math.min(...sized.payees).toFixed(2)}–${Math.max(...sized.payees).toFixed(2)}px)`)
  s.check(sized.others <= Math.min(...sized.payees) + 0.01,
    `and nothing else in a row is taller (Paid with's chips and line, the category: at most ${sized.others.toFixed(2)}px), so a row with less to show is as tall too`)
  if (s.check(!!worded, `the demo has money in with the card's own wording (${worded?.payee}: "${worded && wording(worded)}")`)) {
    await type(worded.payee)
    // where each part sits on the screen: the tag above, "from", the name and the wording side by side under it
    const row = await s.evaluate(`(() => { const t = ${LIST}.querySelector('table'), head = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      const tr = [...t.querySelectorAll('tbody tr')].find((tr) => tr.children.length === head.length && tr.children[head.indexOf('Amount')].innerText.trim().startsWith('+'))
      if (!tr) return null
      const cell = tr.children[head.indexOf('Payee')], leaf = (text) => [...cell.querySelectorAll('*')].find((e) => !e.children.length && e.textContent.trim() === text)
      const mid = (e) => { const r = e?.getBoundingClientRect(); return r ? r.top + r.height / 2 : NaN }
      const tag = [...cell.querySelectorAll('*')].find((e) => !e.children.length && /^(refund|received|transfer in)$/i.test(e.textContent.trim()))
      const [from, name, words] = [leaf('from'), leaf(${JSON.stringify(worded.payee)}), leaf(${JSON.stringify(wording(worded))})]
      return { height: tr.getBoundingClientRect().height, tag: tag?.textContent.trim(), above: tag && name ? tag.getBoundingClientRect().bottom <= name.getBoundingClientRect().top + 4 : false,
        oneLine: [from, words].every((e) => Math.abs(mid(e) - mid(name)) < 3), text: cell.innerText.replace(/\\s+/g, ' ').trim() } })()`)
    s.check(!!row && !!row.tag && row.above && row.oneLine, `its tag on top, then "from" whom and the card's wording on one line ("${row?.text}")`)
    s.check(!!row && Math.abs(row.height - sized.rows[0]) < 0.01, `and its row as tall as every other (${row?.height.toFixed(2)}px)`)
    // a Payee squeezed: the wording is cut, never the name, until the name alone can't fit (then the wording is gone)
    const squeezed = await s.evaluate(`(() => { const t = ${LIST}.querySelector('table'), head = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim())
      const tr = [...t.querySelectorAll('tbody tr')].find((tr) => tr.children.length === head.length && tr.children[head.indexOf('Amount')].innerText.trim().startsWith('+'))
      const box = tr.children[head.indexOf('Payee')].firstElementChild, leaf = (text) => [...box.querySelectorAll('*')].find((e) => !e.children.length && e.textContent.trim() === text)
      const [from, name, words] = [leaf('from'), leaf(${JSON.stringify(worded.payee)}), leaf(${JSON.stringify(wording(worded))})]
      // the name, to the fraction of a pixel: as wide as it is with room to spare, or narrower (cut)
      const natural = name.getBoundingClientRect().width, cut = (e) => e.scrollWidth > e.clientWidth
      const at = (width) => { box.style.width = width + 'px'; return { name: natural - name.getBoundingClientRect().width > 0.001, words: cut(words), gone: words.clientWidth === 0 } }
      const room = from.offsetWidth + name.scrollWidth + 12
      try { return { some: at(room + 30), none: at(from.offsetWidth + name.scrollWidth / 2) } } finally { box.style.width = '' } })()`)
    s.check(!squeezed.some.name && squeezed.some.words && squeezed.none.name && squeezed.none.gone,
      `squeezed, the wording is cut before the name ever is (${JSON.stringify(squeezed)})`)
  }

  // a phone's list: the same words
  await s.size(390, 844, 2, true)
  await s.load()
  await type(toAccount.payee)
  const phone = await s.evaluate(`[...${LIST}.querySelectorAll('li')].map((li) => li.innerText.replace(/\\s+/g, ' ')).find((x) => x.includes('+₹') && x.includes(${JSON.stringify(toAccount.payee)})) ?? ''`)
  s.check(new RegExp(`refund from ${escape(toAccount.payee)}`, 'i').test(phone) && phone.includes(`Credited to account ••${digits(toAccount)}`), 'a phone: money in reads the same')
  // and money in with the card's wording takes no more room than a payment out with it
  const twin = worded && inYear.find((t) => t.direction === 'debit' && t.payee === worded.payee && wording(t))
  if (twin) {
    await type(worded.payee)
    const [inH, outH] = await s.evaluate(`(() => { const lis = [...${LIST}.querySelectorAll('li')], h = (li) => li?.getBoundingClientRect().height
      return [h(lis.find((li) => li.innerText.includes('+₹') && li.innerText.includes(${JSON.stringify(wording(worded))}))),
        h(lis.find((li) => !li.innerText.includes('+₹') && li.innerText.includes(${JSON.stringify(wording(twin))})))] })()`)
    s.check(!!inH && !!outH && Math.abs(inH - outH) < 0.01, `a phone: money in with the card's wording, as tall as a payment out with it (${inH} and ${outH}px)`)
  }
  await type('')
  await s.size(1440, 900)
}
