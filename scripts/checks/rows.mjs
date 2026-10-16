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

  // a phone's list: the same words
  await s.size(390, 844, 2, true)
  await s.load()
  await type(toAccount.payee)
  const phone = await s.evaluate(`[...${LIST}.querySelectorAll('li')].map((li) => li.innerText.replace(/\\s+/g, ' ')).find((x) => x.includes('+₹') && x.includes(${JSON.stringify(toAccount.payee)})) ?? ''`)
  s.check(new RegExp(`refund from ${escape(toAccount.payee)}`, 'i').test(phone) && phone.includes(`Credited to account ••${digits(toAccount)}`), 'a phone: money in reads the same')
  await type('')
  await s.size(1440, 900)
}
