// The ledger, read through the API: every payment well formed, traced to a file you added, counted once; every bill
// placed and estimated exactly; every proven statement closing to the paisa; a held one's rows kept out.

const DAY = 86_400_000
const POSTED_WITHIN = 5 // days: a card's statement receives a payment on the day it's paid, or up to this many after

export default async function ledger(s, tag = 'the ledger') {
  console.log(`\n${tag}`)
  const get = async (path) => (await fetch(s.base + path)).json()
  const [txns, pays, stmts, uploads, cards, tree] = await Promise.all(
    ['/api/transactions', '/api/card-payments', '/api/card-statements', '/api/uploads', '/api/instruments', '/api/categories'].map(get),
  )
  const byId = new Map(txns.map((t) => [t.id, t]))
  const payIds = new Set(pays.map((p) => p.id))
  const fileIds = new Set(uploads.map((u) => u.id))
  const cardIds = new Set(cards.map((c) => c.id))
  const categories = new Set()
  const walk = (nodes) => nodes.forEach((c) => (categories.add(c.id), walk(c.children ?? [])))
  walk(tree)
  console.log(`  (${txns.length} payments, ${pays.length} card bills, ${stmts.length} statements, ${uploads.length} files)`)

  s.check(new Set(txns.map((t) => t.id)).size === txns.length && payIds.size === pays.length, 'every payment and every bill has its own id')
  s.check(txns.every((t) => Number.isFinite(t.amount) && t.amount > 0 && Math.round(t.amount * 100) / 100 === t.amount), 'every amount is positive, in rupees and paise')
  s.check(txns.every((t) => ['debit', 'credit'].includes(t.direction)), 'every payment is money out or money in')
  s.check(txns.every((t) => /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?([+-]\d\d:\d\d)$/.test(t.at) && new Date(t.at) <= new Date()), 'every payment has a date and time with its zone, none in the future')
  s.check(txns.every((t) => categories.has(t.category)), 'every category is one of the tree\'s')
  s.check(txns.every((t) => t.sources.length && t.sources.every((src) => fileIds.has(src.upload) && !src.upload.includes('~'))), 'every payment comes from a file in your vault, cited as the file')
  s.check(txns.every((t) => !t.card || cardIds.has(t.card)), 'every card a payment names is a known card')
  for (const key of ['utr', 'txnId']) {
    const seen = new Map()
    for (const t of txns) if (t.refs?.[key]) seen.set(`${t.refs[key]}|${t.amount}|${t.direction}`, (seen.get(`${t.refs[key]}|${t.amount}|${t.direction}`) ?? 0) + 1)
    s.check([...seen.values()].every((n) => n === 1), `no payment counted twice: no two share a ${key}, amount and direction`)
  }

  // one payment, one row: each side of a bill points to it, whenever a bill it could be is in your files
  s.check(txns.every((t) => !t.settles || payIds.has(t.settles)), 'every side of a bill points to a bill that exists')
  const toCards = txns.filter((t) => t.category === 'transfers.card_bill' && t.direction === 'debit' && t.channel !== 'card')
  const couldBe = (t) => pays.some((p) => Math.abs(p.amount - t.amount) < 1 && Math.abs(new Date(p.at) - new Date(t.at)) <= POSTED_WITHIN * DAY)
  const loose = toCards.filter((t) => !t.settles && couldBe(t))
  s.check(loose.length === 0, `every payment to a card is linked to its bill when its bill is in your files (${toCards.length - toCards.filter((t) => !t.settles).length} of ${toCards.length} linked; ${loose.length} left loose)`)
  const back = new Map()
  let refundsOk = true
  for (const t of txns) {
    if (!t.refundOf) continue
    const of = byId.get(t.refundOf)
    if (!of || t.direction !== 'credit') refundsOk = false
    else back.set(of.id, (back.get(of.id) ?? 0) + t.amount)
  }
  s.check(refundsOk, 'every refund points to a payment that exists, and is money in')
  s.check([...back].every(([id, v]) => v <= byId.get(id).amount + 0.005), 'no payment is refunded more than it cost')

  // bills: placed in a cycle; what a bill adds is what's left after what's counted one by one
  s.check(pays.every((p) => p.amount > 0 && cardIds.has(p.card) && p.paysFrom && p.paysTo && p.paysFrom <= p.paysTo), 'every bill has an amount, a known card, and the cycle it pays for')
  const statements = new Set(stmts.map((x) => x.id))
  const covered = pays.filter((p) => p.coveredBy)
  s.check(covered.every((p) => statements.has(p.coveredBy) && Math.abs(p.estimate) < 0.005), `a bill that pays a statement you added adds nothing (${covered.length})`)
  const rest = pays.filter((p) => !p.coveredBy)
  s.check(rest.every((p) => p.estimate >= 0 && Math.abs(p.counted + p.estimate - p.amount) <= 0.02), `every other bill = counted one by one + estimated, to the paisa (${rest.length})`)

  // statements: proven ones close; held ones wait
  for (const x of stmts) {
    const what = `${x.issuer} ••${x.last4} ${x.periodStart}–${x.periodEnd} (${x.status})`
    if (['proven', 'exact', 'confirmed', 'agreed'].includes(x.status) && x.previousBalance != null && x.totalDue != null) {
      s.check(Math.abs(x.previousBalance - x.credits + x.debits - x.totalDue) < 0.005, `${what}: previous balance − credits + debits = total due`)
    }
    if (x.status === 'on_hold') {
      const held = new Set(x.held.map((h) => h.id))
      s.check(held.size > 0 && ![...held].some((h) => byId.has(h)), `${what}: its ${held.size} rows wait for you, none counted`)
    }
  }
  return { txns: txns.length, pays: pays.length, files: uploads.length, cards: cards.length }
}
