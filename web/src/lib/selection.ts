import type { Transaction } from '../types'
import { isCardBill } from './ledger'

/** Payments ticked in the transactions list, by id. Ticking one flips it; Shift-ticking another ticks every payment
 *  between it and the one ticked last, in the order they're shown (what a list of checkboxes does everywhere). */
export function tick(selected: ReadonlySet<string>, id: string, shown: readonly string[], last: string | null, shift: boolean): Set<string> {
  const out = new Set(selected)
  const from = last === null ? -1 : shown.indexOf(last)
  const to = shown.indexOf(id)
  if (shift && from >= 0 && to >= 0) {
    const on = !selected.has(id) // the range takes the state the clicked box is going to
    for (const k of shown.slice(Math.min(from, to), Math.max(from, to) + 1)) {
      if (on) out.add(k)
      else out.delete(k)
    }
    return out
  }
  if (out.has(id)) out.delete(id)
  else out.add(id)
  return out
}

/** Only what's still shown stays ticked: a change of several never reaches a payment you can't see. Returns the same
 *  set when nothing went, so nothing redraws for it. */
export function keepShown(selected: ReadonlySet<string>, shown: readonly string[]): ReadonlySet<string> {
  const visible = new Set(shown)
  return [...selected].every((id) => visible.has(id)) ? selected : new Set([...selected].filter((id) => visible.has(id)))
}

/** What's ticked adds up to: payments out less money back, to check before changing them. A payment to your card is
 *  neither (`cardBills` says how many are ticked): it's counted, but not in the net. */
export function tickedTotal(txns: readonly Transaction[], selected: ReadonlySet<string>): { count: number; net: number; cardBills: number } {
  let count = 0
  let net = 0
  let cardBills = 0
  for (const t of txns) {
    if (!selected.has(t.id)) continue
    count += 1
    if (isCardBill(t)) cardBills += 1
    else net += t.direction === 'credit' ? -t.amount : t.amount
  }
  return { count, net: Math.round(net * 100) / 100, cardBills }
}
